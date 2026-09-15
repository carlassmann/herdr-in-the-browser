import { beforeAll, describe, expect, test } from "bun:test";
import { Ghostty } from "ghostty-web";
import {
  encodeModifiedInput,
  TerminalKeyEncoder,
  type KeyboardProtocol,
  type KeyPress,
} from "./keyboard";

const ESC = String.fromCharCode(27);
const WASM_PATH = new URL(
  "../../node_modules/ghostty-web/dist/ghostty-vt.wasm",
  import.meta.url,
).pathname;

const legacy: KeyboardProtocol = {
  kittyFlags: 0,
  modifyOtherKeys: false,
  applicationCursorKeys: false,
  applicationKeypad: false,
};
const noneHeld = { control: false, alt: false };

function press(key: string, code: string, flags: string = ""): KeyPress {
  return {
    key,
    code,
    shiftKey: flags.includes("shift"),
    ctrlKey: flags.includes("ctrl"),
    altKey: flags.includes("alt"),
    metaKey: flags.includes("meta"),
  };
}

let ghostty: Ghostty;
let keys: TerminalKeyEncoder;

beforeAll(async () => {
  ghostty = await Ghostty.load(WASM_PATH);
  keys = new TerminalKeyEncoder(ghostty.createKeyEncoder(), {
    optionAsAlt: true,
  });
});

describe("terminal key encoding", () => {
  test("keeps shift on enter, tab, and backspace like native Ghostty", () => {
    expect(keys.encode(press("Enter", "Enter"), noneHeld, legacy)).toBe("\r");
    expect(
      keys.encode(press("Enter", "Enter", "shift"), noneHeld, legacy),
    ).toBe(`${ESC}[27;2;13~`);
    expect(keys.encode(press("Tab", "Tab", "shift"), noneHeld, legacy)).toBe(
      `${ESC}[Z`,
    );
    expect(
      keys.encode(press("Backspace", "Backspace", "ctrl"), noneHeld, legacy),
    ).toBe("\b");
  });

  test("applies the kitty keyboard flags an application enabled", () => {
    const kitty = { ...legacy, kittyFlags: 1 };
    expect(keys.encode(press("Enter", "Enter", "shift"), noneHeld, kitty)).toBe(
      `${ESC}[13;2u`,
    );
    expect(keys.encode(press("A", "KeyA", "ctrl shift"), noneHeld, kitty)).toBe(
      `${ESC}[97;6u`,
    );
    expect(keys.encode(press("Escape", "Escape"), noneHeld, kitty)).toBe(
      `${ESC}[27u`,
    );
    expect(keys.encode(press("a", "KeyA"), noneHeld, kitty)).toBe("a");
  });

  // Shift is spent producing " or !, so the character travels as text. Report
  // it as an unshifted key plus a Shift modifier and the application has to
  // guess the layout, which is how quotes went missing.
  test("sends characters the layout shifted as plain text", () => {
    for (const protocol of [legacy, { ...legacy, kittyFlags: 7 }]) {
      expect(keys.encode(press("A", "KeyA", "shift"), noneHeld, protocol)).toBe(
        "A",
      );
      expect(
        keys.encode(press('"', "Quote", "shift"), noneHeld, protocol),
      ).toBe('"');
      expect(
        keys.encode(press("!", "Digit1", "shift"), noneHeld, protocol),
      ).toBe("!");
    }
  });

  test("reports every key as an escape code when asked to", () => {
    const reportAll = { ...legacy, kittyFlags: 15 };
    expect(keys.encode(press("a", "KeyA"), noneHeld, reportAll)).toBe(
      `${ESC}[97u`,
    );
    expect(
      keys.encode(press("!", "Digit1", "shift"), noneHeld, reportAll),
    ).toBe(`${ESC}[49:33;2u`);
  });

  test("honours modifyOtherKeys and application cursor keys", () => {
    expect(
      keys.encode(press("A", "KeyA", "shift"), noneHeld, {
        ...legacy,
        modifyOtherKeys: true,
      }),
    ).toBe(`${ESC}[27;2;65~`);
    expect(
      keys.encode(press("ArrowUp", "ArrowUp"), noneHeld, {
        ...legacy,
        applicationCursorKeys: true,
      }),
    ).toBe(`${ESC}OA`);
  });

  test("treats Option as Alt even though macOS composed a character", () => {
    expect(keys.encode(press("∫", "KeyB", "alt"), noneHeld, legacy)).toBe(
      `${ESC}b`,
    );
    expect(
      keys.encode(press("∫", "KeyB", "alt"), noneHeld, {
        ...legacy,
        kittyFlags: 1,
      }),
    ).toBe(`${ESC}[98;3u`);

    const composing = new TerminalKeyEncoder(ghostty.createKeyEncoder(), {
      optionAsAlt: false,
    });
    expect(composing.encode(press("∫", "KeyB", "alt"), noneHeld, legacy)).toBe(
      "∫",
    );
    composing.dispose();
  });

  test("passes through characters from layouts the key map does not know", () => {
    expect(keys.encode(press("é", ""), noneHeld, legacy)).toBe("é");
    expect(keys.encode(press("Dead", ""), noneHeld, legacy)).toBe("");
  });

  test("types the character a dead key is printed with", () => {
    expect(keys.encode(press("Dead", "Quote"), noneHeld, legacy)).toBe("'");
    expect(keys.encode(press("Dead", "Quote", "shift"), noneHeld, legacy)).toBe(
      '"',
    );
    expect(keys.encode(press("Dead", "Backquote"), noneHeld, legacy)).toBe("`");
  });

  test("leaves Option dead keys composing so option+u a still types ä", () => {
    expect(keys.encode(press("Dead", "KeyU", "alt"), noneHeld, legacy)).toBe(
      "",
    );
  });

  test("applies the toolbar modifiers as real modifiers", () => {
    expect(
      keys.encode(press("c", "KeyC"), { control: true, alt: false }, legacy),
    ).toBe("\u0003");
    expect(
      keys.encode(press("x", "KeyX"), { control: false, alt: true }, legacy),
    ).toBe(`${ESC}x`);
  });

  test("leaves clipboard and Command shortcuts to the browser", () => {
    expect(keys.encode(press("v", "KeyV", "meta"), noneHeld, legacy)).toBe(
      undefined,
    );
    expect(keys.encode(press("v", "KeyV", "ctrl"), noneHeld, legacy)).toBe(
      undefined,
    );
    expect(keys.encode(press("c", "KeyC", "meta"), noneHeld, legacy)).toBe(
      undefined,
    );
  });
});

