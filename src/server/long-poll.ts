import type { ServerMessage } from "../shared/protocol";

type Listener = (message: ServerMessage) => void;

export interface MessageSource {
  subscribe(listener: Listener, cursor: number): () => void;
}

interface CollectOptions {
  timeoutMs: number;
  batchMs?: number;
  signal?: AbortSignal;
}

// Output arrives from the PTY in bursts of small chunks. Waiting a few
// milliseconds after the first one lets a burst travel in a single response.
const DEFAULT_BATCH_MS = 25;

export function collectMessages(
  source: MessageSource,
  cursor: number,
  { timeoutMs, batchMs = DEFAULT_BATCH_MS, signal }: CollectOptions,
): Promise<ServerMessage[]> {
  return new Promise((resolve) => {
    const messages: ServerMessage[] = [];
    let unsubscribe = () => {};
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(flushTimer);
      signal?.removeEventListener("abort", finish);
      unsubscribe();
      resolve(messages);
    };
    const deadline = setTimeout(finish, timeoutMs);
    signal?.addEventListener("abort", finish);

    unsubscribe = source.subscribe((message) => {
      messages.push(message);
      if (isHeartbeat(message) || flushTimer) return;
      flushTimer = setTimeout(finish, batchMs);
    }, cursor);
    if (settled) unsubscribe();
  });
}

function isHeartbeat(message: ServerMessage): boolean {
  return (
    (message.type === "status" && message.running) ||
    (message.type === "sync" && !message.reset)
  );
}
