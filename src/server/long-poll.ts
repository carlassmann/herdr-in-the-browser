import type { AttachOptions, ServerMessage } from "../shared/protocol";

type Listener = (message: ServerMessage) => void;

export interface MessageSource {
  attach(listener: Listener, options: AttachOptions): () => void;
}

interface CollectOptions {
  timeoutMs: number;
  batchMs?: number;
  signal?: AbortSignal;
  maxBytes?: number;
}

// Output arrives from the PTY in bursts of small chunks. Waiting a few
// milliseconds after the first one lets a burst travel in a single response.
const DEFAULT_BATCH_MS = 25;

export function collectMessages(
  source: MessageSource,
  attach: AttachOptions,
  {
    timeoutMs,
    batchMs = DEFAULT_BATCH_MS,
    signal,
    maxBytes = 1024 * 1024,
  }: CollectOptions,
): Promise<ServerMessage[]> {
  return new Promise((resolve) => {
    const messages: ServerMessage[] = [];
    let bytes = 0;
    let detach = () => {};
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(flushTimer);
      signal?.removeEventListener("abort", finish);
      detach();
      resolve(messages);
    };
    const deadline = setTimeout(finish, timeoutMs);
    signal?.addEventListener("abort", finish);

    detach = source.attach((message) => {
      if (settled) return;
      messages.push(message);
      bytes += Buffer.byteLength(JSON.stringify(message));
      if (bytes >= maxBytes) return finish();
      if (isHeartbeat(message) || flushTimer) return;
      flushTimer = setTimeout(finish, batchMs);
    }, attach);
    if (settled) detach();
  });
}

// Every attach opens with a running status and a sync; those alone are not
// worth ending the poll for.
function isHeartbeat(message: ServerMessage): boolean {
  return (
    (message.type === "status" && message.running) ||
    (message.type === "sync" && !message.reset)
  );
}
