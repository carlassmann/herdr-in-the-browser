export type ClientMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number };

export type ServerMessage =
  | { type: "output"; data: string; cursor: number }
  | { type: "status"; running: boolean }
  | { type: "sync"; cursor: number; reset: boolean }
  | { type: "notify" };

export type SessionMode = "create" | "attach";

export interface SessionSummary {
  name: string;
  status: "running" | "stopped";
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
