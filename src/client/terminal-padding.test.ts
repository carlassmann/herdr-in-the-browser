import { describe, expect, test } from "bun:test";
import type { GhosttyCell } from "ghostty-web";
import {
  balancedOffsets,
  cellBackground,
  paddingExtension,
  parseHexColor,
  rowNeverExtendsBackground,
} from "./padding-rules";

const explicit = { top: 2, right: 2, bottom: 2, left: 2 };
const background = { r: 0x10, g: 0x12, b: 0x16 };

function cell(overrides: Partial<GhosttyCell> = {}): GhosttyCell {
  return {
    codepoint: 0x61,
    fg_r: 200,
    fg_g: 200,
    fg_b: 200,
    bg_r: 30,
    bg_g: 40,
    bg_b: 50,
    flags: 0,
    width: 1,
    hyperlink_id: 0,
    grapheme_len: 0,
    ...overrides,
  };
}

describe("balancedOffsets", () => {
  test("keeps the grid hugging the top-left when balancing is off", () => {
    expect(
      balancedOffsets({
        leftover: { width: 21, height: 13 },
        explicit,
        cellWidth: 9,
        mode: "off",
      }),
    ).toEqual({ left: 0, top: 0 });
  });

  test("splits leftover space evenly and rounds down", () => {
    expect(
      balancedOffsets({
        leftover: { width: 21, height: 13 },
        explicit,
        cellWidth: 9,
        mode: "equal",
      }),
    ).toEqual({ left: 10, top: 6 });
  });

  test("caps the top offset so the first row stays near the edge", () => {
    expect(
      balancedOffsets({
        leftover: { width: 0, height: 30 },
        explicit,
        cellWidth: 9,
        mode: "balanced",
      }),
    ).toEqual({ left: 0, top: 4 });
  });

  test("never produces negative offsets", () => {
    expect(
      balancedOffsets({
        leftover: { width: -3, height: 4 },
        explicit: { top: 20, right: 0, bottom: 0, left: 0 },
        cellWidth: 9,
        mode: "balanced",
      }),
    ).toEqual({ left: 0, top: 0 });
  });
});

describe("cell backgrounds", () => {
  test("parses Ghostty hex colors with or without a hash", () => {
    expect(parseHexColor("#101216")).toEqual(background);
    expect(parseHexColor("101216")).toEqual(background);
    expect(parseHexColor("red")).toBeUndefined();
  });

  test("treats unset and theme-matching backgrounds as default", () => {
    expect(
      cellBackground(cell({ bg_r: 0, bg_g: 0, bg_b: 0 }), background),
    ).toBeUndefined();
    expect(
      cellBackground(cell({ bg_r: 0x10, bg_g: 0x12, bg_b: 0x16 }), background),
    ).toBeUndefined();
    expect(cellBackground(cell(), background)).toEqual({ r: 30, g: 40, b: 50 });
  });

  test("uses the foreground for inverse cells", () => {
    expect(cellBackground(cell({ flags: 16 }), background)).toEqual({
      r: 200,
      g: 200,
      b: 200,
    });
  });
});

describe("paddingExtension", () => {
  const colored = [cell(), cell(), cell()];

  test("extends everywhere when the row is fully colored", () => {
    expect(
      paddingExtension("extend", { top: colored, bottom: colored }, background),
    ).toEqual({ up: true, down: true, left: true, right: true });
  });

  test("stops extending vertically when a row shows the default background", () => {
    const mixed = [cell(), cell({ bg_r: 0, bg_g: 0, bg_b: 0 })];
    expect(
      paddingExtension("extend", { top: mixed, bottom: colored }, background),
    ).toEqual({ up: false, down: true, left: true, right: true });
  });

  test("stops extending vertically around powerline glyphs", () => {
    const powerline = [cell(), cell({ codepoint: 0xe0b0 })];
    expect(rowNeverExtendsBackground(powerline, background)).toBe(true);
  });

  test("extend-always ignores the heuristics", () => {
    const mixed = [cell({ bg_r: 0, bg_g: 0, bg_b: 0 })];
    expect(
      paddingExtension(
        "extend-always",
        { top: mixed, bottom: mixed },
        background,
      ),
    ).toEqual({ up: true, down: true, left: true, right: true });
  });

  test("background mode never extends", () => {
    expect(
      paddingExtension(
        "background",
        { top: colored, bottom: colored },
        background,
      ),
    ).toEqual({ up: false, down: false, left: false, right: false });
  });
});
