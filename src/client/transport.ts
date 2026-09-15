import {
  attachQuery,
  INPUT_SEQUENCE_HEADER,
  INPUT_STREAM_HEADER,
  isServerMessage,
  sessionEndpoint,
  type ClientMessage,
  type ServerMessage,
  type SessionEndpoint,
} from "../shared/protocol";
import {
  type Connection,
  type ConnectionKind,
  type FailureReason,
} from "./connection";
import { InputQueue, type QueuedInput } from "./input-queue";
import { PollConnection } from "./poll-connection";
import { SseConnection } from "./sse-connection";
import { WebSocketConnection } from "./websocket-connection";

export type TransportState = "connecting" | "connected" | "disconnected";

interface TransportCallbacks {
  onMessage(message: ServerMessage): void;
  onState(state: TransportState): void;
  getSize?(): { cols: number; rows: number };
}

const FAILURES_BEFORE_FALLBACK = 2;
const MAX_IN_FLIGHT = 2;
const SEND_SPACING_MS = 50;

export class ReconnectingTransport {
  private kind: ConnectionKind = preferredTransport();
  private connection?: Connection;
  private closed = false;
  private retry = 0;
  private retryTimer?: number;
  private websocketFailures = 0;
  private sseFailures = 0;
  private cursor = 0;
  private readonly input = new InputQueue();
  private inputPaused = false;
  private sendTimer?: number;
  private lastSent = -Infinity;
  private inputStream = crypto.randomUUID();
  private abortController = new AbortController();

  constructor(
    private readonly sessionId: string,
    private readonly callbacks: TransportCallbacks,
  ) {}

  // Keep input identity across reconnects: an aborted POST may have succeeded.
  connect(): void {
    this.stopReceiving();
    this.abortInFlight();
    this.closed = false;
    this.retry = 0;
    this.inputPaused = false;
    this.openConnection();
  }

  send(message: ClientMessage): void {
    if (this.closed) return;
    this.input.enqueue(message);
    this.flush();
  }

  close(): void {
    this.closed = true;
    this.stopReceiving();
    this.input.clear();
    this.inputPaused = false;
    this.inputStream = crypto.randomUUID();
    this.lastSent = -Infinity;
    window.clearTimeout(this.sendTimer);
    this.sendTimer = undefined;
    this.abortInFlight();
  }

  private flush(): void {
    if (
      this.closed ||
      this.inputPaused ||
      !this.input.hasPending ||
      this.input.inFlightCount >= MAX_IN_FLIGHT ||
      this.sendTimer !== undefined
    )
      return;
    if (this.kind === "websocket" && this.connection?.canSend?.()) {
      const messages = this.input.drainForSocket();
      if (messages.length) {
        for (const message of messages) this.connection.send?.(message);
        return;
      }
    }
    const delay = SEND_SPACING_MS - (performance.now() - this.lastSent);
    if (delay > 0) {
      this.sendTimer = window.setTimeout(() => {
        this.sendTimer = undefined;
        this.dispatch();
      }, delay);
      return;
    }
    this.dispatch();
  }

  private dispatch(): void {
    if (
      this.closed ||
      this.inputPaused ||
      this.input.inFlightCount >= MAX_IN_FLIGHT
    )
      return;
    const queued = this.input.take();
    if (!queued) return;
    this.lastSent = performance.now();
    void this.post(queued).finally(() => this.flush());
  }

