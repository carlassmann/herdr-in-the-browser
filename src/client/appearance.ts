import {
  fallbackAppearance,
  type TerminalAppearance,
  type TerminalTheme,
} from "../shared/protocol";

let appearancePromise: Promise<TerminalAppearance> | undefined;

export function loadAppearance(): Promise<TerminalAppearance> {
  appearancePromise ??= fetch("/api/appearance")
    .then((response) =>
      response.ok
        ? (response.json() as Promise<TerminalAppearance>)
        : fallbackAppearance,
    )
    .catch(() => fallbackAppearance);
  return appearancePromise;
}

interface ResolvedAppearance {
  theme: TerminalTheme;
  dark: boolean;
}

export function resolveAppearance(
  appearance: TerminalAppearance,
): ResolvedAppearance {
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const dark =
    appearance.colorScheme === "dark" ||
    (appearance.colorScheme === "system" && prefersDark);
  return {
    dark,
    theme:
      (dark ? appearance.darkTheme : appearance.lightTheme) ?? appearance.theme,
  };
}

export function watchSystemAppearance(onChange: () => void): () => void {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

export function applyAppearance(appearance: TerminalAppearance): void {
  const { theme, dark } = resolveAppearance(appearance);
  const root = document.documentElement;
  const set = (name: string, value: string) =>
    root.style.setProperty(name, value);
  const tint = (percent: number, target: string) =>
    `color-mix(in srgb, ${theme.foreground} ${percent}%, ${target})`;

  const accent = theme.green ?? "#10b981";
  const accentStrong = theme.brightGreen ?? accent;

  root.style.colorScheme = dark ? "dark" : "light";

  set("--terminal-background", theme.background);
  set("--terminal-foreground", theme.foreground);
  set("--ui-background", theme.background);
  set("--ui-foreground", theme.foreground);
  set("--ui-muted", tint(62, theme.background));
  set("--ui-surface", tint(7, theme.background));
  set("--ui-surface-strong", tint(15, theme.background));
  set(
    "--ui-border",
    `color-mix(in srgb, ${theme.foreground} 18%, transparent)`,
  );
  set(
    "--ui-border-soft",
    `color-mix(in srgb, ${theme.foreground} 10%, transparent)`,
  );
  set("--ui-accent", accent);
  set("--ui-accent-strong", accentStrong);
  set("--ui-accent-foreground", theme.background);
  set("--ui-warning", theme.yellow ?? "#fbbf24");
  set("--ui-danger", theme.red ?? "#fb7185");
  set("--ui-danger-foreground", theme.background);
  set("--ui-focus", accentStrong);

  set("--terminal-padding-top", `${appearance.padding.top}px`);
  set("--terminal-padding-right", `${appearance.padding.right}px`);
  set("--terminal-padding-bottom", `${appearance.padding.bottom}px`);
  set("--terminal-padding-left", `${appearance.padding.left}px`);

  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", theme.background);
}
