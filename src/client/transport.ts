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
const SSE_FIRST_MESSAGE_TIMEOUT_MS = 5_000;

export class ReconnectingTransport implements Transport {
  private socket?: WebSocket;
  private events?: EventSource;
  private closed = false;
  private retry = 0;
  private retryTimer?: number;
  private websocketFailures = 0;
  private sseFailures = 0;
  private cursor = 0;
  private generation = 0;
  private outbound = Promise.resolve();
  private abortController = new AbortController();

  constructor(
    private readonly sessionId: string,
    private readonly callbacks: TransportCallbacks,
  ) {}

  connect(): void {
    this.closed = false;
    this.retry = 0;
    this.generation += 1;
    this.abortController.abort();
    this.abortController = new AbortController();
    this.connectWebSocket();
  }

  send(message: ClientMessage): void {
    const generation = this.generation;
    this.outbound = this.outbound
      .then(async () => {
        if (this.closed || generation !== this.generation) return;
        if (this.socket?.readyState === WebSocket.OPEN) {
          this.socket.send(JSON.stringify(message));
          return;
        }
        const endpoint = message.type === "input" ? "input" : "resize";
        await fetch(this.sessionUrl(endpoint), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(message),
          signal: this.abortController.signal,
        });
      })
      .catch(() => {});
  }

  close(): void {
    this.closed = true;
    this.generation += 1;
    this.abortController.abort();
    window.clearTimeout(this.retryTimer);
    this.socket?.close();
    this.events?.close();
  }

  private connectWebSocket(): void {
    if (this.closed) return;
    this.callbacks.onState("connecting");
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(
      `${protocol}//${location.host}${this.sessionUrl("ws")}?${this.connectionQuery()}`,
    );
    this.socket = socket;
    let opened = false;

    socket.addEventListener("open", () => {
      opened = true;
      this.retry = 0;
      this.websocketFailures = 0;
      this.callbacks.onState("connected");
    });
    socket.addEventListener("message", (event) =>
      this.deliver(String(event.data)),
    );
    socket.addEventListener("close", () => {
      if (this.closed || socket !== this.socket) return;
      this.callbacks.onState("disconnected");
      if (!opened) this.websocketFailures += 1;
      if (this.websocketFailures >= FAILURES_BEFORE_FALLBACK) this.connectSse();
      else this.scheduleReconnect(() => this.connectWebSocket());
    });
    socket.addEventListener("error", () => socket.close());
  }

  private connectSse(): void {
    if (this.closed) return;
    this.callbacks.onState("connecting");
    const events = new EventSource(
      `${this.sessionUrl("events")}?${this.connectionQuery()}`,
    );
    this.events = events;
    let received = false;
    let silenceTimer: number | undefined;

    const fail = () => {
      events.close();
      window.clearTimeout(silenceTimer);
      if (this.closed || events !== this.events) return;
      this.callbacks.onState("disconnected");
      if (!received) this.sseFailures += 1;
      if (this.sseFailures >= FAILURES_BEFORE_FALLBACK) this.connectLongPoll();
      else this.scheduleReconnect(() => this.connectSse());
    };

    events.addEventListener("open", () => {
      silenceTimer = window.setTimeout(fail, SSE_FIRST_MESSAGE_TIMEOUT_MS);
    });
    events.addEventListener("message", (event) => {
      if (!received) {
        received = true;
        window.clearTimeout(silenceTimer);
        this.retry = 0;
        this.sseFailures = 0;
        this.callbacks.onState("connected");
      }
      this.deliver(event.data);
    });
    events.addEventListener("error", fail);
  }

  private connectLongPoll(): void {
    if (this.closed) return;
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
            signal,
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
