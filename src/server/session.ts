import { spawn, type IPty } from "bun-pty";
import type {
  ClientMessage,
  ServerMessage,
  SessionMode,
  SessionSummary,
} from "../shared/protocol";

const MAX_REPLAY_BYTES = 1024 * 1024;

type Listener = (message: ServerMessage) => void;

interface ReplayChunk {
  data: string;
  bytes: number;
  cursor: number;
}

export class ReplayBuffer {
  private chunks: ReplayChunk[] = [];
  private bytes = 0;
  private cursor = 0;

  constructor(private readonly maxBytes = MAX_REPLAY_BYTES) {}

  append(data: string): number {
    const bytes = Buffer.byteLength(data);
    this.cursor += bytes;
    this.bytes += bytes;
    this.chunks.push({ data, bytes, cursor: this.cursor });
    while (this.bytes > this.maxBytes && this.chunks.length > 1) {
      this.bytes -= this.chunks.shift()?.bytes ?? 0;
    }
    return this.cursor;
  }

  after(cursor: number): {
    cursor: number;
    reset: boolean;
    chunks: ReadonlyArray<{ data: string; cursor: number }>;
  } {
    const oldestCursor = this.cursor - this.bytes;
    const reset = cursor < oldestCursor;
    const replayCursor = reset ? oldestCursor : cursor;
    return {
      cursor: replayCursor,
      reset,
      chunks: this.chunks
        .filter((chunk) => chunk.cursor > replayCursor)
        .map(({ data, cursor }) => ({ data, cursor })),
    };
  }
}

export class TerminalSession {
  readonly name: string;
  private readonly process: IPty;
  private readonly listeners = new Set<Listener>();
  private readonly replay = new ReplayBuffer();
  private running = true;

  constructor(name: string, mode: SessionMode) {
    this.name = name;
    const args =
      mode === "attach" ? ["session", "attach", name] : ["--session", name];

    const herdrExecutable = process.env.HERDR_BIN ?? Bun.which("herdr");
    if (!herdrExecutable)
      throw new Error(
        "herdr was not found on PATH. Set HERDR_BIN to its absolute path.",
      );

    this.process = spawn(herdrExecutable, args, {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env: {
        ...process.env,
        COLORTERM: "truecolor",
        TERM_PROGRAM: "HerdrWeb",
      },
    });

    this.process.onData((data) => {
      const cursor = this.replay.append(data);
      this.publish({ type: "output", data, cursor });
    });
    this.process.onExit(() => {
      this.running = false;
      this.publish({ type: "status", connected: false });
    });
  }

  summary(): SessionSummary {
    return {
      name: this.name,
      status: this.running ? "running" : "stopped",
      attached: this.listeners.size > 0,
    };
  }

  isRunning(): boolean {
    return this.running;
  }

  subscribe(listener: Listener, cursor = 0): () => void {
    this.listeners.add(listener);
    listener({ type: "status", connected: this.running });
    const replay = this.replay.after(cursor);
    listener({ type: "sync", cursor: replay.cursor, reset: replay.reset });
    for (const chunk of replay.chunks) {
      listener({ type: "output", ...chunk });
    }
    return () => this.listeners.delete(listener);
  }

  stop(): void {
    if (this.running) this.process.kill();
  }

  receive(message: ClientMessage): void {
    if (!this.running) return;
    if (message.type === "input") {
      this.process.write(message.data);
      return;
    }
    const cols = clampDimension(message.cols, 2, 500);
    const rows = clampDimension(message.rows, 1, 300);
    this.process.resize(cols, rows);
  }

  private publish(message: ServerMessage): void {
    for (const listener of this.listeners) listener(message);
  }
}

function clampDimension(
  value: number,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}

export function isClientMessage(value: unknown): value is ClientMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  if (message.type === "input") return typeof message.data === "string";
  return (
    message.type === "resize" &&
    typeof message.cols === "number" &&
    typeof message.rows === "number"
  );
}
