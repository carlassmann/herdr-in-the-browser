const ESC = "\u001b";
const CONTROL_SEQUENCE = /\u001b\[([?>=<]?)([0-9;:]*)([A-Za-z~])/g;
const INCOMPLETE_CONTROL_SEQUENCE = /^\u001b(\[[0-9;:?>=<]*)?$/;
const LONGEST_PARTIAL_SEQUENCE = 32;

const RESTORED_MODES = new Set([
  1, 7, 25, 47, 66, 1000, 1002, 1003, 1004, 1005, 1006, 1015, 1016, 1047, 1049,
  2004,
]);
const MODES_ON_BY_DEFAULT = new Set([7, 25]);
const ALTERNATE_SCREEN_MODES = new Set([47, 1047, 1049]);

type KittySetMode = "set" | "or" | "not";

// Mirrors Ghostty's fixed ring of eight entries, wraparound included, so a
// restored terminal lands in the same state as the original.
class KittyKeyboardStack {
  private static readonly DEPTH = 8;
  private readonly flags = new Array<number>(KittyKeyboardStack.DEPTH).fill(0);
  private index = 0;

  current(): number {
    return this.flags[this.index]!;
  }

  push(flags: number): void {
    this.index = (this.index + 1) % KittyKeyboardStack.DEPTH;
    this.flags[this.index] = flags;
  }

  pop(count: number): void {
    if (count >= KittyKeyboardStack.DEPTH) {
      this.flags.fill(0);
      this.index = 0;
      return;
    }
    for (let i = 0; i < count; i++) {
      this.flags[this.index] = 0;
      this.index =
        (this.index + KittyKeyboardStack.DEPTH - 1) % KittyKeyboardStack.DEPTH;
    }
  }

  set(mode: KittySetMode, flags: number): void {
    const current = this.flags[this.index]!;
    if (mode === "set") this.flags[this.index] = flags;
    else if (mode === "or") this.flags[this.index] = current | flags;
    else this.flags[this.index] = current & ~flags;
  }

  restoreSequence(): string {
    let sequence = "";
    if (this.flags[0]) sequence += `${ESC}[=${this.flags[0]};1u`;
    for (let i = 1; i <= this.index; i++) {
      sequence += `${ESC}[>${this.flags[i]}u`;
    }
    return sequence;
  }
}

// Ghostty's terminal core keeps DEC private modes and the keyboard protocol
// state private, so both ends learn them by watching the output stream. The
// server replays them into a fresh terminal whose replay no longer starts at
// the beginning of the stream; the browser feeds them to the key encoder.
export class TerminalModeTracker {
  private readonly modes = new Map<number, boolean>();
  private kittyStacks = {
    main: new KittyKeyboardStack(),
    alternate: new KittyKeyboardStack(),
  };
  private alternateScreen = false;
  private modifyOtherKeysEnabled = false;
  private partialSequence = "";

  observe(output: string): void {
    const text = this.partialSequence + output;
    for (const match of text.matchAll(CONTROL_SEQUENCE)) {
      this.apply(match[1]!, match[2]!, match[3]!);
    }
    this.partialSequence = trailingPartialSequence(text);
  }

  reset(): void {
    this.modes.clear();
    this.kittyStacks = {
      main: new KittyKeyboardStack(),
      alternate: new KittyKeyboardStack(),
    };
    this.alternateScreen = false;
    this.modifyOtherKeysEnabled = false;
    this.partialSequence = "";
  }

  get kittyFlags(): number {
    return this.activeKittyStack().current();
  }

  get modifyOtherKeys(): boolean {
    return this.modifyOtherKeysEnabled;
  }

  restoreSequence(): string {
    let sequence = this.kittyStacks.main.restoreSequence();
    if (this.modifyOtherKeysEnabled) sequence += `${ESC}[>4;2m`;
    for (const [mode, enabled] of this.modes) {
      if (enabled === MODES_ON_BY_DEFAULT.has(mode)) continue;
      sequence += `${ESC}[?${mode}${enabled ? "h" : "l"}`;
    }
    if (this.alternateScreen) {
      sequence += this.kittyStacks.alternate.restoreSequence();
    }
    return sequence;
  }

  private apply(prefix: string, parameters: string, final: string): void {
    if (prefix === "?" && (final === "h" || final === "l")) {
      this.applyPrivateModes(parameters, final === "h");
    } else if (prefix === ">" && final === "u") {
      this.activeKittyStack().push(parseParameter(parameters, 0));
    } else if (prefix === "<" && final === "u") {
      this.activeKittyStack().pop(parseParameter(parameters, 1));
    } else if (prefix === "=" && final === "u") {
      const [flags = "", mode = ""] = parameters.split(";");
      this.activeKittyStack().set(
        kittySetMode(parseParameter(mode, 1)),
        parseParameter(flags, 0),
      );
    } else if (prefix === ">" && final === "m") {
      this.applyModifyOtherKeys(parameters);
    }
  }

  private applyPrivateModes(parameters: string, enabled: boolean): void {
    for (const mode of parameters.split(";").map(Number)) {
      if (RESTORED_MODES.has(mode)) this.modes.set(mode, enabled);
      if (ALTERNATE_SCREEN_MODES.has(mode)) this.alternateScreen = enabled;
    }
  }

  private applyModifyOtherKeys(parameters: string): void {
    const [resource = "", value = ""] = parameters.split(";");
    if (resource === "") this.modifyOtherKeysEnabled = false;
    else if (resource === "4") this.modifyOtherKeysEnabled = value === "2";
  }

  private activeKittyStack(): KittyKeyboardStack {
    return this.alternateScreen
      ? this.kittyStacks.alternate
      : this.kittyStacks.main;
  }
}

function kittySetMode(value: number): KittySetMode {
  if (value === 2) return "or";
  if (value === 3) return "not";
  return "set";
}

function parseParameter(value: string, defaultValue: number): number {
  const parsed = Number(value);
  return value !== "" && Number.isFinite(parsed) ? parsed : defaultValue;
}

function trailingPartialSequence(text: string): string {
  const escape = text.lastIndexOf(ESC);
  if (escape === -1 || text.length - escape > LONGEST_PARTIAL_SEQUENCE) {
    return "";
  }
  const tail = text.slice(escape);
  return INCOMPLETE_CONTROL_SEQUENCE.test(tail) ? tail : "";
}
