import { describe, expect, test } from "bun:test";
import {
  attachQuery,
  clampTerminalSize,
  isClientMessage,
  isServerMessage,
  parseAttachQuery,
  sessionEndpoint,
  timing,
} from "./protocol";

describe("attach query", () => {
  test("round-trips cursor and size", () => {
    const query = attachQuery({ cursor: 42, size: { cols: 100, rows: 30 } });
    expect(query).toBe("cursor=42&cols=100&rows=30");
    expect(parseAttachQuery(new URLSearchParams(query))).toEqual({
      cursor: 42,
      size: { cols: 100, rows: 30 },
    });
  });

  test("leaves the size out unless both dimensions are given", () => {
    expect(parseAttachQuery(new URLSearchParams("cursor=7"))).toEqual({
      cursor: 7,
    });
    expect(parseAttachQuery(new URLSearchParams("cursor=7&cols=80"))).toEqual({
      cursor: 7,
    });
  });

  test("falls back to the start for a cursor it cannot trust", () => {
    expect(parseAttachQuery(new URLSearchParams("cursor=-1")).cursor).toBe(0);
    expect(parseAttachQuery(new URLSearchParams("cursor=abc")).cursor).toBe(0);
    expect(parseAttachQuery(new URLSearchParams()).cursor).toBe(0);
  });

  test("clamps sizes into the PTY's range", () => {
    expect(clampTerminalSize({ cols: 1, rows: 0 })).toEqual({
      cols: 2,
      rows: 1,
    });
    expect(clampTerminalSize({ cols: 9999, rows: 9999 })).toEqual({
      cols: 500,
      rows: 300,
    });
    expect(clampTerminalSize({ cols: NaN, rows: 24.7 })).toEqual({
      cols: 2,
      rows: 24,
    });
  });
});

describe("wire messages", () => {
  test("recognizes client messages", () => {
    expect(isClientMessage({ type: "input", data: "x" })).toBe(true);
    expect(isClientMessage({ type: "resize", cols: 80, rows: 24 })).toBe(true);
    expect(isClientMessage({ type: "resize", cols: "80" })).toBe(false);
    expect(isClientMessage({ type: "output", data: "x" })).toBe(false);
    expect(isClientMessage(null)).toBe(false);
  });

  test("recognizes server messages and rejects malformed ones", () => {
    expect(isServerMessage({ type: "status", running: false })).toBe(true);
    expect(isServerMessage({ type: "sync", cursor: 1, reset: true })).toBe(
      true,
    );
    expect(isServerMessage({ type: "notify" })).toBe(true);
    expect(isServerMessage({ type: "clipboard", text: "t" })).toBe(true);
    expect(isServerMessage({ type: "output", data: "x" })).toBe(false);
    expect(isServerMessage({ type: "status" })).toBe(false);
    expect(isServerMessage({ type: "unknown" })).toBe(false);
  });

  test("builds session endpoints with an escaped id", () => {
    expect(sessionEndpoint("a b", "poll")).toBe("/api/session/a%20b/poll");
  });
});

describe("timing contract", () => {
  test("the client outlasts the server's silence on every transport", () => {
    expect(timing.sseIdleTimeoutMs).toBeGreaterThan(2 * timing.sseKeepAliveMs);
    expect(timing.longPollAbortMs).toBeGreaterThan(timing.longPollTimeoutMs);
  });
});
