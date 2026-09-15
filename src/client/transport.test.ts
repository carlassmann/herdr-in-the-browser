import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ReconnectingTransport } from "./transport";

const originalFetch = globalThis.fetch;
const originalLocation = globalThis.location;
const originalWebSocket = globalThis.WebSocket;
const originalEventSource = globalThis.EventSource;
const originalWindow = globalThis.window;

const timers = new Map<number, () => void>();
let nextTimer = 0;
beforeEach(() => useFakeConnections());

function advanceTimer(): void {
  const [id, callback] = timers.entries().next().value!;
  timers.delete(id);
  callback();
}

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
  timers.clear();
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
    this.readyState = 3;
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

function failWebSocketTwice(): void {
  FakeWebSocket.opened[0]!.emit("close");
  advanceTimer();
  FakeWebSocket.opened[1]!.emit("close");
}

function useFakeConnections(): void {
  globalThis.PerformanceObserver =
    undefined as unknown as typeof PerformanceObserver;
  Object.defineProperty(globalThis, "location", {
    value: { protocol: "http:", host: "localhost:8787" },
    configurable: true,
  });
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
  globalThis.window = {
    setTimeout: (callback: () => void) => {
      const id = ++nextTimer;
      timers.set(id, callback);
      return id;
    },
    clearTimeout: (id: number) => {
      timers.delete(id);
    },
  } as unknown as Window & typeof globalThis;
}

describe("SSE fallback input", () => {
  test("pipelines a second batch before the first acknowledgement", async () => {
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
    transport.send({ type: "input", data: "c" });
    transport.send({ type: "input", data: "\r" });
    await Promise.resolve();
    expect(posted).toHaveLength(1);

    advanceTimer();
    await secondStarted;
    finishFirst();
    expect(posted.map((body) => JSON.parse(body))).toEqual([
      { type: "input", data: "a" },
      { type: "input", data: "bc\r" },
    ]);
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
    transport.send({ type: "input", data: "stale" });
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

    advanceTimer();
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
    advanceTimer();
    FakeWebSocket.opened[1]!.emit("close");

    expect(FakeWebSocket.opened).toHaveLength(2);
    expect(FakeEventSource.opened[0]?.url).toBe(
      "/api/session/demo/events?cursor=0&cols=100&rows=30",
    );
    expect(states.at(-1)).toBe("connecting");
    transport.close();
  });
});

describe("long-poll fallback", () => {
  test("polls after two SSE attempts end without a message", async () => {
    useFakeConnections();
    const polled: string[] = [];
    const states: string[] = [];
    const received: string[] = [];
    let resolveSecondPoll = () => {};
    const secondPoll = new Promise<void>((resolve) => {
      resolveSecondPoll = resolve;
    });
    globalThis.fetch = ((url) => {
      polled.push(String(url));
      if (polled.length === 1) {
        return Promise.resolve(
          Response.json({
            messages: [
              { type: "status", running: true },
              { type: "sync", cursor: 0, reset: false },
              { type: "output", data: "hi", cursor: 7 },
            ],
          }),
        );
      }
      resolveSecondPoll();
      return new Promise<Response>(() => {});
    }) as typeof fetch;
    const transport = new ReconnectingTransport("demo", {
      onMessage: (message) => received.push(message.type),
      onState: (state) => states.push(state),
      getSize: () => ({ cols: 100, rows: 30 }),
    });

    transport.connect();
    failWebSocketTwice();
    FakeEventSource.opened[0]!.emit("error");
    advanceTimer();
    FakeEventSource.opened[1]!.emit("error");
    await secondPoll;

    expect(FakeEventSource.opened).toHaveLength(2);
    expect(polled).toEqual([
      "/api/session/demo/poll?cursor=0&cols=100&rows=30",
      "/api/session/demo/poll?cursor=7",
    ]);
    expect(received).toEqual(["status", "sync", "output"]);
    expect(states.at(-1)).toBe("connected");
    transport.close();
  });

  test("treats a silent SSE stream as a failed attempt", () => {
    useFakeConnections();
    const transport = new ReconnectingTransport("demo", {
      onMessage() {},
      onState() {},
    });

    transport.connect();
    failWebSocketTwice();
    advanceTimer();
    advanceTimer();

    expect(FakeEventSource.opened).toHaveLength(2);
    transport.close();
  });

  test("stops polling once closed", async () => {
    useFakeConnections();
    let polls = 0;
    let firstPollFinished = () => {};
    const firstPoll = new Promise<void>((resolve) => {
      firstPollFinished = resolve;
    });
    globalThis.fetch = ((_: RequestInfo | URL) => {
      polls += 1;
      firstPollFinished();
      return Promise.resolve(Response.json({ messages: [] }));
    }) as typeof fetch;
    const transport = new ReconnectingTransport("demo", {
      onMessage() {},
      onState() {},
    });

    transport.connect();
    failWebSocketTwice();
    FakeEventSource.opened[0]!.emit("error");
    advanceTimer();
    FakeEventSource.opened[1]!.emit("error");
    await firstPoll;
    transport.close();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const pollsAfterClose = polls;
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(polls).toBe(pollsAfterClose);
  });
});

