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

  test("encodes the non-letter control characters", () => {
    const control = { control: true, alt: false };
    expect(encodeModifiedInput(" ", control)).toBe("\u0000");
    expect(encodeModifiedInput("@", control)).toBe("\u0000");
    expect(encodeModifiedInput("[", control)).toBe("\u001b");
    expect(encodeModifiedInput("\\", control)).toBe("\u001c");
    expect(encodeModifiedInput("]", control)).toBe("\u001d");
    expect(encodeModifiedInput("^", control)).toBe("\u001e");
    expect(encodeModifiedInput("_", control)).toBe("\u001f");
    expect(encodeModifiedInput("?", control)).toBe("\u007f");
  });

  test("leaves input without a control mapping unchanged", () => {
    expect(encodeModifiedInput("5", { control: true, alt: false })).toBe("5");
  });

  test("combines Ctrl and Alt", () => {
    expect(encodeModifiedInput("[", { control: true, alt: true })).toBe(
      "\u001b\u001b",
    );
  });

  test("prefixes Alt input with escape", () => {
    expect(encodeModifiedInput("x", { control: false, alt: true })).toBe(
      "\u001bx",
    );
  });
});
