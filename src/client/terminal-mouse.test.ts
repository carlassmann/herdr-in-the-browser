import { describe, expect, test } from "bun:test";
import {
  createWheelTickAccumulator,
  encodeTerminalMouse,
  wheelDeltaMode,
} from "./terminal-mouse";

describe("terminal mouse reporting", () => {
  test("encodes SGR click, release, motion, and wheel events", () => {
    expect(encodeTerminalMouse({ button: 0, col: 4, row: 2 }, true)).toBe(
      "\u001b[<0;4;2M",
    );
    expect(
      encodeTerminalMouse({ button: 0, col: 4, row: 2, release: true }, true),
    ).toBe("\u001b[<0;4;2m");
    expect(
      encodeTerminalMouse({ button: 0, col: 4, row: 2, motion: true }, true),
    ).toBe("\u001b[<32;4;2M");
    expect(
      encodeTerminalMouse({ button: 3, col: 4, row: 2, wheel: "down" }, true),
    ).toBe("\u001b[<65;4;2M");
  });

  test("preserves modifiers and supports legacy mouse mode", () => {
    expect(
      encodeTerminalMouse(
        { button: 0, col: 1, row: 1, shift: true, alt: true, control: true },
        true,
      ),
    ).toBe("\u001b[<28;1;1M");
    expect(encodeTerminalMouse({ button: 0, col: 1, row: 1 }, false)).toBe(
      "\u001b[M !!",
    );
  });
});

describe("wheel tick accumulation", () => {
  const cell = { height: 20, rows: 40 };

  test("turns many small pixel deltas into whole line ticks", () => {
    const ticks = createWheelTickAccumulator();
    expect(ticks(8, "pixel", cell)).toBe(0);
    expect(ticks(8, "pixel", cell)).toBe(0);
    expect(ticks(8, "pixel", cell)).toBe(1);
    expect(ticks(-45, "pixel", cell)).toBe(-2);
  });

  test("resets the carry when the direction flips", () => {
    const ticks = createWheelTickAccumulator();
    expect(ticks(15, "pixel", cell)).toBe(0);
    expect(ticks(-15, "pixel", cell)).toBe(0);
    expect(ticks(-5, "pixel", cell)).toBe(-1);
  });

  test("treats line and page deltas as whole lines", () => {
    const ticks = createWheelTickAccumulator();
    expect(ticks(3, "line", cell)).toBe(3);
    expect(ticks(1, "page", cell)).toBe(40);
    expect(wheelDeltaMode(1)).toBe("line");
  });
});
