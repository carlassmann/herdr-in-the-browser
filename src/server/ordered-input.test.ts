import { describe, expect, test } from "bun:test";
import { OrderedInput } from "./ordered-input";
import type { ClientMessage } from "../shared/protocol";

describe("ordered HTTP input", () => {
  test("orders overlapping arrivals and does not apply duplicate requests twice", async () => {
    const applied: ClientMessage[] = [];
    const input = new OrderedInput((message) => applied.push(message));
    const later = input.receive("browser", 1, { type: "input", data: "b" });
    expect(applied).toEqual([]);
    const duplicate = input.receive("browser", 1, { type: "input", data: "b" });
    await input.receive("browser", 0, { type: "input", data: "a" });
    await Promise.all([later, duplicate]);
    await input.receive("browser", 0, { type: "input", data: "a" });
    expect(applied).toEqual([
      { type: "input", data: "a" },
      { type: "input", data: "b" },
    ]);
    await input.receive("other", 0, { type: "resize", cols: 100, rows: 30 });
    expect(applied.at(-1)).toEqual({ type: "resize", cols: 100, rows: 30 });
  });

  test("rejects a missing predecessor instead of applying later keys out of order", async () => {
    const applied: ClientMessage[] = [];
    const input = new OrderedInput((message) => applied.push(message), 5);
    await expect(
      input.receive("browser", 1, { type: "input", data: "b" }),
    ).rejects.toThrow("interrupted");
    await expect(
      input.receive("browser", 0, { type: "input", data: "a" }),
    ).rejects.toThrow("interrupted");
    await expect(
      input.receive("unknown", 4, { type: "input", data: "x" }),
    ).rejects.toThrow();
    expect(applied).toEqual([]);
  });
});
