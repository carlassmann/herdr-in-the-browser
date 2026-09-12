import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import type {
  MetricAdjustment,
  PaddingBalance,
  PaddingColor,
  TerminalAppearance,
} from "../shared/protocol";

type FontVariant = "regular" | "bold" | "italic" | "bold-italic";

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

const fallback: TerminalAppearance = {
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

let appearancePromise: Promise<TerminalAppearance> | undefined;
let cachedAppearance: TerminalAppearance | undefined;
let effectiveConfigPromise: Promise<string | undefined> | undefined;
const fontPromises = new Map<
  FontVariant,
  Promise<{ file: Bun.BunFile; contentType: string } | undefined>
>();
const fontPaths = new Map<string, string | undefined>();

export function loadGhosttyAppearance(): Promise<TerminalAppearance> {
  if (cachedAppearance) return Promise.resolve(cachedAppearance);
  appearancePromise ??= buildGhosttyAppearance()
    .then((appearance) => {
      cachedAppearance = appearance;
      return appearance;
    })
    .catch(() => structuredClone(fallback))
    .finally(() => {
      appearancePromise = undefined;
    });
  return appearancePromise;
}

async function buildGhosttyAppearance(): Promise<TerminalAppearance> {
  const config = await readEffectiveConfig();
  const appearance = config
    ? parseGhosttyConfig(config)
    : structuredClone(fallback);
  const lightThemeName = configuredThemeName(config ?? "", "light");
  const darkThemeName = configuredThemeName(config ?? "", "dark");
  const lightTheme = lightThemeName ? readTheme(lightThemeName) : undefined;
  const darkTheme = darkThemeName ? readTheme(darkThemeName) : undefined;
  if (lightTheme) appearance.lightTheme = parseGhosttyConfig(lightTheme).theme;
  if (darkTheme) appearance.darkTheme = parseGhosttyConfig(darkTheme).theme;

  const fontFaces = availableFontFaces(config ?? "", appearance.fontFamily);
  if (fontFaces.length) {
    appearance.fontFaces = fontFaces;
  }
  return appearance;
}

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

export function loadGhosttyFont(
  variant: FontVariant = "regular",
): Promise<{ file: Bun.BunFile; contentType: string } | undefined> {
  const cached = fontPromises.get(variant);
  if (cached) return cached;
  const font = buildGhosttyFont(variant);
  fontPromises.set(variant, font);
  return font;
}

async function buildGhosttyFont(
  variant: FontVariant,
): Promise<{ file: Bun.BunFile; contentType: string } | undefined> {
  const config = await readEffectiveConfig();
  const values = config ? parseConfigValues(config) : new Map<string, string>();
  const family = fontFamilyForVariant(values, variant);
  const path = findFontFile(family, variant);
  if (!path) return;
  return { file: Bun.file(path), contentType: fontContentType(path) };
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

function parseConfigValues(config: string): Map<string, string> {
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

function availableFontFaces(config: string, fallbackFamily: string) {
  const values = parseConfigValues(config);
  const variants: Array<{
    variant: FontVariant;
    style: "normal" | "italic";
    weight: "400" | "700";
  }> = [
    { variant: "regular", style: "normal", weight: "400" },
    { variant: "bold", style: "normal", weight: "700" },
    { variant: "italic", style: "italic", weight: "400" },
    { variant: "bold-italic", style: "italic", weight: "700" },
  ];
  return variants.flatMap(({ variant, style, weight }) => {
    const family = fontFamilyForVariant(values, variant, fallbackFamily);
    if (!findFontFile(family, variant)) return [];
    const suffix = variant === "regular" ? "" : `/${variant}`;
    return [{ url: `/api/appearance/font${suffix}`, style, weight }];
  });
}

function fontFamilyForVariant(
  values: Map<string, string>,
  variant: FontVariant,
  defaultFamily = fallback.fontFamily,
) {
  const keys: Record<FontVariant, string> = {
    regular: "font-family",
    bold: "font-family-bold",
    italic: "font-family-italic",
    "bold-italic": "font-family-bold-italic",
  };
  return (
    values.get(keys[variant]) ?? values.get("font-family") ?? defaultFamily
  );
}

async function readEffectiveConfig(): Promise<string | undefined> {
  effectiveConfigPromise ??= loadEffectiveConfig().catch((error) => {
    effectiveConfigPromise = undefined;
    throw error;
  });
  return effectiveConfigPromise;
}

async function loadEffectiveConfig(): Promise<string | undefined> {
  const executable = ghosttyExecutable();
  if (executable) {
    const child = Bun.spawn([executable, "+show-config"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const output = await new Response(child.stdout).text();
    if ((await child.exited) === 0 && output.trim()) return output;
  }
  return readEffectiveConfigFile();
}

function readEffectiveConfigFile(): string | undefined {
  for (const path of ghosttyConfigPaths()) {
    if (existsSync(path)) return readFileSync(path, "utf8");
  }
}

function ghosttyExecutable(): string | undefined {
  const candidates = [
    process.env.GHOSTTY_BIN,
    Bun.which("ghostty"),
    "/Applications/Ghostty.app/Contents/MacOS/ghostty",
    join(
      process.env.HOME ?? "",
      "Applications/Ghostty.app/Contents/MacOS/ghostty",
    ),
  ];
  return candidates.find((path): path is string =>
    Boolean(path && existsSync(path)),
  );
}

function ghosttyConfigPaths(): string[] {
  const home = process.env.HOME ?? "";
  return [
    process.env.GHOSTTY_CONFIG_FILE,
    join(
      home,
      "Library/Application Support/com.mitchellh.ghostty/config.ghostty",
    ),
    join(home, ".config/ghostty/config"),
  ].filter((path): path is string => Boolean(path));
}

function readTheme(name: string): string | undefined {
  const home = process.env.HOME ?? "";
  const candidates = [
    name,
    join(home, ".config/ghostty/themes", name),
    join(
      home,
      "Library/Application Support/com.mitchellh.ghostty/themes",
      name,
    ),
    join("/Applications/Ghostty.app/Contents/Resources/ghostty/themes", name),
  ];
  const path = candidates.find((candidate) => existsSync(candidate));
  return path ? readFileSync(path, "utf8") : undefined;
}

function findFontFile(
  family: string,
  variant: FontVariant = "regular",
): string | undefined {
  const cacheKey = `${family}\0${variant}`;
  if (fontPaths.has(cacheKey)) return fontPaths.get(cacheKey);
  const home = process.env.HOME ?? "";
  const familyKey = normalizeFontName(family);
  const directories = [
    join(home, "Library/Fonts"),
    "/Library/Fonts",
    "/System/Library/Fonts",
  ];
  const candidates: Array<{ path: string; score: number }> = [];

  for (const directory of directories) {
    if (!existsSync(directory)) continue;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const extension = extname(entry.name).toLowerCase();
      if (
        !entry.isFile() ||
        ![".otf", ".ttf", ".woff", ".woff2"].includes(extension)
      )
        continue;
      const fileKey = normalizeFontName(entry.name.replace(/\.[^.]+$/, ""));
      const withoutStyle = fileKey.replace(
        /(bolditalic|boldoblique|italic|oblique|bold|regular|book|roman|normal)$/,
        "",
      );
      if (fileKey === familyKey || withoutStyle === familyKey) {
        const isBold = /(bold|semibold|demibold)/.test(fileKey);
        const isItalic = /(italic|oblique)/.test(fileKey);
        const wantedBold = variant === "bold" || variant === "bold-italic";
        const wantedItalic = variant === "italic" || variant === "bold-italic";
        const exactVariant = isBold === wantedBold && isItalic === wantedItalic;
        candidates.push({
          path: join(directory, entry.name),
          score: exactVariant ? 4 : fileKey === familyKey ? 2 : 1,
        });
      }
    }
  }

  const ranked = candidates.sort((a, b) => b.score - a.score);
  if (variant !== "regular") {
    const path = ranked.find((candidate) => candidate.score === 4)?.path;
    fontPaths.set(cacheKey, path);
    return path;
  }
  const path = ranked[0]?.path;
  fontPaths.set(cacheKey, path);
  return path;
}

function normalizeFontName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function fontContentType(path: string): string {
  const extension = extname(path).toLowerCase();
  if (extension === ".otf") return "font/otf";
  if (extension === ".woff") return "font/woff";
  if (extension === ".woff2") return "font/woff2";
  return "font/ttf";
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
