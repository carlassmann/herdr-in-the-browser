import { describe, expect, test } from "bun:test";
import { TerminalAlertScanner } from "./terminal-notifications";

const BEL = "\u0007";
const ESC = "\u001b";

describe("TerminalAlertScanner", () => {
  test("reports a standalone bell", () => {
    expect(new TerminalAlertScanner().scan(`done${BEL}`)).toBe(1);
  });

  test("ignores the bell that terminates a window title", () => {
    expect(
      new TerminalAlertScanner().scan(`${ESC}]0;host: ~${BEL}prompt`),
    ).toBe(0);
  });

  test("counts an OSC 9 notification", () => {
    expect(
      new TerminalAlertScanner().scan(`${ESC}]9;agent ready: hello${BEL}`),
    ).toBe(1);
  });

  test("counts an OSC 777 notification closed by a string terminator", () => {
    expect(
      new TerminalAlertScanner().scan(`${ESC}]777;notify;Claude;done${ESC}\\`),
    ).toBe(1);
  });

  test("joins a notification split across chunks", () => {
    const scanner = new TerminalAlertScanner();
    expect(scanner.scan(`${ESC}]9;agent`)).toBe(0);
    expect(scanner.scan(` ready${BEL}`)).toBe(1);
  });

  test("keeps scanning after an unterminated sequence grows too long", () => {
    const scanner = new TerminalAlertScanner();
    scanner.scan(`${ESC}]9;${"x".repeat(5000)}`);
    expect(scanner.scan(`${BEL}`)).toBe(1);
  });

  test("ignores other OSC commands", () => {
    expect(new TerminalAlertScanner().scan(`${ESC}]8;;https://x${BEL}`)).toBe(
      0,
    );
  });
});