  private async post(queued: QueuedInput): Promise<void> {
    const ownAbort = this.abortController.signal;
    try {
      const endpoint = queued.message.type === "input" ? "input" : "resize";
      const response = await fetch(this.sessionUrl(endpoint), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [INPUT_STREAM_HEADER]: this.inputStream,
          [INPUT_SEQUENCE_HEADER]: String(queued.sequence),
        },
        body: JSON.stringify(queued.message),
        signal: AbortSignal.any([ownAbort, AbortSignal.timeout(10_000)]),
      });
      if (response.ok) {
        this.input.acknowledge(queued);
      } else if (response.status === 409) {
        if (this.input.fail(queued)) {
          this.inputStream = crypto.randomUUID();
          this.input.restartStream();
        }
      } else if (response.status >= 500) {
        if (this.input.fail(queued)) this.recoverFromSendFailure();
      } else {
        this.input.acknowledge(queued);
      }
    } catch {
      if (!this.input.fail(queued)) return;
      if (!ownAbort.aborted) this.recoverFromSendFailure();
    }
  }

  private recoverFromSendFailure(): void {
    if (this.closed || this.inputPaused) return;
    this.inputPaused = true;
    this.stopReceiving();
    this.abortInFlight();
    this.callbacks.onState("disconnected");
    const delay = this.input.nextSendRetry();
    this.scheduleReconnect(() => this.openConnection(), delay);
  }

  private abortInFlight(): void {
    this.abortController.abort();
    this.abortController = new AbortController();
    this.input.abortInFlight();
  }

  private stopReceiving(): void {
    window.clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.connection?.close();
    this.connection = undefined;
  }

  private openConnection(): void {
    if (this.closed) return;
    this.callbacks.onState("connecting");
    const kind = this.kind;
    const options = {
      url: (endpoint: "ws" | "events" | "poll") => this.sessionUrl(endpoint),
      query: () =>
        attachQuery({ cursor: this.cursor, size: this.callbacks.getSize?.() }),
      cursor: () => this.cursor,
      callbacks: {
        onMessage: (message: unknown) => this.accept(message),
        onConnected: () => {
          this.retry = 0;
          this.inputPaused = false;
          if (kind === "websocket") this.websocketFailures = 0;
          if (kind === "sse") this.sseFailures = 0;
          this.callbacks.onState("connected");
          this.flush();
        },
        onFailure: (received: boolean, reason: FailureReason) =>
          this.connectionFailed(kind, received, reason),
      },
    };
    this.connection =
      kind === "websocket"
        ? new WebSocketConnection(options)
        : kind === "sse"
          ? new SseConnection(options)
          : new PollConnection(options);
    this.connection.open();
  }

  private connectionFailed(
    kind: ConnectionKind,
    received: boolean,
    reason: FailureReason,
  ): void {
    if (this.closed || this.kind !== kind) return;
    this.callbacks.onState("disconnected");
    if (kind === "websocket") {
      if (!received) this.websocketFailures++;
      if (this.websocketFailures >= FAILURES_BEFORE_FALLBACK)
        this.fallbackTo("sse");
      else this.scheduleReconnect(() => this.openConnection());
    } else if (kind === "sse") {
      if (!received) this.sseFailures++;
      if (
        (received && reason === "timeout") ||
        this.sseFailures >= FAILURES_BEFORE_FALLBACK
      )
        this.fallbackTo("poll");
      else this.scheduleReconnect(() => this.openConnection());
    } else {
      this.scheduleReconnect(() => this.openConnection());
    }
  }

  private fallbackTo(kind: ConnectionKind): void {
    this.connection?.close();
    this.kind = kind;
    this.openConnection();
  }

  private accept(message: unknown): void {
    if (!isServerMessage(message)) return;
    if (message.type === "output" || message.type === "sync")
      this.cursor = message.cursor;
    this.callbacks.onMessage(message);
  }

  private scheduleReconnect(
    connect: () => void,
    delay = Math.min(10_000, 500 * 2 ** this.retry++),
  ): void {
    if (this.retryTimer !== undefined) return;
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = undefined;
      connect();
    }, delay);
  }

  private sessionUrl(endpoint: SessionEndpoint): string {
    return sessionEndpoint(this.sessionId, endpoint);
  }
}

function preferredTransport(): ConnectionKind {
  const requested = new URLSearchParams(location.search).get("transport");
  return requested === "poll" || requested === "sse" ? requested : "websocket";
}
