import type { ClientMessage, ServerMessage } from "../shared/protocol";

export type TransportState = "connecting" | "connected" | "disconnected";

interface TransportCallbacks {
  onMessage(message: ServerMessage): void;
  onState(state: TransportState): void;
  onFreshConnection(): void;
  getSize?(): { cols: number; rows: number };
}

interface Transport {
  connect(): void;
  send(message: ClientMessage): void;
  close(): void;
}

export class ReconnectingTransport implements Transport {
  private socket?: WebSocket;
  private events?: EventSource;
  private closed = false;
  private retry = 0;
  private retryTimer?: number;
  private websocketFailures = 0;
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
        await fetch(
          `/api/session/${encodeURIComponent(this.sessionId)}/${endpoint}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(message),
            signal: this.abortController.signal,
          },
        );
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
      `${protocol}//${location.host}/api/session/${encodeURIComponent(this.sessionId)}/ws?${this.connectionQuery()}`,
    );
    this.socket = socket;
    let opened = false;

    socket.addEventListener("open", () => {
      opened = true;
      this.retry = 0;
      this.websocketFailures = 0;
      this.callbacks.onFreshConnection();
      this.callbacks.onState("connected");
    });
    socket.addEventListener("message", (event) =>
      this.deliver(String(event.data)),
    );
    socket.addEventListener("close", () => {
      if (this.closed || socket !== this.socket) return;
      this.callbacks.onState("disconnected");
      if (!opened) this.websocketFailures += 1;
      if (this.websocketFailures >= 2) this.connectSse();
      else this.scheduleReconnect(() => this.connectWebSocket());
    });
    socket.addEventListener("error", () => socket.close());
  }

  private connectSse(): void {
    if (this.closed) return;
    this.callbacks.onState("connecting");
    const events = new EventSource(
      `/api/session/${encodeURIComponent(this.sessionId)}/events?${this.connectionQuery()}`,
    );
    this.events = events;
    events.addEventListener("open", () => {
      this.retry = 0;
      this.callbacks.onFreshConnection();
      this.callbacks.onState("connected");
    });
    events.addEventListener("message", (event) => this.deliver(event.data));
    events.addEventListener("error", () => {
      events.close();
      if (this.closed || events !== this.events) return;
      this.callbacks.onState("disconnected");
      this.scheduleReconnect(() => this.connectSse());
    });
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
      const message = JSON.parse(raw) as ServerMessage;
      if (message.type === "output" || message.type === "sync") {
        this.cursor = message.cursor;
      }
      this.callbacks.onMessage(message);
    } catch {}
  }

  private scheduleReconnect(connect: () => void): void {
    const delay = Math.min(10_000, 500 * 2 ** this.retry++);
    this.retryTimer = window.setTimeout(connect, delay);
  }
}
