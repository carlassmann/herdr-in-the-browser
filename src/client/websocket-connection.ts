import type { ClientMessage } from "../shared/protocol";
import {
  decodeMessage,
  type Connection,
  type ConnectionOptions,
  type FailureReason,
} from "./connection";

const CONNECTION_TIMEOUT_MS = 5_000;

export class WebSocketConnection implements Connection {
  private socket?: WebSocket;
  private timer?: number;
  private received = false;
  private stopped = false;

  constructor(private readonly options: ConnectionOptions) {}

  open(): void {
    this.stopped = false;
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(
      `${protocol}//${location.host}${this.options.url("ws")}?${this.options.query()}`,
    );
    this.socket = socket;
    this.timer = window.setTimeout(
      () => this.fail("timeout"),
      CONNECTION_TIMEOUT_MS,
    );
    socket.addEventListener("message", (event) => {
      if (this.stopped) return;
      if (!this.received) {
        this.received = true;
        window.clearTimeout(this.timer);
        this.options.callbacks.onConnected();
      }
      this.options.callbacks.onMessage(decodeMessage(String(event.data)));
    });
    socket.addEventListener("close", () => this.fail("closed"));
    socket.addEventListener("error", () => this.fail("error"));
  }

  send(message: ClientMessage): boolean {
    if (!this.canSend()) return false;
    this.socket!.send(JSON.stringify(message));
    return true;
  }

  canSend(): boolean {
    return this.socket?.readyState === WebSocket.OPEN && !this.stopped;
  }

  close(): void {
    this.stopped = true;
    window.clearTimeout(this.timer);
    this.socket?.close();
    this.socket = undefined;
  }

  private fail(reason: FailureReason): void {
    if (this.stopped) return;
    const received = this.received;
    this.close();
    this.options.callbacks.onFailure(received, reason);
  }
}
