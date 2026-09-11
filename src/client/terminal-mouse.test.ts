import { describe, expect, test } from "bun:test";
import { encodeTerminalMouse } from "./terminal-mouse";

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
