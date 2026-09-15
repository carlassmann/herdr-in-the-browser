import type { ClientMessage, ServerMessage } from "../shared/protocol";

export type TransportState = "connecting" | "connected" | "disconnected";

interface TransportCallbacks {
  onMessage(message: ServerMessage): void;
  onState(state: TransportState): void;
  getSize?(): { cols: number; rows: number };
}

interface Transport {
  connect(): void;
  send(message: ClientMessage): void;
  close(): void;
}

const FAILURES_BEFORE_FALLBACK = 2;
// A proxy that buffers streams accepts the SSE request but never forwards a
// byte. The server always sends status and sync at once, so silence is failure.
const CONNECTION_TIMEOUT_MS = 5_000;
const SSE_IDLE_TIMEOUT_MS = 35_000;
type TransportKind = "websocket" | "sse" | "poll";

export class ReconnectingTransport implements Transport {
  private kind: TransportKind = preferredTransport();
  private connectionTimer?: number;
  private socket?: WebSocket;
  private events?: EventSource;
  private closed = false;
  private retry = 0;
  private retryTimer?: number;
  private websocketFailures = 0;
  private sseFailures = 0;
  private cursor = 0;
  private generation = 0;
  private pending: ClientMessage[] = [];
  private inFlight = 0;
  private sendTimer?: number;
  private lastSent = -Infinity;
  private inputStream = crypto.randomUUID();
  private inputSequence = 0;
  private abortController = new AbortController();

  constructor(
    private readonly sessionId: string,
    private readonly callbacks: TransportCallbacks,
  ) {}

  connect(): void {
    this.close();
    this.closed = false;
    this.retry = 0;
    this.abortController = new AbortController();
    if (this.kind === "poll") this.connectLongPoll();
    else if (this.kind === "sse") this.connectSse();
    else this.connectWebSocket();
  }

  send(message: ClientMessage): void {
    if (this.closed) return;
    const previous = this.pending.at(-1);
    if (
      message.type === "input" &&
      previous?.type === "input" &&
      previous.data.length + message.data.length <= 64 * 1024
    ) {
      previous.data += message.data;
    } else if (message.type === "resize" && previous?.type === "resize") {
      this.pending[this.pending.length - 1] = { ...message };
    } else {
      this.pending.push({ ...message });
    }
    this.flush();
  }

  private flush(): void {
    if (
      this.closed ||
      !this.pending.length ||
      this.inFlight >= 2 ||
      this.sendTimer !== undefined
    )
      return;
    if (
      this.kind === "websocket" &&
      this.socket?.readyState === WebSocket.OPEN
    ) {
      for (const queued of this.pending.splice(0))
        this.socket.send(JSON.stringify(queued));
      return;
    }
    const delay = 50 - (performance.now() - this.lastSent);
    if (delay > 0) {
      this.sendTimer = window.setTimeout(() => {
        this.sendTimer = undefined;
        this.dispatch();
      }, delay);
      return;
    }
    this.dispatch();
  }

  private dispatch(): void {
    if (this.closed || this.inFlight >= 2) return;
    const message = this.pending.shift();
    if (!message) return;
    const generation = this.generation;
    this.lastSent = performance.now();
    this.inFlight += 1;
    void (async () => {
      try {
        const endpoint = message.type === "input" ? "input" : "resize";
        const response = await fetch(this.sessionUrl(endpoint), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Terminal-Input-Stream": this.inputStream,
            "X-Terminal-Input-Sequence": String(this.inputSequence++),
          },
          body: JSON.stringify(message),
          signal: AbortSignal.any([
            this.abortController.signal,
            AbortSignal.timeout(10_000),
          ]),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
      } catch {
        if (!this.closed && generation === this.generation) {
          this.close();
          this.callbacks.onState("disconnected");
          this.scheduleReconnect(() => this.connect());
        }
      } finally {
        if (generation === this.generation) {
          this.inFlight -= 1;
          this.flush();
        }
      }
    })();
  }

  close(): void {
    this.closed = true;
    this.generation += 1;
    this.pending = [];
    this.inFlight = 0;
    this.inputStream = crypto.randomUUID();
    this.inputSequence = 0;
    this.lastSent = -Infinity;
    window.clearTimeout(this.sendTimer);
    this.sendTimer = undefined;
    this.abortController.abort();
    window.clearTimeout(this.retryTimer);
    window.clearTimeout(this.connectionTimer);
    this.socket?.close();
    this.events?.close();
    this.socket = undefined;
    this.events = undefined;
  }

