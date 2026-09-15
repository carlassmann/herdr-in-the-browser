import {
  Key,
  KeyAction,
  KeyEncoderOption,
  Mods,
  keyCodeMap,
  type KeyEncoder,
} from "ghostty-web";

export interface Modifiers {
  control: boolean;
  alt: boolean;
}

export type KeyPress = Pick<
  KeyboardEvent,
  "key" | "code" | "shiftKey" | "ctrlKey" | "altKey" | "metaKey"
> &
  Partial<Pick<KeyboardEvent, "repeat">>;

export interface KeyboardProtocol {
  kittyFlags: number;
  modifyOtherKeys: boolean;
  applicationCursorKeys: boolean;
  applicationKeypad: boolean;
}

interface KeyEncoderOptions {
  // Ghostty's macos-option-as-alt: Option acts as Alt for the shell instead
  // of composing characters like ∫ or ƒ.
  optionAsAlt: boolean;
}

const decoder = new TextDecoder();

// Runs every key press through Ghostty's own key encoder, the same code path
// the native app uses, so shift+enter, kitty keyboard flags, modifyOtherKeys,
// and alt prefixes match a native Ghostty window.
export class TerminalKeyEncoder {
  constructor(
    private readonly encoder: KeyEncoder,
    private readonly options: KeyEncoderOptions,
  ) {
    encoder.setOption(KeyEncoderOption.ALT_ESC_PREFIX, true);
  }

  // Returns undefined when the browser should keep the key (copy and paste
  // shortcuts, Command combinations), otherwise the bytes for the pty.
  encode(
    original: KeyPress,
    held: Modifiers,
    protocol: KeyboardProtocol,
  ): string | undefined {
    if (isBrowserShortcut(original)) return undefined;

    const press = resolveDeadKey(original);
    if (press === undefined) return "";

    const text = keyText(press.key);
    const baseText = text !== undefined ? baseCharacter(press) : undefined;
    const composedWithAlt =
      press.altKey && baseText !== undefined && baseText !== text;
    if (composedWithAlt && !this.options.optionAsAlt) return text;

    const utf8 = composedWithAlt ? baseText : text;
    const unshifted = press.shiftKey
      ? (unshiftedCharacter(press.code) ?? utf8?.toLowerCase())
      : utf8;

    this.syncProtocol(protocol);
    const encoded = this.encoder.encode({
      action: press.repeat ? KeyAction.REPEAT : KeyAction.PRESS,
      key: keyCodeMap[press.code] ?? Key.UNIDENTIFIED,
      mods: modifierFlags(press, held),
      consumedMods: consumedShift(press, utf8, unshifted),
      utf8,
      unshiftedCodepoint: unshifted?.codePointAt(0),
    });
    return decoder.decode(encoded);
  }

  dispose(): void {
    this.encoder.dispose();
  }

  private syncProtocol(protocol: KeyboardProtocol): void {
    this.encoder.setOption(
      KeyEncoderOption.KITTY_KEYBOARD_FLAGS,
      protocol.kittyFlags,
    );
    this.encoder.setOption(
      KeyEncoderOption.MODIFY_OTHER_KEYS_STATE_2,
      protocol.modifyOtherKeys,
    );
    this.encoder.setOption(
      KeyEncoderOption.CURSOR_KEY_APPLICATION,
      protocol.applicationCursorKeys,
    );
    this.encoder.setOption(
      KeyEncoderOption.KEYPAD_KEY_APPLICATION,
      protocol.applicationKeypad,
    );
  }
}

function isBrowserShortcut(press: KeyPress): boolean {
  const commandOnly = press.metaKey && !press.ctrlKey && !press.altKey;
  const paste = press.ctrlKey && press.code === "KeyV";
  return commandOnly || paste;
}

// Layouts like US-International turn ' and " into dead keys that only produce
// a character once the next key decides which accent to compose. A terminal
// wants the quote itself, so such a key resolves to the character printed on
// it and the composition never starts. Option is how macOS reaches characters
// its layout has no key for, so a dead key held with it keeps composing and
// option+u a still types ä.
function resolveDeadKey(press: KeyPress): KeyPress | undefined {
  if (press.key !== "Dead") return press;
  if (press.altKey) return undefined;
  const literal = baseCharacter(press);
  return literal === undefined ? undefined : { ...press, key: literal };
}

function keyText(key: string): string | undefined {
  return [...key].length === 1 ? key : undefined;
}

function modifierFlags(press: KeyPress, held: Modifiers): Mods {
  let mods = Mods.NONE;
  if (press.shiftKey) mods |= Mods.SHIFT;
  if (press.ctrlKey || held.control) mods |= Mods.CTRL;
  if (press.altKey || held.alt) mods |= Mods.ALT;
  if (press.metaKey) mods |= Mods.SUPER;
  return mods;
}

// A shifted character like " or ! is text the layout already produced, so
// Shift is spent and the kitty protocol must report the character itself
// instead of an unshifted key plus a Shift modifier.
function consumedShift(
  press: KeyPress,
  text: string | undefined,
  unshifted: string | undefined,
): Mods {
  const shiftProducedText =
    press.shiftKey &&
    !press.ctrlKey &&
    !press.metaKey &&
    text !== undefined &&
    text !== unshifted;
  return shiftProducedText ? Mods.SHIFT : Mods.NONE;
}

function baseCharacter(press: KeyPress): string | undefined {
  return press.shiftKey
    ? shiftedCharacter(press.code)
    : unshiftedCharacter(press.code);
}

const UNSHIFTED_PUNCTUATION: Record<string, string> = {
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Space: " ",
};

const SHIFTED_PUNCTUATION: Record<string, string> = {
  Backquote: "~",
  Minus: "_",
  Equal: "+",
  BracketLeft: "{",
  BracketRight: "}",
  Backslash: "|",
  Semicolon: ":",
  Quote: '"',
  Comma: "<",
  Period: ">",
  Slash: "?",
  Space: " ",
};

const SHIFTED_DIGITS = ")!@#$%^&*(";

// Physical key positions named after the US layout, which is the best guess
// available once the browser has already applied Shift or Option.
function unshiftedCharacter(code: string): string | undefined {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  return UNSHIFTED_PUNCTUATION[code];
}

function shiftedCharacter(code: string): string | undefined {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return SHIFTED_DIGITS[Number(code.slice(5))];
  return SHIFTED_PUNCTUATION[code];
}

const CONTROL_CHARACTERS: Record<string, string> = {
  " ": "\u0000",
  "@": "\u0000",
  "[": "\u001b",
  "\\": "\u001c",
  "]": "\u001d",
  "^": "\u001e",
  _: "\u001f",
  "?": "\u007f",
};

// Applies the toolbar modifiers to text that never passed through a key
// event, such as composed input and the toolbar's own key buttons.
export function encodeModifiedInput(
  data: string,
  modifiers: Modifiers,
): string {
  const encoded = modifiers.control ? controlCharacter(data) : data;
  return modifiers.alt ? `\u001b${encoded}` : encoded;
}

function controlCharacter(data: string): string {
  if (/^[a-z]$/i.test(data)) {
    return String.fromCharCode(data.toUpperCase().charCodeAt(0) & 31);
  }
  return CONTROL_CHARACTERS[data] ?? data;
}
