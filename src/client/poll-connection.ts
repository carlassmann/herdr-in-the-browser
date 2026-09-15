import { timing } from "../shared/protocol";
import { type Connection, type ConnectionOptions } from "./connection";

export class PollConnection implements Connection {
  private abort = new AbortController();
  private stopped = false;

  constructor(private readonly options: ConnectionOptions) {}

  open(): void {
    this.stopped = false;
    this.abort = new AbortController();
    void this.poll();
  }

  close(): void {
    this.stopped = true;
    this.abort.abort();
  }

  private async poll(): Promise<void> {
    let query = this.options.query();
    let connected = false;
    try {
      while (!this.stopped) {
        const response = await fetch(`${this.options.url("poll")}?${query}`, {
          signal: AbortSignal.any([
            this.abort.signal,
            AbortSignal.timeout(timing.longPollAbortMs),
          ]),
          cache: "no-store",
        });
        if (!response.ok) throw new Error(`Poll failed: ${response.status}`);
        const { messages } = (await response.json()) as {
          messages?: unknown[];
        };
        if (this.stopped) return;
        if (!connected) {
          connected = true;
          this.options.callbacks.onConnected();
        }
        for (const message of messages ?? [])
          this.options.callbacks.onMessage(message);
        query = new URLSearchParams({
          cursor: String(this.options.cursor()),
        }).toString();
      }
    } catch {
      if (!this.stopped) this.options.callbacks.onFailure(connected, "error");
    }
  }
}
