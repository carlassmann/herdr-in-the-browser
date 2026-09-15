const BEL = "\u0007";
const ESC = "\u001b";
const STRING_TERMINATOR_TAIL = "\\";
const LONGEST_PARTIAL_SEQUENCE = 4096;

export type TerminalAlert =
  { kind: "bell" } | { kind: "message"; title: string; body: string };

// Desktop notifications reach the browser as OSC escape sequences the terminal
// itself ignores: OSC 9 carries a single message, OSC 777 a title and a body.
// A bell only rings outside such a sequence, where it is not a terminator.
export class TerminalAlertScanner {
  private partialSequence = "";

  scan(output: string): TerminalAlert[] {
    const text = this.partialSequence + output;
    const alerts: TerminalAlert[] = [];
    let sequenceStart = this.partialSequence ? 0 : -1;
    this.partialSequence = "";

    for (let index = 0; index < text.length; index++) {
      const character = text[index];
      const terminated =
        character === BEL ||
        (character === ESC && text[index + 1] === STRING_TERMINATOR_TAIL);

      if (sequenceStart === -1) {
        if (character === BEL) alerts.push({ kind: "bell" });
        else if (character === ESC && text[index + 1] === "]") {
          sequenceStart = index;
          index += 1;
        }
        continue;
      }
      if (!terminated) continue;

      const alert = parseStringSequence(text.slice(sequenceStart + 2, index));
      if (alert) alerts.push(alert);
      if (character === ESC) index += 1;
      sequenceStart = -1;
    }

    if (sequenceStart !== -1) {
      const unfinished = text.slice(sequenceStart);
      if (unfinished.length <= LONGEST_PARTIAL_SEQUENCE) {
        this.partialSequence = unfinished;
      }
    }
    return alerts;
  }

  reset(): void {
    this.partialSequence = "";
  }
}

function parseStringSequence(payload: string): TerminalAlert | undefined {
  const [command = "", ...rest] = payload.split(";");
  if (command === "9") {
    const title = rest.join(";");
    return title ? { kind: "message", title, body: "" } : undefined;
  }
  if (command === "777" && rest[0] === "notify") {
    const [, title = "", ...body] = rest;
    return title ? { kind: "message", title, body: body.join(";") } : undefined;
  }
  return undefined;
}
