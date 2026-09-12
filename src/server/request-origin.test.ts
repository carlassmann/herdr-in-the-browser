import { describe, expect, test } from "bun:test";
import { isTrustedRequest, parsePublicHosts } from "./request-origin";

describe("request origin guard", () => {
  test("accepts loopback hosts with and without a port", () => {
    for (const host of [
      "localhost:8787",
      "127.0.0.1:8787",
      "[::1]",
      "[::1]:8787",
    ]) {
      expect(isTrustedRequest({ host, origin: null })).toBe(true);
    }
  });

  test("rejects a rebound host even when Origin matches it", () => {
    expect(
      isTrustedRequest({
        host: "evil.example:8787",
        origin: "http://evil.example:8787",
      }),
    ).toBe(false);
  });

  test("accepts a configured public host", () => {
    const publicHosts = parsePublicHosts(" herdr.example.com , other.example ");
    expect(
      isTrustedRequest(
        { host: "herdr.example.com", origin: "https://herdr.example.com" },
        publicHosts,
      ),
    ).toBe(true);
  });

  test("rejects a cross-origin request to an allowed host", () => {
    expect(
      isTrustedRequest({
        host: "127.0.0.1:8787",
        origin: "http://evil.example",
      }),
    ).toBe(false);
  });

  test("rejects a missing or unparsable header", () => {
    expect(isTrustedRequest({ host: null, origin: null })).toBe(false);
    expect(isTrustedRequest({ host: "localhost", origin: "not a url" })).toBe(
      false,
    );
  });
});