  private connectWebSocket(): void {
    if (this.closed) return;
    this.kind = "websocket";
    this.callbacks.onState("connecting");
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(
      `${protocol}//${location.host}${this.sessionUrl("ws")}?${this.connectionQuery()}`,
    );
    this.socket = socket;
    let received = false;
    let failed = false;
    const isCurrent = () => !this.closed && socket === this.socket && !failed;
    const fail = (reason: string) => {
      if (!isCurrent()) return;
      failed = true;
      window.clearTimeout(this.connectionTimer);
      socket.close();
      this.callbacks.onState("disconnected");
      if (!received) this.websocketFailures += 1;
      if (this.websocketFailures >= FAILURES_BEFORE_FALLBACK) this.connectSse();
      else this.scheduleReconnect(() => this.connectWebSocket());
    };
    this.connectionTimer = window.setTimeout(
      () => fail("timeout"),
      CONNECTION_TIMEOUT_MS,
    );
    socket.addEventListener("message", (event) => {
      if (!isCurrent()) return;
      if (!received) {
        received = true;
        window.clearTimeout(this.connectionTimer);
        this.retry = 0;
        this.websocketFailures = 0;
        this.callbacks.onState("connected");
      }
      this.deliver(String(event.data));
    });
    socket.addEventListener("close", () => fail("closed"));
    socket.addEventListener("error", () => fail("error"));
  }

  private connectSse(): void {
    if (this.closed) return;
    this.kind = "sse";
    this.callbacks.onState("connecting");
    const events = new EventSource(
      `${this.sessionUrl("events")}?${this.connectionQuery()}`,
    );
    this.events = events;
    let received = false;
    let failed = false;
    const isCurrent = () => !this.closed && events === this.events && !failed;

    const fail = (reason: string) => {
      if (!isCurrent()) return;
      failed = true;
      events.close();
      window.clearTimeout(this.connectionTimer);
      this.callbacks.onState("disconnected");
      if (!received) this.sseFailures += 1;
      if (
        (received && reason === "timeout") ||
        this.sseFailures >= FAILURES_BEFORE_FALLBACK
      )
        this.connectLongPoll();
      else this.scheduleReconnect(() => this.connectSse());
    };

    this.connectionTimer = window.setTimeout(
      () => fail("timeout"),
      CONNECTION_TIMEOUT_MS,
    );
    events.addEventListener("message", (event) => {
      if (!isCurrent()) return;
      if (!received) {
        received = true;
        window.clearTimeout(this.connectionTimer);
        this.retry = 0;
        this.sseFailures = 0;
        this.callbacks.onState("connected");
      }
      window.clearTimeout(this.connectionTimer);
      this.connectionTimer = window.setTimeout(
        () => fail("timeout"),
        SSE_IDLE_TIMEOUT_MS,
      );
      this.deliver(event.data);
    });
    events.addEventListener("error", () => fail("error"));
  }

  private connectLongPoll(): void {
    if (this.closed) return;
    this.kind = "poll";
    this.callbacks.onState("connecting");
    const generation = this.generation;
    const signal = this.abortController.signal;
    const isCurrent = () => !this.closed && generation === this.generation;

    void (async () => {
      let query = this.connectionQuery();
      let connected = false;
      try {
        while (isCurrent()) {
          const response = await fetch(`${this.sessionUrl("poll")}?${query}`, {
            signal: AbortSignal.any([signal, AbortSignal.timeout(35_000)]),
            cache: "no-store",
          });
          if (!response.ok) throw new Error(`Poll failed: ${response.status}`);
          const { messages } = (await response.json()) as {
            messages: ServerMessage[];
          };
          if (!isCurrent()) return;
          if (!connected) {
            connected = true;
            this.retry = 0;
            this.callbacks.onState("connected");
          }
          for (const message of messages) this.accept(message);
          query = new URLSearchParams({
            cursor: String(this.cursor),
          }).toString();
        }
      } catch {
        if (!isCurrent()) return;
        this.callbacks.onState("disconnected");
        this.scheduleReconnect(() => this.connectLongPoll());
      }
    })();
  }

  private sessionUrl(endpoint: string): string {
    return `/api/session/${encodeURIComponent(this.sessionId)}/${endpoint}`;
  }

  private connectionQuery(): string {
    const params = new URLSearchParams({ cursor: String(this.cursor) });
    const size = this.callbacks.getSize?.();
    if (size) {
      params.set("cols", String(size.cols));
      params.set("rows", String(size.rows));
    }
    return params.toString();
  }

  private deliver(raw: string): void {
    try {
      this.accept(JSON.parse(raw) as ServerMessage);
    } catch {}
  }

  private accept(message: ServerMessage): void {
    if (message.type === "output" || message.type === "sync") {
      this.cursor = message.cursor;
    }
    this.callbacks.onMessage(message);
  }

  private scheduleReconnect(connect: () => void): void {
    const delay = Math.min(10_000, 500 * 2 ** this.retry++);
    this.retryTimer = window.setTimeout(connect, delay);
  }
}

function preferredTransport(): TransportKind {
  const requested = new URLSearchParams(location.search).get("transport");
  return requested === "poll" || requested === "sse" ? requested : "websocket";
}
