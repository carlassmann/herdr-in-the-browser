import { describe, expect, test } from "bun:test";
import { DiagnosticsStore } from "./diagnostics";

const sample = {
  id: "browser.1",
  operation: "poll",
  transport: "poll",
  status: 200,
  requestMs: 25_300,
  serverMs: 25_000,
  firstByteMs: 25_200,
  transferMs: 80,
  protocol: "h2",
};

describe("server diagnostics", () => {
  test("joins reports by request, separates long-poll wait, and isolates browsers", () => {
    const store = new DiagnosticsStore();
    store.recordServer(
      "demo",
      "browser",
      "browser.1",
      "poll",
      "poll",
      200,
      25_000,
    );
    store.recordClient("demo", "browser", [sample]);
    store.recordClient("demo", "browser", [sample]);
    store.recordClient("demo", "second", [
      { ...sample, id: "second.1", requestMs: 25_500 },
    ]);
    const result = store.snapshot("demo");
    expect(result.clients).toHaveLength(2);
    const group = result.clients[0]!.groups[0]!;
    expect(group.requests).toBe(1);
    expect(group.metrics.serverMs?.p95).toBe(25_000);
    expect(group.metrics.overheadMs?.p95).toBe(300);
    expect(group.metrics.firstByteOverheadMs?.p95).toBe(200);
    expect(group.metrics.transferMs?.p95).toBe(80);
    expect(group.protocols).toEqual(["h2"]);
    expect(result.clients[1]!.groups[0]!.metrics.overheadMs?.p95).toBe(500);
    expect(store.snapshot("another").clients).toEqual([]);
  });

  test("rejects malformed metrics, strips arbitrary data, and bounds retained requests", () => {
    const store = new DiagnosticsStore();
    expect(
      store.recordClient("demo", "browser", [{ ...sample, requestMs: NaN }]),
    ).toBe(false);
    expect(
      store.recordClient("demo", "browser", [{ ...sample, queueMs: -1 }]),
    ).toBe(false);
    expect(
      store.recordClient("demo", "browser", [{ ...sample, id: "another.1" }]),
    ).toBe(false);
    expect(store.recordClient("demo", "browser", Array(65).fill(sample))).toBe(
      false,
    );
    for (let id = 1; id <= 520; id++)
      store.recordClient("demo", "browser", [
        { ...sample, id: `browser.${id}`, data: "must not store" },
      ]);
    const result = store.snapshot();
    expect(result.clients[0]!.groups[0]!.requests).toBe(512);
    expect(JSON.stringify(result)).not.toContain("must not store");
    expect(result.clients[0]!.recent.at(-1)?.id).toBe("browser.520");
  });

  test("includes HTTP errors and requests never reported by the browser", () => {
    const store = new DiagnosticsStore();
    store.recordServer("demo", "browser", "browser.1", "input", "sse", 403, 2);
    store.recordClient("demo", "browser", [
      {
        ...sample,
        id: "browser.2",
        operation: "input",
        transport: "sse",
        status: 0,
        requestMs: 10_000,
        serverMs: undefined,
      },
    ]);
    const group = store.snapshot().clients[0]!.groups[0]!;
    expect(group.requests).toBe(2);
    expect(group.completedReports).toBe(1);
    expect(group.failures).toBe(2);
    expect(group.metrics.serverMs?.count).toBe(1);
    expect(group.metrics.overheadMs).toBeNull();
  });
});
