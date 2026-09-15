import type { IPty } from "bun-pty";
import {
  clampTerminalSize,
  type AttachOptions,
  type ClientMessage,
  type ServerMessage,
  type SessionMode,
  type SessionSummary,
} from "../shared/protocol";
import { OrderedInput } from "./ordered-input";
import { spawnHerdr } from "./herdr";
import { TerminalModeTracker } from "../shared/terminal-modes";
import { TerminalSidebandScanner } from "../shared/terminal-sideband";

const MAX_REPLAY_BYTES = 1024 * 1024;
const MAX_REPLAY_MARKERS = 256;

type Listener = (message: ServerMessage) => void;

// The part of a PTY the session drives. bun-pty provides it in production; a
// test hands in a scripted one.
export type TerminalProcess = Pick<
  IPty,
  "onData" | "onExit" | "write" | "resize" | "kill"
>;

// Fallback input carries a stream id and a sequence number so it can be
// applied in order and repeats can be dropped.
export interface InputOrdering {
  stream: string;
  sequence: number;
}

interface ReplayChunk {
  data: string;
  bytes: number;
  cursor: number;
}

// A notification or clipboard write has no bytes of its own in the output
// stream, so it is pinned to the cursor of the output it arrived with.
interface ReplayMarker {
  message: ServerMessage;
  cursor: number;
}

export class ReplayBuffer {
  private chunks: ReplayChunk[] = [];
  private markers: ReplayMarker[] = [];
  private bytes = 0;
  private cursor = 0;

  constructor(
    private readonly maxBytes = MAX_REPLAY_BYTES,
    private readonly maxMarkers = MAX_REPLAY_MARKERS,
  ) {}

  append(data: string): number {
    const bytes = Buffer.byteLength(data);
    this.cursor += bytes;
    this.bytes += bytes;
    this.chunks.push({ data, bytes, cursor: this.cursor });
    while (this.bytes > this.maxBytes && this.chunks.length > 1) {
      this.bytes -= this.chunks.shift()?.bytes ?? 0;
    }
    const oldestCursor = this.cursor - this.bytes;
    this.markers = this.markers.filter(
      (marker) => marker.cursor > oldestCursor,
    );
    return this.cursor;
  }

  mark(message: ServerMessage): void {
    this.markers.push({ message, cursor: this.cursor });
    if (this.markers.length > this.maxMarkers) this.markers.shift();
  }

  // Markers replay only for a client that missed a gap, never after a reset:
  // an old clipboard write or a burst of stale bells would be wrong then.
  after(cursor: number): {
    cursor: number;
    reset: boolean;
    chunks: ReadonlyArray<{ data: string; cursor: number }>;
    markers: ReadonlyArray<ServerMessage>;
  } {
    const oldestCursor = this.cursor - this.bytes;
    const reset = cursor < oldestCursor || cursor > this.cursor;
    const replayCursor = reset ? oldestCursor : cursor;
    return {
      cursor: replayCursor,
      reset,
      chunks: this.chunks
        .filter((chunk) => chunk.cursor > replayCursor)
        .map(({ data, cursor }) => ({ data, cursor })),
      markers: reset
        ? []
        : this.markers
            .filter((marker) => marker.cursor > replayCursor)
            .map((marker) => marker.message),
    };
  }
}

export class TerminalSession {
  private readonly listeners = new Set<Listener>();
  private readonly replay = new ReplayBuffer();
  private readonly modes = new TerminalModeTracker();
  private readonly sideband = new TerminalSidebandScanner();
  private readonly orderedInput = new OrderedInput((message) =>
    this.apply(message),
  );
  private running = true;

  // Runs Herdr in a fresh PTY. The browser runs Ghostty's own renderer, and
  // Herdr only hands its notifications to terminals it knows can show them.
  // The person sits behind a browser, not at the host, so the session presents
  // as an SSH login: Herdr then copies with OSC 52 instead of the host
  // clipboard.
  static spawn(
    name: string,
    mode: SessionMode,
    onExit: () => void = () => {},
  ): TerminalSession {
    return new TerminalSession(name, spawnHerdr(name, mode), onExit);
  }

  constructor(
    readonly name: string,
    private readonly process: TerminalProcess,
    onExit: () => void = () => {},
  ) {
    this.process.onData((data) => {
      const cursor = this.replay.append(data);
      this.modes.observe(data);
      this.publish({ type: "output", data, cursor });
      for (const event of this.sideband.scan(data)) {
        const message: ServerMessage =
          event.kind === "alert"
            ? { type: "notify" }
            : { type: "clipboard", text: event.text };
        this.replay.mark(message);
        this.publish(message);
      }
    });
    this.process.onExit(() => {
      this.running = false;
      this.publish({ type: "status", running: false });
      onExit();
    });
  }

  summary(): SessionSummary {
    return {
      name: this.name,
      status: this.running ? "running" : "stopped",
    };
  }

  isRunning(): boolean {
    return this.running;
  }

  // Connects a client. Its terminal size is applied before anything is sent,
  // then it hears, in this order: the session status, where the replay starts
  // and whether the client must reset, the terminal modes to restore after a
  // reset, the output it missed, and the notifications that came with it.
  // The listener stays attached for live messages until detached.
  attach(listener: Listener, { cursor, size }: AttachOptions): () => void {
    if (size) this.apply({ type: "resize", ...size });
    this.listeners.add(listener);
    listener({ type: "status", running: this.running });
    const replay = this.replay.after(cursor);
    listener({ type: "sync", cursor: replay.cursor, reset: replay.reset });
    const restore = replay.reset ? this.modes.restoreSequence() : "";
    if (restore)
      listener({ type: "output", data: restore, cursor: replay.cursor });
    for (const chunk of replay.chunks) {
      listener({ type: "output", ...chunk });
    }
    for (const marker of replay.markers) listener(marker);
    return () => this.listeners.delete(listener);
  }

  stop(): void {
    if (this.running) this.process.kill();
  }

  // Input from a live connection applies at once. Numbered input waits for
  // its predecessors and rejects once the stream has a gap it cannot fill.
  receive(message: ClientMessage, ordering?: InputOrdering): Promise<void> {
    if (ordering) {
      return this.orderedInput.receive(
        ordering.stream,
        ordering.sequence,
        message,
      );
    }
    this.apply(message);
    return Promise.resolve();
  }

  private apply(message: ClientMessage): void {
    if (!this.running) return;
    if (message.type === "input") {
      this.process.write(message.data);
      return;
    }
    const { cols, rows } = clampTerminalSize(message);
    this.process.resize(cols, rows);
  }

  private publish(message: ServerMessage): void {
    for (const listener of this.listeners) listener(message);
  }
}
