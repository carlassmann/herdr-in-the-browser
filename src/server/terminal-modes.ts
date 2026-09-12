const ESC = "\u001b";
const PRIVATE_MODE_SEQUENCE = /\u001b\[\?([0-9;]+)([hl])/g;
const LONGEST_PARTIAL_SEQUENCE = 32;

const RESTORED_MODES = new Set([
  1, 7, 25, 47, 1000, 1002, 1003, 1004, 1005, 1006, 1015, 1016, 1047, 1049,
  2004,
]);
const MODES_ON_BY_DEFAULT = new Set([7, 25]);

// A replay that no longer starts at the beginning of the stream has lost the
// sequences that switched on mouse reporting, the alternate screen, and other
// DEC private modes. A fresh terminal must be told about them again.
export class PrivateModeTracker {
  private readonly modes = new Map<number, boolean>();
  private partialSequence = "";

  observe(output: string): void {
    const text = this.partialSequence + output;
    for (const match of text.matchAll(PRIVATE_MODE_SEQUENCE)) {
      const enabled = match[2] === "h";
      for (const mode of match[1]!.split(";").map(Number)) {
        if (RESTORED_MODES.has(mode)) this.modes.set(mode, enabled);
      }
    }
    this.partialSequence = trailingPartialSequence(text);
  }

  restoreSequence(): string {
    let sequence = "";
    for (const [mode, enabled] of this.modes) {
      if (enabled === MODES_ON_BY_DEFAULT.has(mode)) continue;
      sequence += `${ESC}[?${mode}${enabled ? "h" : "l"}`;
    }
    return sequence;
  }
}

function trailingPartialSequence(text: string): string {
  const escape = text.lastIndexOf(ESC);
  if (escape === -1 || text.length - escape > LONGEST_PARTIAL_SEQUENCE) {
    return "";
  }
  return text.slice(escape);
}
