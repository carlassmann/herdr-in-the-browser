export type ClientMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number };

export type ServerMessage =
  | { type: "output"; data: string; cursor: number }
  | { type: "status"; running: boolean }
  | { type: "sync"; cursor: number; reset: boolean }
  | { type: "notify" }
  | { type: "clipboard"; text: string };

export type SessionMode = "create" | "attach";

export interface SessionSummary {
  name: string;
  status: "running" | "stopped";
}

export interface TerminalSize {
  cols: number;
  rows: number;
}

// What a client tells the server when it connects: where its output stream
// stopped, and how big its terminal is. Without a size the PTY keeps its own.
export interface AttachOptions {
  cursor: number;
  size?: TerminalSize;
}

export type SessionEndpoint = "ws" | "events" | "poll" | "input" | "resize";

export function sessionEndpoint(
  sessionId: string,
  endpoint: SessionEndpoint,
): string {
  return `/api/session/${encodeURIComponent(sessionId)}/${endpoint}`;
}

// Fallback input travels as numbered POSTs so the server can apply it in
// order and drop repeats.
export const INPUT_STREAM_HEADER = "X-Terminal-Input-Stream";
export const INPUT_SEQUENCE_HEADER = "X-Terminal-Input-Sequence";

// Both ends must agree on these, or a stream that is alive on one side looks
// dead on the other: the client waits longer than the server stays quiet.
export const timing = {
  sseKeepAliveMs: 15_000,
  sseIdleTimeoutMs: 35_000,
  // Well under Cloudflare's 100 s proxy read timeout.
  longPollTimeoutMs: 25_000,
  longPollAbortMs: 35_000,
} as const;

const MIN_COLS = 2;
const MAX_COLS = 500;
const MIN_ROWS = 1;
const MAX_ROWS = 300;

export function clampTerminalSize(size: TerminalSize): TerminalSize {
  return {
    cols: clamp(size.cols, MIN_COLS, MAX_COLS),
    rows: clamp(size.rows, MIN_ROWS, MAX_ROWS),
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}

export function attachQuery({ cursor, size }: AttachOptions): string {
  const params = new URLSearchParams({ cursor: String(cursor) });
  if (size) {
    params.set("cols", String(size.cols));
    params.set("rows", String(size.rows));
  }
  return params.toString();
}

export function parseAttachQuery(params: URLSearchParams): AttachOptions {
  const cursor = Number(params.get("cursor") ?? 0);
  const options: AttachOptions = {
    cursor: Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0,
  };
  if (params.has("cols") && params.has("rows")) {
    options.size = clampTerminalSize({
      cols: Number(params.get("cols")),
      rows: Number(params.get("rows")),
    });
  }
  return options;
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

export function isServerMessage(value: unknown): value is ServerMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  switch (message.type) {
    case "output":
      return (
        typeof message.data === "string" && typeof message.cursor === "number"
      );
    case "status":
      return typeof message.running === "boolean";
    case "sync":
      return (
        typeof message.cursor === "number" && typeof message.reset === "boolean"
      );
    case "notify":
      return true;
    case "clipboard":
      return typeof message.text === "string";
    default:
      return false;
  }
}

export interface TerminalAppearance {
  fontFamily: string;
  fontSize: number;
  fontFaces?: Array<{
    url: string;
    style: "normal" | "italic";
    weight: "400" | "700";
  }>;
  cellWidthAdjustment?: MetricAdjustment;
  cellHeightAdjustment?: MetricAdjustment;
  padding: { top: number; right: number; bottom: number; left: number };
  paddingBalance: PaddingBalance;
  paddingColor: PaddingColor;
  colorScheme: "light" | "dark" | "system";
  cursorBlink: boolean;
  cursorStyle: "block" | "underline" | "bar";
  theme: TerminalTheme;
  lightTheme?: TerminalTheme;
  darkTheme?: TerminalTheme;
}

// What both tiers show when the Ghostty config cannot be read.
export const fallbackAppearance: TerminalAppearance = {
  fontFamily: "Geist Mono Variable",
  fontSize: 15,
  padding: { top: 2, right: 2, bottom: 2, left: 2 },
  paddingBalance: "off",
  paddingColor: "background",
  colorScheme: "system",
  cursorBlink: true,
  cursorStyle: "block",
  theme: {
    background: "#09090b",
    foreground: "#e4e4e7",
    cursor: "#34d399",
    selectionBackground: "#115e59",
  },
};

export type PaddingBalance = "off" | "balanced" | "equal";

export type PaddingColor = "background" | "extend" | "extend-always";

export interface MetricAdjustment {
  value: number;
  unit: "pixels" | "percent";
}

export interface TerminalTheme {
  background: string;
  foreground: string;
  cursor?: string;
  cursorAccent?: string;
  selectionBackground?: string;
  selectionForeground?: string;
  black?: string;
  red?: string;
  green?: string;
  yellow?: string;
  blue?: string;
  magenta?: string;
  cyan?: string;
  white?: string;
  brightBlack?: string;
  brightRed?: string;
  brightGreen?: string;
  brightYellow?: string;
  brightBlue?: string;
  brightMagenta?: string;
  brightCyan?: string;
  brightWhite?: string;
}
