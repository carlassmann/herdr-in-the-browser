import { describe, expect, test } from "bun:test";
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
