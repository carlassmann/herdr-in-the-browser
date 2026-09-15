const BEL = "\u0007";
const ESC = "\u001b";
const STRING_TERMINATOR_TAIL = "\\";
const LONGEST_PARTIAL_SEQUENCE = 4096;

// Notifications reach the terminal as OSC escape sequences it does not render:
// OSC 9 carries a single message, OSC 777 a title and a body. A bell only rings
// outside such a sequence, where it is not a terminator.
export class TerminalAlertScanner {
  private partialSequence = "";

  // The browser only answers with a sound, so the alerts are counted, not read.
  scan(output: string): number {
    const text = this.partialSequence + output;
    let alerts = 0;
    let sequenceStart = this.partialSequence ? 0 : -1;
    this.partialSequence = "";

    for (let index = 0; index < text.length; index++) {
      const character = text[index];
      const terminated =
        character === BEL ||
        (character === ESC && text[index + 1] === STRING_TERMINATOR_TAIL);

      if (sequenceStart === -1) {
        if (character === BEL) alerts += 1;
        else if (character === ESC && text[index + 1] === "]") {
          sequenceStart = index;
          index += 1;
        }
        continue;
      }
      if (!terminated) continue;

      if (isNotification(text.slice(sequenceStart + 2, index))) alerts += 1;
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

function isNotification(payload: string): boolean {
  const [command = "", ...rest] = payload.split(";");
  if (command === "9") return rest.join(";").length > 0;
  return command === "777" && rest[0] === "notify" && Boolean(rest[1]);
}
