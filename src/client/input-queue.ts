import type { ClientMessage } from "../shared/protocol";

export interface QueuedInput {
  message: ClientMessage;
  sequence?: number;
}

// Pure ordering and retry state. The sender owns I/O and timers; this module
// owns which messages may be sent, and which identity a retry must retain.
export class InputQueue {
  private pending: QueuedInput[] = [];
  private readonly inFlight = new Set<QueuedInput>();
  private nextSequence = 0;
  private sendFailures = 0;

  enqueue(message: ClientMessage): void {
    const previous = this.pending.at(-1);
    const mergeable = previous !== undefined && previous.sequence === undefined;
    if (
      mergeable &&
      message.type === "input" &&
      previous.message.type === "input" &&
      previous.message.data.length + message.data.length <= 64 * 1024
    ) {
      previous.message.data += message.data;
    } else if (
      mergeable &&
      message.type === "resize" &&
      previous.message.type === "resize"
    ) {
      previous.message = { ...message };
    } else {
      this.pending.push({ message: { ...message } });
    }
  }

  take(): QueuedInput | undefined {
    const queued = this.pending.shift();
    if (!queued) return;
    queued.sequence ??= this.nextSequence++;
    this.inFlight.add(queued);
    return queued;
  }

  acknowledge(queued: QueuedInput): boolean {
    const acknowledged = this.inFlight.delete(queued);
    if (acknowledged) this.sendFailures = 0;
    return acknowledged;
  }

  fail(queued: QueuedInput): boolean {
    if (!this.inFlight.delete(queued)) return false;
    this.requeue(queued);
    return true;
  }

  abortInFlight(): void {
    for (const queued of this.inFlight) this.requeue(queued);
    this.inFlight.clear();
  }

  restartStream(): void {
    this.nextSequence = 0;
    for (const queued of this.pending) queued.sequence = undefined;
    for (const queued of this.inFlight) queued.sequence = undefined;
  }

  // A fresh connection resets receive backoff, but failed sends retain theirs.
  nextSendRetry(): number {
    return Math.min(10_000, 500 * 2 ** this.sendFailures++);
  }

  drainForSocket(): ClientMessage[] {
    // A numbered POST may already have reached the server. Keep it on the
    // deduplicated path, and keep later messages behind it until acknowledged.
    if (
      this.inFlight.size ||
      this.pending.some(({ sequence }) => sequence !== undefined)
    )
      return [];
    const messages = this.pending.map(({ message }) => message);
    this.pending = [];
    return messages;
  }

  clear(): void {
    this.pending = [];
    this.inFlight.clear();
    this.nextSequence = 0;
    this.sendFailures = 0;
  }

  get hasPending(): boolean {
    return this.pending.length > 0;
  }
  get inFlightCount(): number {
    return this.inFlight.size;
  }

  private requeue(queued: QueuedInput): void {
    this.pending.unshift(queued);
    this.pending.sort(
      (a, b) => (a.sequence ?? Infinity) - (b.sequence ?? Infinity),
    );
  }
}