describe("blocked networks", () => {
  test("starts directly with SSE when requested, then falls back if it stalls", () => {
    Object.defineProperty(globalThis, "location", {
      value: {
        protocol: "http:",
        host: "localhost:8787",
        search: "?transport=sse",
      },
      configurable: true,
    });
    const urls: string[] = [];
    globalThis.fetch = ((url) => {
      urls.push(String(url));
      return new Promise<Response>(() => {});
    }) as typeof fetch;
    const states: string[] = [];
    const transport = new ReconnectingTransport("demo", {
      onMessage() {},
      onState: (state) => states.push(state),
    });
    transport.connect();
    expect(FakeWebSocket.opened).toHaveLength(0);
    expect(FakeEventSource.opened).toHaveLength(1);
    FakeEventSource.opened[0]!.emit("message", {
      data: JSON.stringify({ type: "sync", cursor: 42, reset: false }),
    });
    expect(states.at(-1)).toBe("connected");
    advanceTimer();
    expect(urls).toEqual(["/api/session/demo/poll?cursor=42"]);
    transport.close();
  });

  test("reaches polling without WebSocket or SSE events and keeps it on reconnect", async () => {
    const urls: string[] = [];
    globalThis.fetch = ((url) => {
      urls.push(String(url));
      return new Promise<Response>(() => {});
    }) as typeof fetch;
    const received: string[] = [];
    const transport = new ReconnectingTransport("demo", {
      onMessage: (message) => received.push(message.type),
      onState() {},
    });
    transport.connect();
    for (let attempt = 0; attempt < 6; attempt++) advanceTimer();
    expect(urls).toEqual(["/api/session/demo/poll?cursor=0"]);
    FakeWebSocket.opened[0]!.emit("message", {
      data: JSON.stringify({ type: "output", data: "stale", cursor: 99 }),
    });
    FakeEventSource.opened[0]!.emit("message", {
      data: JSON.stringify({ type: "output", data: "stale", cursor: 99 }),
    });
    expect(received).toEqual([]);
    transport.close();
    transport.connect();
    expect(urls).toHaveLength(2);
    expect(FakeWebSocket.opened).toHaveLength(2);
    expect(FakeEventSource.opened).toHaveLength(2);
    transport.close();
    expect(timers.size).toBe(0);
  });

  test("falls back when an established SSE stream stops delivering heartbeats", () => {
    const urls: string[] = [];
    globalThis.fetch = ((url) => {
      urls.push(String(url));
      return new Promise<Response>(() => {});
    }) as typeof fetch;
    const transport = new ReconnectingTransport("demo", {
      onMessage() {},
      onState() {},
    });
    transport.connect();
    failWebSocketTwice();
    FakeEventSource.opened[0]!.emit("message", {
      data: JSON.stringify({ type: "sync", cursor: 42, reset: false }),
    });
    advanceTimer();
    expect(urls).toEqual(["/api/session/demo/poll?cursor=42"]);
    transport.close();
  });
});
