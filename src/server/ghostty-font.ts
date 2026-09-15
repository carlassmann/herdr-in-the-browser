import { existsSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import { fallbackAppearance } from "../shared/protocol";
import { parseConfigValues } from "./ghostty-parser";

export type FontVariant = "regular" | "bold" | "italic" | "bold-italic";
const fallback = fallbackAppearance;
const fontPaths = new Map<string, string | undefined>();
export function clearFontPaths(): void {
  fontPaths.clear();
}

export function availableFontFaces(config: string, fallbackFamily: string) {
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

export function configuredFont(
  config: string,
  variant: FontVariant,
):
  | {
      path: string;
      contentType: string;
    }
  | undefined {
  const family = fontFamilyForVariant(parseConfigValues(config), variant);
  const path = findFontFile(family, variant);
  return path ? { path, contentType: fontContentType(path) } : undefined;
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

function findFontFile(
  family: string,
  variant: FontVariant = "regular",
): string | undefined {
  const cacheKey = `${family}\0${variant}`;
  if (fontPaths.has(cacheKey)) return fontPaths.get(cacheKey);
  const home = process.env.HOME ?? "";
  const directories = [
    join(home, "Library/Fonts"),
    "/Library/Fonts",
    "/System/Library/Fonts",
  ];
  const files: Array<{ path: string; name: string }> = [];

  for (const directory of directories) {
    if (!existsSync(directory)) continue;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const extension = extname(entry.name).toLowerCase();
      if (
        !entry.isFile() ||
        ![".otf", ".ttf", ".woff", ".woff2"].includes(extension)
      )
        continue;
      files.push({ path: join(directory, entry.name), name: entry.name });
    }
  }
  const path = selectFontFile(family, variant, files);
  fontPaths.set(cacheKey, path);
  return path;
}

export function selectFontFile(
  family: string,
  variant: FontVariant,
  files: ReadonlyArray<{ path: string; name: string }>,
): string | undefined {
  const familyKey = normalizeFontName(family);
  const candidates = files
    .flatMap(({ path, name }) => {
      const fileKey = normalizeFontName(name.replace(/\.[^.]+$/, ""));
      const withoutStyle = fileKey.replace(
        /(bolditalic|boldoblique|italic|oblique|bold|regular|book|roman|normal)$/,
        "",
      );
      if (fileKey !== familyKey && withoutStyle !== familyKey) return [];
      const isBold = /(bold|semibold|demibold)/.test(fileKey);
      const isItalic = /(italic|oblique)/.test(fileKey);
      const wantedBold = variant === "bold" || variant === "bold-italic";
      const wantedItalic = variant === "italic" || variant === "bold-italic";
      const exactVariant = isBold === wantedBold && isItalic === wantedItalic;
      return [
        { path, score: exactVariant ? 4 : fileKey === familyKey ? 2 : 1 },
      ];
    })
    .sort((a, b) => b.score - a.score);
  return variant === "regular"
    ? candidates[0]?.path
    : candidates.find(({ score }) => score === 4)?.path;
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
