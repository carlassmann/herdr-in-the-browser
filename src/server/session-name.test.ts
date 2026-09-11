import { describe, expect, test } from "bun:test";
import { validateSessionName } from "./session-name";

describe("Herdr session names", () => {
  test("accepts CLI-safe names and rejects shell-like input", () => {
    expect(() => validateSessionName("feature-auth_2.1")).not.toThrow();
    expect(() => validateSessionName("bad name")).toThrow();
    expect(() => validateSessionName("$(touch nope)")).toThrow();
  });
});
