const BEL = "";
const ESC = "";
const STRING_TERMINATOR_TAIL = "\\";
// A clipboard write carries the whole selection as base64, so one sequence can
// span many output chunks before it terminates.
const LONGEST_PARTIAL_SEQUENCE = 1024 * 1024;

// The terminal renderer draws nothing for these, but the browser can act on
// them: a bell or an OSC 9/777 notification becomes a sound, and an OSC 52
// write lands in the clipboard.
export type TerminalSidebandEvent =
  | { kind: "alert" }
  | { kind: "clipboard"; text: string };

export class TerminalSidebandScanner {
  private partialSequence = "";

  scan(output: string): TerminalSidebandEvent[] {
    const text = this.partialSequence + output;
    const events: TerminalSidebandEvent[] = [];
    let sequenceStart = this.partialSequence ? 0 : -1;
    this.partialSequence = "";

    for (let index = 0; index < text.length; index++) {
      const character = text[index];
      const terminated =
        character === BEL ||
        (character === ESC && text[index + 1] === STRING_TERMINATOR_TAIL);

      if (sequenceStart === -1) {
        // A bell only rings outside a sequence, where it is not a terminator.
        if (character === BEL) events.push({ kind: "alert" });
        else if (character === ESC && text[index + 1] === "]") {
          sequenceStart = index;
          index += 1;
        }
        continue;
      }
      if (!terminated) continue;

      const event = interpret(text.slice(sequenceStart + 2, index));
      if (event) events.push(event);
      if (character === ESC) index += 1;
      sequenceStart = -1;
    }

    if (sequenceStart !== -1) {
      const unfinished = text.slice(sequenceStart);
      if (unfinished.length <= LONGEST_PARTIAL_SEQUENCE) {
        this.partialSequence = unfinished;
      }
    }
    return events;
  }

  reset(): void {
    this.partialSequence = "";
  }
}

function interpret(payload: string): TerminalSidebandEvent | undefined {
  const [command = "", ...rest] = payload.split(";");
  if (command === "9") {
    return rest.join(";").length > 0 ? { kind: "alert" } : undefined;
  }
  if (command === "777") {
    return rest[0] === "notify" && rest[1] ? { kind: "alert" } : undefined;
  }
  if (command === "52") return clipboardWrite(rest[1]);
  return undefined;
}

// OSC 52 is `52;<selection>;<base64>`. A `?` payload asks to read the
// clipboard back, which the browser will not answer.
function clipboardWrite(
  encoded: string | undefined,
): TerminalSidebandEvent | undefined {
  if (!encoded || encoded === "?") return undefined;
  try {
    const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
    return { kind: "clipboard", text: new TextDecoder().decode(bytes) };
  } catch {
    return undefined;
  }
}
