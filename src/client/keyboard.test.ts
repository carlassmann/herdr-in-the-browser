import { describe, expect, test } from "bun:test";
import { encodeModifiedInput } from "./keyboard";

describe("mobile terminal modifiers", () => {
  test("encodes Ctrl+C and Ctrl+B as terminal control bytes", () => {
    expect(encodeModifiedInput("c", { control: true, alt: false })).toBe(
      "\u0003",
    );
    expect(encodeModifiedInput("B", { control: true, alt: false })).toBe(
      "\u0002",
    );
  });

  test("prefixes Alt input with escape", () => {
    expect(encodeModifiedInput("x", { control: false, alt: true })).toBe(
      "\u001bx",
    );
  });
});
