import { describe, expect, test } from "bun:test";
import { PrivateModeTracker } from "./terminal-modes";

const ESC = String.fromCharCode(27);
const mode = (number: number, enabled: boolean) =>
  `${ESC}[?${number}${enabled ? "h" : "l"}`;

describe("private mode restoration", () => {
  test("re-enables modes that a truncated replay would have lost", () => {
    const tracker = new PrivateModeTracker();
    tracker.observe(`${mode(1049, true)}${ESC}[?1000;1002;1006hdrawn frame`);

    expect(tracker.restoreSequence()).toBe(
      mode(1049, true) + mode(1000, true) + mode(1002, true) + mode(1006, true),
    );
  });

  test("tracks the latest state across chunk boundaries", () => {
    const tracker = new PrivateModeTracker();
    tracker.observe(`${mode(1006, true)}${ESC}[?10`);
    tracker.observe(`06l${mode(1000, true)}`);
    tracker.observe(mode(1000, false));

    expect(tracker.restoreSequence()).toBe("");
  });

  test("restores modes that default to on only when they are off", () => {
    const tracker = new PrivateModeTracker();
    tracker.observe(mode(25, false));
    expect(tracker.restoreSequence()).toBe(mode(25, false));

    tracker.observe(mode(25, true));
    expect(tracker.restoreSequence()).toBe("");
  });

  test("ignores transient synchronized-output toggles", () => {
    const tracker = new PrivateModeTracker();
    tracker.observe(`${mode(2026, true)}frame${mode(2026, false)}`);

    expect(tracker.restoreSequence()).toBe("");
  });
});
