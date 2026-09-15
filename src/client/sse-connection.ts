import { timing } from "../shared/protocol";
import {
  decodeMessage,
  type Connection,
  type ConnectionOptions,
  type FailureReason,
} from "./connection";

const CONNECTION_TIMEOUT_MS = 5_000;

export class SseConnection implements Connection {
  private events?: EventSource;
  private timer?: number;
  private received = false;
  private stopped = false;

  constructor(private readonly options: ConnectionOptions) {}

  open(): void {
    this.stopped = false;
    const events = new EventSource(
      `${this.options.url("events")}?${this.options.query()}`,
    );
    this.events = events;
    this.timer = window.setTimeout(
      () => this.fail("timeout"),
      CONNECTION_TIMEOUT_MS,
    );
    events.addEventListener("message", (event) => {
      if (this.stopped) return;
      if (!this.received) {
        this.received = true;
        this.options.callbacks.onConnected();
      }
      window.clearTimeout(this.timer);
      this.timer = window.setTimeout(
        () => this.fail("timeout"),
        timing.sseIdleTimeoutMs,
      );
      this.options.callbacks.onMessage(decodeMessage(event.data));
    });
    events.addEventListener("error", () => this.fail("error"));
  }

  close(): void {
    this.stopped = true;
    window.clearTimeout(this.timer);
    this.events?.close();
    this.events = undefined;
  }

  private fail(reason: FailureReason): void {
    if (this.stopped) return;
    const received = this.received;
    this.close();
    this.options.callbacks.onFailure(received, reason);
  }
}
