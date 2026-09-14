import type { ClientMessage } from "../shared/protocol";

interface PendingInput {
  message: ClientMessage;
  promise: Promise<void>;
  resolve(): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}
interface InputStream {
  next: number;
  failed: boolean;
  pending: Map<number, PendingInput>;
}

export class OrderedInput {
  private readonly streams = new Map<string, InputStream>();

  constructor(
    private readonly apply: (message: ClientMessage) => void,
    private readonly timeoutMs = 5_000,
  ) {}

  receive(id: string, sequence: number, message: ClientMessage): Promise<void> {
    if (
      !/^[a-zA-Z0-9-]{1,64}$/.test(id) ||
      !Number.isSafeInteger(sequence) ||
      sequence < 0
    )
      return Promise.reject(new Error("Invalid input sequence."));
    let stream = this.streams.get(id);
    if (!stream) {
      if (sequence > 1)
        return Promise.reject(new Error("Unknown input stream."));
      if (this.streams.size >= 64) {
        const idle = [...this.streams].find(
          ([, candidate]) => candidate.pending.size === 0,
        );
        if (!idle) return Promise.reject(new Error("Too many input streams."));
        this.streams.delete(idle[0]);
      }
      stream = { next: 0, failed: false, pending: new Map() };
      this.streams.set(id, stream);
    }
    if (stream.failed || sequence > stream.next + 1)
      return Promise.reject(new Error("Input stream interrupted. Reconnect."));
    if (sequence < stream.next) return Promise.resolve();
    const existing = stream.pending.get(sequence);
    if (existing) return existing.promise;
    let resolve = () => {};
    let reject = (_error: Error) => {};
    const promise = new Promise<void>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    const pending: PendingInput = {
      message,
      promise,
      resolve,
      reject,
      timer: setTimeout(() => this.fail(stream!), this.timeoutMs),
    };
    stream.pending.set(sequence, pending);
    while (stream.pending.has(stream.next)) {
      const next = stream.pending.get(stream.next)!;
      try {
        this.apply(next.message);
      } catch {
        this.fail(stream);
        break;
      }
      clearTimeout(next.timer);
      stream.pending.delete(stream.next++);
      next.resolve();
    }
    return promise;
  }

  private fail(stream: InputStream): void {
    stream.failed = true;
    for (const pending of stream.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Input stream interrupted. Reconnect."));
    }
    stream.pending.clear();
  }
}
