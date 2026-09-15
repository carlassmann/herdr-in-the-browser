import { describe, expect, test } from "bun:test";
import { TerminalAlertScanner } from "./terminal-notifications";

const BEL = "\u0007";
const ESC = "\u001b";

describe("TerminalAlertScanner", () => {
  test("reports a standalone bell", () => {
    expect(new TerminalAlertScanner().scan(`done${BEL}`)).toEqual([
      { kind: "bell" },
    ]);
  });

  test("ignores the bell that terminates a window title", () => {
    expect(
      new TerminalAlertScanner().scan(`${ESC}]0;cbook: ~${BEL}prompt`),
    ).toEqual([]);
  });

  test("reads an OSC 9 notification", () => {
    expect(
      new TerminalAlertScanner().scan(`${ESC}]9;agent ready: hello${BEL}`),
    ).toEqual([{ kind: "message", title: "agent ready: hello", body: "" }]);
  });

  test("reads an OSC 777 notification closed by a string terminator", () => {
    expect(
      new TerminalAlertScanner().scan(`${ESC}]777;notify;Claude;done${ESC}\\`),
    ).toEqual([{ kind: "message", title: "Claude", body: "done" }]);
  });

  test("joins a notification split across chunks", () => {
    const scanner = new TerminalAlertScanner();
    expect(scanner.scan(`${ESC}]9;agent`)).toEqual([]);
    expect(scanner.scan(` ready${BEL}`)).toEqual([
      { kind: "message", title: "agent ready", body: "" },
    ]);
  });

  test("keeps scanning after an unterminated sequence grows too long", () => {
    const scanner = new TerminalAlertScanner();
    scanner.scan(`${ESC}]9;${"x".repeat(5000)}`);
    expect(scanner.scan(`${BEL}`)).toEqual([{ kind: "bell" }]);
  });

  test("ignores other OSC commands", () => {
    expect(
      new TerminalAlertScanner().scan(`${ESC}]8;;https://x${BEL}`),
    ).toEqual([]);
  });
});