describe("mobile terminal modifiers", () => {
  test("encodes Ctrl+C and Ctrl+B as terminal control bytes", () => {
    expect(encodeModifiedInput("c", { control: true, alt: false })).toBe(
      "\u0003",
    );
    expect(encodeModifiedInput("B", { control: true, alt: false })).toBe(
      "\u0002",
    );
  });

  test("encodes the non-letter control characters", () => {
    const control = { control: true, alt: false };
    expect(encodeModifiedInput(" ", control)).toBe("\u0000");
    expect(encodeModifiedInput("@", control)).toBe("\u0000");
    expect(encodeModifiedInput("[", control)).toBe(ESC);
    expect(encodeModifiedInput("\\", control)).toBe("\u001c");
    expect(encodeModifiedInput("]", control)).toBe("\u001d");
    expect(encodeModifiedInput("^", control)).toBe("\u001e");
    expect(encodeModifiedInput("_", control)).toBe("\u001f");
    expect(encodeModifiedInput("?", control)).toBe("\u007f");
  });

  test("leaves input without a control mapping unchanged", () => {
    expect(encodeModifiedInput("5", { control: true, alt: false })).toBe("5");
  });

  test("combines Ctrl and Alt", () => {
    expect(encodeModifiedInput("[", { control: true, alt: true })).toBe(
      `${ESC}${ESC}`,
    );
  });

  test("prefixes Alt input with escape", () => {
    expect(encodeModifiedInput("x", { control: false, alt: true })).toBe(
      `${ESC}x`,
    );
  });
});
