import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  fallbackAppearance,
  type TerminalAppearance,
} from "../shared/protocol";
import { configuredThemeName, parseGhosttyConfig } from "./ghostty-parser";
import {
  availableFontFaces,
  clearFontPaths,
  configuredFont,
  type FontVariant,
} from "./ghostty-font";
const fallback = fallbackAppearance;

let appearancePromise: Promise<TerminalAppearance> | undefined;
let cachedAppearance: TerminalAppearance | undefined;
let effectiveConfigPromise: Promise<string | undefined> | undefined;
let loadedStamp: string | undefined;
const themeSources = new Set<string>();
const fontPromises = new Map<
  FontVariant,
  Promise<{ file: Bun.BunFile; contentType: string } | undefined>
>();

export function loadGhosttyAppearance(): Promise<TerminalAppearance> {
  discardEditedConfig();
  if (cachedAppearance) return Promise.resolve(cachedAppearance);
  appearancePromise ??= buildGhosttyAppearance()
    .then((appearance) => {
      cachedAppearance = appearance;
      loadedStamp = configStamp();
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

export function loadGhosttyFont(
  variant: FontVariant = "regular",
): Promise<{ file: Bun.BunFile; contentType: string } | undefined> {
  discardEditedConfig();
  const cached = fontPromises.get(variant);
  if (cached) return cached;
  const font = buildGhosttyFont(variant).catch((error) => {
    fontPromises.delete(variant);
    throw error;
  });
  fontPromises.set(variant, font);
  return font;
}

async function buildGhosttyFont(
  variant: FontVariant,
): Promise<{ file: Bun.BunFile; contentType: string } | undefined> {
  const config = await readEffectiveConfig();
  loadedStamp ??= configStamp();
  const font = configuredFont(config ?? "", variant);
  if (!font) return;
  return { file: Bun.file(font.path), contentType: font.contentType };
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

// Ghostty is read again when a config or theme file was touched since the
// last read, so editing the config only costs a page reload, not a restart.
// Files an `include` pulled in are invisible here: `ghostty +show-config`
// resolves them and reports only the result.
function discardEditedConfig(): void {
  if (appearancePromise || loadedStamp === undefined) return;
  if (configStamp() === loadedStamp) return;
  forgetGhosttyConfig();
}

// Drops everything read so far; the next request reads Ghostty again. The
// cache is otherwise invalidated by file stamps, so only tests need this.
export function forgetGhosttyConfig(): void {
  cachedAppearance = undefined;
  loadedStamp = undefined;
  effectiveConfigPromise = undefined;
  themeSources.clear();
  fontPromises.clear();
  clearFontPaths();
}

function configStamp(): string {
  const sources = new Set([...ghosttyConfigPaths(), ...themeSources]);
  return [...sources].map((path) => `${path}:${modifiedAt(path)}`).join("|");
}

function modifiedAt(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
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
  if (!path) return;
  themeSources.add(path);
  return readFileSync(path, "utf8");
}
