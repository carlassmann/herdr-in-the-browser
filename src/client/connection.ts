import type { ClientMessage } from "../shared/protocol";

export type ConnectionKind = "websocket" | "sse" | "poll";
export type FailureReason = "timeout" | "closed" | "error";

export interface ConnectionCallbacks {
  onMessage(message: unknown): void;
  onConnected(): void;
  onFailure(received: boolean, reason: FailureReason): void;
}

export interface Connection {
  open(): void;
  close(): void;
  canSend?(): boolean;
  send?(message: ClientMessage): boolean;
}

export interface ConnectionOptions {
  url(endpoint: "ws" | "events" | "poll"): string;
  query(): string;
  cursor(): number;
  callbacks: ConnectionCallbacks;
}

export function decodeMessage(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
