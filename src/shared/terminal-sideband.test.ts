import { describe, expect, test } from "bun:test";
import { TerminalSidebandScanner } from "./terminal-sideband";

const BEL = "";
const ESC = "";
const alert = { kind: "alert" } as const;

const encode = (text: string) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(text)));

describe("TerminalSidebandScanner", () => {
  test("reports a standalone bell", () => {
    expect(new TerminalSidebandScanner().scan(`done${BEL}`)).toEqual([alert]);
  });

  test("ignores the bell that terminates a window title", () => {
    expect(
      new TerminalSidebandScanner().scan(`${ESC}]0;host: ~${BEL}prompt`),
    ).toEqual([]);
  });

  test("reports an OSC 9 notification", () => {
    expect(
      new TerminalSidebandScanner().scan(`${ESC}]9;agent ready: hello${BEL}`),
    ).toEqual([alert]);
  });

  test("reports an OSC 777 notification closed by a string terminator", () => {
    expect(
      new TerminalSidebandScanner().scan(
        `${ESC}]777;notify;Claude;done${ESC}\\`,
      ),
    ).toEqual([alert]);
  });

  test("joins a notification split across chunks", () => {
    const scanner = new TerminalSidebandScanner();
    expect(scanner.scan(`${ESC}]9;agent`)).toEqual([]);
    expect(scanner.scan(` ready${BEL}`)).toEqual([alert]);
  });

  test("keeps scanning after an unterminated sequence grows too long", () => {
    const scanner = new TerminalSidebandScanner();
    scanner.scan(`${ESC}]9;${"x".repeat(2 * 1024 * 1024)}`);
    expect(scanner.scan(`${BEL}`)).toEqual([alert]);
  });

  test("ignores other OSC commands", () => {
    expect(
      new TerminalSidebandScanner().scan(`${ESC}]8;;https://x${BEL}`),
    ).toEqual([]);
  });

  test("decodes an OSC 52 clipboard write", () => {
    expect(
      new TerminalSidebandScanner().scan(
        `${ESC}]52;c;${encode("héllo\nwörld")}${BEL}`,
      ),
    ).toEqual([{ kind: "clipboard", text: "héllo\nwörld" }]);
  });

  test("joins a clipboard write split across chunks", () => {
    const scanner = new TerminalSidebandScanner();
    const encoded = encode("x".repeat(10_000));
    expect(scanner.scan(`${ESC}]52;c;${encoded.slice(0, 5000)}`)).toEqual([]);
    expect(scanner.scan(`${encoded.slice(5000)}${ESC}\\`)).toEqual([
      { kind: "clipboard", text: "x".repeat(10_000) },
    ]);
  });

  test("ignores clipboard queries and malformed payloads", () => {
    expect(
      new TerminalSidebandScanner().scan(
        `${ESC}]52;c;?${BEL}${ESC}]52;c;not base64!${BEL}${ESC}]52;c${BEL}`,
      ),
    ).toEqual([]);
  });
});
