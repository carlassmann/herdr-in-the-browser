import { describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configuredThemeName, parseGhosttyConfig } from "./ghostty-config";

describe("Ghostty appearance", () => {
  test("maps effective font, cursor, selection, and ANSI palette settings", () => {
    const appearance = parseGhosttyConfig(`
      font-family = Berkeley Mono
      font-size = 16
      adjust-cell-width = -1
      adjust-cell-height = 50%
      window-padding-x = 3,5
      window-padding-y = 4
      window-padding-balance = true
      window-padding-color = extend
      window-theme = system
      cursor-style = bar
      cursor-style-blink = false
      background = #101216
      foreground = #f0f2f4
      cursor-color = #ffcc00
      cursor-text = #101216
      selection-background = #334455
      selection-foreground = #ffffff
      palette = 0=#111111
      palette = 1=#ff0000
      palette = 8=#888888
      palette = 15=#ffffff
    `);

    expect(appearance).toMatchObject({
      fontFamily: "Berkeley Mono",
      fontSize: 16,
      cellWidthAdjustment: { value: -1, unit: "pixels" },
      cellHeightAdjustment: { value: 50, unit: "percent" },
      padding: { top: 4, right: 5, bottom: 4, left: 3 },
      paddingBalance: "balanced",
      paddingColor: "extend",
      colorScheme: "system",
      cursorBlink: false,
      cursorStyle: "bar",
      theme: {
        background: "#101216",
        foreground: "#f0f2f4",
        cursor: "#ffcc00",
        cursorAccent: "#101216",
        selectionBackground: "#334455",
        selectionForeground: "#ffffff",
        black: "#111111",
        red: "#ff0000",
        brightBlack: "#888888",
        brightWhite: "#ffffff",
      },
    });
  });

  test("defaults padding balance and color to Ghostty's defaults", () => {
    expect(parseGhosttyConfig("font-size = 14")).toMatchObject({
      paddingBalance: "off",
      paddingColor: "background",
    });
    expect(parseGhosttyConfig("window-padding-balance = equal")).toMatchObject({
      paddingBalance: "equal",
    });
  });

  test("selects a requested variant from a paired theme", () => {
    expect(
      configuredThemeName(
        "theme = light:Github Light Default,dark:Github Dark Default",
        "dark",
      ),
    ).toBe("Github Dark Default");
  });
});

describe("Ghostty config reloading", () => {
  test("reads Ghostty again only after the config file changes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ghostty-config-"));
    const config = join(directory, "config");
    const reads = join(directory, "reads");
    const ghostty = join(directory, "ghostty");
    writeFileSync(config, "font-size = 16\n");
    writeFileSync(
      ghostty,
      `#!/bin/sh\necho read >> ${reads}\ncat "$GHOSTTY_CONFIG_FILE"\n`,
      { mode: 0o755 },
    );
    process.env.GHOSTTY_BIN = ghostty;
    process.env.GHOSTTY_CONFIG_FILE = config;

    try {
      const { loadGhosttyAppearance } = (await import(
        `./ghostty-config?${directory}`
      )) as typeof import("./ghostty-config");

      expect((await loadGhosttyAppearance()).fontSize).toBe(16);
      expect((await loadGhosttyAppearance()).fontSize).toBe(16);
      expect(readFileSync(reads, "utf8").trim().split("\n")).toHaveLength(1);

      writeFileSync(config, "font-size = 22\n");
      utimesSync(config, new Date(), new Date(Date.now() + 1000));

      expect((await loadGhosttyAppearance()).fontSize).toBe(22);
      expect(readFileSync(reads, "utf8").trim().split("\n")).toHaveLength(2);
    } finally {
      delete process.env.GHOSTTY_BIN;
      delete process.env.GHOSTTY_CONFIG_FILE;
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
