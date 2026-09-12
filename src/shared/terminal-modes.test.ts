import { describe, expect, test } from "bun:test";
import { TerminalModeTracker } from "./terminal-modes";

const ESC = String.fromCharCode(27);
const mode = (number: number, enabled: boolean) =>
  `${ESC}[?${number}${enabled ? "h" : "l"}`;
const kittyPush = (flags: number) => `${ESC}[>${flags}u`;
const kittyPop = (count = 1) => `${ESC}[<${count}u`;

describe("private mode restoration", () => {
  test("re-enables modes that a truncated replay would have lost", () => {
    const tracker = new TerminalModeTracker();
    tracker.observe(`${mode(1049, true)}${ESC}[?1000;1002;1006hdrawn frame`);

    expect(tracker.restoreSequence()).toBe(
      mode(1049, true) + mode(1000, true) + mode(1002, true) + mode(1006, true),
    );
  });

  test("tracks the latest state across chunk boundaries", () => {
    const tracker = new TerminalModeTracker();
    tracker.observe(`${mode(1006, true)}${ESC}[?10`);
    tracker.observe(`06l${mode(1000, true)}`);
    tracker.observe(mode(1000, false));

    expect(tracker.restoreSequence()).toBe("");
  });

  test("does not re-apply a complete sequence followed by short text", () => {
    const tracker = new TerminalModeTracker();
    tracker.observe(`${kittyPush(1)}$ `);
    tracker.observe("ls\r\n");

    expect(tracker.kittyFlags).toBe(1);
    expect(tracker.restoreSequence()).toBe(kittyPush(1));
  });

  test("restores modes that default to on only when they are off", () => {
    const tracker = new TerminalModeTracker();
    tracker.observe(mode(25, false));
    expect(tracker.restoreSequence()).toBe(mode(25, false));

    tracker.observe(mode(25, true));
    expect(tracker.restoreSequence()).toBe("");
  });

  test("ignores transient synchronized-output toggles", () => {
    const tracker = new TerminalModeTracker();
    tracker.observe(`${mode(2026, true)}frame${mode(2026, false)}`);

    expect(tracker.restoreSequence()).toBe("");
  });
});

describe("kitty keyboard protocol tracking", () => {
  test("follows push, set, and pop of the flag stack", () => {
    const tracker = new TerminalModeTracker();
    tracker.observe(kittyPush(1));
    expect(tracker.kittyFlags).toBe(1);

    tracker.observe(`${ESC}[=8;2u`);
    expect(tracker.kittyFlags).toBe(9);
    tracker.observe(`${ESC}[=1;3u`);
    expect(tracker.kittyFlags).toBe(8);

    tracker.observe(kittyPush(31));
    tracker.observe(kittyPop());
    expect(tracker.kittyFlags).toBe(8);
    tracker.observe(kittyPop());
    expect(tracker.kittyFlags).toBe(0);
  });

  test("a pop larger than the stack clears it", () => {
    const tracker = new TerminalModeTracker();
    tracker.observe(kittyPush(1) + kittyPush(3) + kittyPop(100));

    expect(tracker.kittyFlags).toBe(0);
    expect(tracker.restoreSequence()).toBe("");
  });

  test("keeps separate stacks for the main and alternate screens", () => {
    const tracker = new TerminalModeTracker();
    tracker.observe(kittyPush(1));
    tracker.observe(mode(1049, true) + kittyPush(15));
    expect(tracker.kittyFlags).toBe(15);

    tracker.observe(kittyPop() + mode(1049, false));
    expect(tracker.kittyFlags).toBe(1);
  });

  test("replays the stacks of both screens in order", () => {
    const tracker = new TerminalModeTracker();
    tracker.observe(kittyPush(1) + mode(1049, true) + kittyPush(15));

    expect(tracker.restoreSequence()).toBe(
      kittyPush(1) + mode(1049, true) + kittyPush(15),
    );
  });

  test("restores flags set without a push", () => {
    const tracker = new TerminalModeTracker();
    tracker.observe(`${ESC}[=5;1u`);

    expect(tracker.restoreSequence()).toBe(`${ESC}[=5;1u`);
  });

  test("reset forgets everything", () => {
    const tracker = new TerminalModeTracker();
    tracker.observe(kittyPush(1) + mode(1049, true) + `${ESC}[>4;2m`);
    tracker.reset();

    expect(tracker.kittyFlags).toBe(0);
    expect(tracker.modifyOtherKeys).toBe(false);
    expect(tracker.restoreSequence()).toBe("");
  });
});

describe("modifyOtherKeys tracking", () => {
  test("enables on level 2 and disables on reset", () => {
    const tracker = new TerminalModeTracker();
    tracker.observe(`${ESC}[>4;2m`);
    expect(tracker.modifyOtherKeys).toBe(true);
    expect(tracker.restoreSequence()).toBe(`${ESC}[>4;2m`);

    tracker.observe(`${ESC}[>4;1m`);
    expect(tracker.modifyOtherKeys).toBe(false);

    tracker.observe(`${ESC}[>4;2m${ESC}[>4m`);
    expect(tracker.modifyOtherKeys).toBe(false);
  });
});
