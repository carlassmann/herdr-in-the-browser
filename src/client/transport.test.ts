import { afterEach, describe, expect, test } from "bun:test";
import { ReconnectingTransport } from "./transport";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("SSE fallback input", () => {
  test("waits for each POST before sending the next", async () => {
    const posted: string[] = [];
    let finishFirst = () => {};
    let markSecondStarted = () => {};
    const secondStarted = new Promise<void>((resolve) => {
      markSecondStarted = resolve;
    });
    globalThis.fetch = ((_, init) => {
      posted.push(String(init?.body));
      if (posted.length > 1) {
        markSecondStarted();
        return Promise.resolve(new Response());
      }
      return new Promise<Response>((resolve) => {
        finishFirst = () => resolve(new Response());
      });
    }) as typeof fetch;
    const transport = new ReconnectingTransport("demo", {
      onMessage() {},
      onState() {},
      onFreshConnection() {},
    });

    transport.send({ type: "input", data: "a" });
    transport.send({ type: "input", data: "b" });
    await Promise.resolve();
    expect(posted).toHaveLength(1);

    finishFirst();
    await secondStarted;
    expect(posted).toHaveLength(2);
  });
});
