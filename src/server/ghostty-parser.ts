import {
  fallbackAppearance,
  type MetricAdjustment,
  type PaddingBalance,
  type PaddingColor,
  type TerminalAppearance,
} from "../shared/protocol";

const paletteKeys = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;

const fallback = fallbackAppearance;

export function configuredThemeName(
  config: string,
  colorScheme: "light" | "dark",
): string | undefined {
  const themeLine = config
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("theme") && line.includes("="));
  const value = themeLine?.slice(themeLine.indexOf("=") + 1).trim();
  if (!value) return;
  const variants = value.split(",").map((variant) => variant.trim());
  const selected = variants.find((variant) =>
    variant.toLowerCase().startsWith(`${colorScheme}:`),
  );
  return selected ? selected.slice(selected.indexOf(":") + 1).trim() : value;
}

export function parseGhosttyConfig(config: string): TerminalAppearance {
  const values = parseConfigValues(config);
  const palette = new Map<number, string>();

  for (const rawLine of config.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key === "palette") {
      const paletteSeparator = value.indexOf("=");
      const index = Number(value.slice(0, paletteSeparator));
      const color = value.slice(paletteSeparator + 1).trim();
      if (Number.isInteger(index) && color) palette.set(index, color);
    }
  }

  const theme: TerminalAppearance["theme"] = {
    background: values.get("background") ?? fallback.theme.background,
    foreground: values.get("foreground") ?? fallback.theme.foreground,
    cursor: values.get("cursor-color"),
    cursorAccent: values.get("cursor-text"),
    selectionBackground: values.get("selection-background"),
    selectionForeground: values.get("selection-foreground"),
  };
  paletteKeys.forEach((key, index) => {
    const color = palette.get(index);
    if (color) theme[key] = color;
  });

  const configuredSize = Number(values.get("font-size"));
  const configuredCursor = values.get("cursor-style")?.toLowerCase();
  const horizontalPadding = parsePadding(values.get("window-padding-x"), 2);
  const verticalPadding = parsePadding(values.get("window-padding-y"), 2);
  const configuredColorScheme = values.get("window-theme")?.toLowerCase();
  return {
    fontFamily: values.get("font-family") ?? fallback.fontFamily,
    fontSize:
      Number.isFinite(configuredSize) &&
      configuredSize >= 8 &&
      configuredSize <= 40
        ? configuredSize
        : fallback.fontSize,
    cellWidthAdjustment: parseMetricAdjustment(values.get("adjust-cell-width")),
    cellHeightAdjustment: parseMetricAdjustment(
      values.get("adjust-cell-height"),
    ),
    padding: {
      top: verticalPadding[0],
      right: horizontalPadding[1],
      bottom: verticalPadding[1],
      left: horizontalPadding[0],
    },
    paddingBalance: parsePaddingBalance(values.get("window-padding-balance")),
    paddingColor: parsePaddingColor(values.get("window-padding-color")),
    colorScheme:
      configuredColorScheme === "light" || configuredColorScheme === "dark"
        ? configuredColorScheme
        : "system",
    cursorBlink: parseBoolean(
      values.get("cursor-style-blink"),
      fallback.cursorBlink,
    ),
    cursorStyle:
      configuredCursor === "bar" || configuredCursor === "underline"
        ? configuredCursor
        : "block",
    theme,
  };
}

export function parseConfigValues(config: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const rawLine of config.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim();
    if (key === "palette" || values.has(key)) continue;
    values.set(key, line.slice(separator + 1).trim());
  }
  return values;
}

function parseMetricAdjustment(
  value: string | undefined,
): MetricAdjustment | undefined {
  if (!value) return;
  const match = value.match(/^(-?(?:\d+\.?\d*|\.\d+))(%)?$/);
  if (!match) return;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return;
  return { value: amount, unit: match[2] ? "percent" : "pixels" };
}

function parsePadding(value: string | undefined, defaultValue: number) {
  const parts = value?.split(",").map((part) => Number(part.trim())) ?? [];
  const first = Number.isFinite(parts[0])
    ? Math.max(0, parts[0]!)
    : defaultValue;
  const second = Number.isFinite(parts[1]) ? Math.max(0, parts[1]!) : first;
  return [first, second] as const;
}

function parsePaddingBalance(value: string | undefined): PaddingBalance {
  if (value === "true") return "balanced";
  if (value === "equal") return "equal";
  return "off";
}

function parsePaddingColor(value: string | undefined): PaddingColor {
  return value === "extend" || value === "extend-always" ? value : "background";
}

function parseBoolean(
  value: string | undefined,
  defaultValue: boolean,
): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  return defaultValue;
}
