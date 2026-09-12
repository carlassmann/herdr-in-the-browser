import { afterEach, describe, expect, test } from "bun:test";
import { ReconnectingTransport } from "./transport";

const originalFetch = globalThis.fetch;
const originalLocation = globalThis.location;
const originalWebSocket = globalThis.WebSocket;
const originalEventSource = globalThis.EventSource;
const originalWindow = globalThis.window;

afterEach(() => {
  globalThis.fetch = originalFetch;
  Object.defineProperty(globalThis, "location", {
    value: originalLocation,
    configurable: true,
    writable: true,
  });
  globalThis.WebSocket = originalWebSocket;
  globalThis.EventSource = originalEventSource;
  globalThis.window = originalWindow;
  FakeWebSocket.opened = [];
  FakeEventSource.opened = [];
});

class FakeEventTarget {
  private readonly listeners = new Map<string, Array<(event: never) => void>>();

  addEventListener(type: string, listener: (event: never) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  emit(type: string, event: unknown = {}): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event as never);
    }
  }
}

class FakeWebSocket extends FakeEventTarget {
  static opened: FakeWebSocket[] = [];
  static readonly OPEN = 1;
  readyState = 0;

  constructor(readonly url: string) {
    super();
    FakeWebSocket.opened.push(this);
  }

  close(): void {
    this.emit("close");
  }
}

class FakeEventSource extends FakeEventTarget {
  static opened: FakeEventSource[] = [];

  constructor(readonly url: string) {
    super();
    FakeEventSource.opened.push(this);
  }

  close(): void {}
}

function useFakeConnections(): void {
  Object.defineProperty(globalThis, "location", {
    value: { protocol: "http:", host: "localhost:8787" },
    configurable: true,
  });
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
  globalThis.window = {
    setTimeout: (callback: () => void) => {
      callback();
      return 0;
    },
    clearTimeout: () => {},
  } as unknown as Window & typeof globalThis;
}

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
    });

    transport.send({ type: "input", data: "a" });
    transport.send({ type: "input", data: "b" });
    await Promise.resolve();
    expect(posted).toHaveLength(1);

    finishFirst();
    await secondStarted;
    expect(posted).toHaveLength(2);
  });

  test("aborts an in-flight POST before reconnecting", async () => {
    let markFirstStarted = () => {};
    let markSecondStarted = () => {};
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const secondStarted = new Promise<void>((resolve) => {
      markSecondStarted = resolve;
    });
    let requests = 0;
    globalThis.fetch = ((_, init) => {
      requests += 1;
      if (requests > 1) {
        markSecondStarted();
        return Promise.resolve(new Response());
      }
      markFirstStarted();
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new Error("aborted")),
        );
      });
    }) as typeof fetch;
    Object.defineProperty(globalThis, "location", {
      value: { protocol: "http:", host: "localhost" },
      configurable: true,
    });
    class ConnectingWebSocket {
      static readonly OPEN = 1;
      readonly readyState = 0;
      addEventListener() {}
      close() {}
    }
    globalThis.WebSocket = ConnectingWebSocket as unknown as typeof WebSocket;
    const transport = new ReconnectingTransport("demo", {
      onMessage() {},
      onState() {},
    });

    transport.send({ type: "input", data: "before" });
    await firstStarted;
    transport.connect();
    transport.send({ type: "input", data: "after" });

    await secondStarted;
    expect(requests).toBe(2);
  });
});

describe("reconnection", () => {
  test("resumes from the last cursor it received", () => {
    useFakeConnections();
    const transport = new ReconnectingTransport("demo", {
      onMessage() {},
      onState() {},
    });

    transport.connect();
    const socket = FakeWebSocket.opened[0]!;
    expect(socket.url).toContain("cursor=0");
    socket.emit("open");
    socket.emit("message", {
      data: JSON.stringify({ type: "output", data: "hi", cursor: 42 }),
    });
    socket.emit("close");

    expect(FakeWebSocket.opened[1]?.url).toContain("cursor=42");
    transport.close();
  });

  test("falls back to SSE after two failed WebSocket opens", () => {
    useFakeConnections();
    const states: string[] = [];
    const transport = new ReconnectingTransport("demo", {
      onMessage() {},
      onState: (state) => states.push(state),
      getSize: () => ({ cols: 100, rows: 30 }),
    });

    transport.connect();
    FakeWebSocket.opened[0]!.emit("close");
    FakeWebSocket.opened[1]!.emit("close");

    expect(FakeWebSocket.opened).toHaveLength(2);
    expect(FakeEventSource.opened[0]?.url).toBe(
      "/api/session/demo/events?cursor=0&cols=100&rows=30",
    );
    expect(states.at(-1)).toBe("connecting");
    transport.close();
  });
});
