import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ReconnectingTransport } from "./transport";

const originalFetch = globalThis.fetch;
const originalLocation = globalThis.location;
const originalWebSocket = globalThis.WebSocket;
const originalEventSource = globalThis.EventSource;
const originalWindow = globalThis.window;

const timers = new Map<number, { callback: () => void; delay: number }>();
const delays: number[] = [];
let nextTimer = 0;
beforeEach(() => useFakeConnections());

function advanceTimer(): void {
  const [id, { callback }] = timers.entries().next().value!;
  timers.delete(id);
  callback();
}

// Input pacing waits 50 ms; connection and retry timers wait far longer.
function advanceSendTimer(): void {
  const [id, { callback }] = [...timers.entries()].find(
    ([, timer]) => timer.delay < 500,
  )!;
  timers.delete(id);
  callback();
}

async function microtasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// A WebSocket that never opens, so input takes the POST path.
class ConnectingWebSocket {
  static readonly OPEN = 1;
  readonly readyState = 0;
  addEventListener() {}
  close() {}
}

function connectWebSocket(index: number): void {
  FakeWebSocket.opened[index]!.emit("message", {
    data: JSON.stringify({ type: "status", running: true }),
  });
}

function hangUntilAborted(signal?: AbortSignal | null): Promise<Response> {
  return new Promise<Response>((_, reject) =>
    signal?.addEventListener("abort", () => reject(new Error("aborted"))),
  );
}

function recordPosts(
  respond: (count: number, signal?: AbortSignal | null) => Promise<Response>,
) {
  const requests: Array<{ body: string; headers: Record<string, string> }> = [];
  const waiters: Array<{ count: number; resolve(): void }> = [];
  globalThis.fetch = ((_, init) => {
    requests.push({
      body: String(init?.body),
      headers: init?.headers as Record<string, string>,
    });
    for (const waiter of waiters.splice(0)) {
      if (requests.length >= waiter.count) waiter.resolve();
      else waiters.push(waiter);
    }
    return respond(requests.length, init?.signal);
  }) as typeof fetch;
  return {
    started: (count: number) =>
      requests.length >= count
        ? Promise.resolve()
        : new Promise<void>((resolve) => waiters.push({ count, resolve })),
    posted: () =>
      requests.map(({ body, headers }) => ({
        data: (JSON.parse(body) as { data: string }).data,
        sequence: headers["X-Terminal-Input-Sequence"],
      })),
    streams: () =>
      requests.map(({ headers }) => headers["X-Terminal-Input-Stream"]),
  };
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
  delays.length = 0;
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
  sent: string[] = [];

  constructor(readonly url: string) {
    super();
    FakeWebSocket.opened.push(this);
  }

  close(): void {
    this.readyState = 3;
    this.emit("close");
  }

  send(data: string): void {
    this.sent.push(data);
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
    setTimeout: (callback: () => void, delay = 0) => {
      const id = ++nextTimer;
      timers.set(id, { callback, delay });
      delays.push(delay);
      return id;
    },
    clearTimeout: (id: number) => {
      timers.delete(id);
    },
  } as unknown as Window & typeof globalThis;
}

describe("SSE fallback input", () => {
  test("keeps numbered retries on POST when WebSocket recovers", async () => {
    const requests = recordPosts((count, signal) =>
      count === 1 ? hangUntilAborted(signal) : Promise.resolve(new Response()),
    );
    const transport = new ReconnectingTransport("demo", {
      onMessage() {},
      onState() {},
    });
    transport.send({ type: "input", data: "retry" });
    await requests.started(1);
    transport.connect();
    const socket = FakeWebSocket.opened[0]!;
    socket.readyState = FakeWebSocket.OPEN;
    socket.emit("message", {
      data: JSON.stringify({ type: "status", running: true }),
    });
    advanceSendTimer();
    await requests.started(2);
    await microtasks();

    expect(requests.posted()).toEqual([
      { data: "retry", sequence: "0" },
      { data: "retry", sequence: "0" },
    ]);
    expect(socket.sent).toEqual([]);
    transport.close();
  });

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

  test("keeps queued and in-flight input across a reconnect", async () => {
    const requests = recordPosts((count, signal) =>
      count === 1 ? hangUntilAborted(signal) : Promise.resolve(new Response()),
    );
    globalThis.WebSocket = ConnectingWebSocket as unknown as typeof WebSocket;
    const transport = new ReconnectingTransport("demo", {
      onMessage() {},
      onState() {},
    });

    transport.send({ type: "input", data: "before" });
    await requests.started(1);
    transport.send({ type: "input", data: "stale" });
    transport.connect();
    transport.send({ type: "input", data: "after" });
    await microtasks();
    advanceSendTimer();
    await microtasks();
    advanceSendTimer();
    await requests.started(3);

    expect(requests.posted()).toEqual([
      { data: "before", sequence: "0" },
      { data: "before", sequence: "0" },
      { data: "staleafter", sequence: "1" },
    ]);
    expect(new Set(requests.streams()).size).toBe(1);
    transport.close();
  });

  test("re-sends a failed POST with its sequence and backs off between attempts", async () => {
    const requests = recordPosts((count) =>
      count < 3
        ? Promise.reject(new Error("network"))
        : Promise.resolve(new Response()),
    );
    const states: string[] = [];
    const transport = new ReconnectingTransport("demo", {
      onMessage() {},
      onState: (state) => states.push(state),
    });
    transport.connect();
    connectWebSocket(0);

    transport.send({ type: "input", data: "a" });
    await requests.started(1);
    await microtasks();
    expect(states.at(-1)).toBe("disconnected");
    expect(delays.at(-1)).toBe(500);
    advanceTimer();
    connectWebSocket(1);
    advanceSendTimer();
    await requests.started(2);
    await microtasks();
    expect(delays.at(-1)).toBe(1000);
    advanceTimer();
    connectWebSocket(2);
    advanceSendTimer();
    await requests.started(3);

    expect(requests.posted()).toEqual([
      { data: "a", sequence: "0" },
      { data: "a", sequence: "0" },
      { data: "a", sequence: "0" },
    ]);
    expect(new Set(requests.streams()).size).toBe(1);
    transport.close();
  });

  test("starts a new input stream when the server rejects the old one", async () => {
    const requests = recordPosts((count) =>
      Promise.resolve(
        count === 1 ? new Response(null, { status: 409 }) : new Response(),
      ),
    );
    globalThis.WebSocket = ConnectingWebSocket as unknown as typeof WebSocket;
    const transport = new ReconnectingTransport("demo", {
      onMessage() {},
      onState() {},
    });

    transport.send({ type: "input", data: "x" });
    transport.send({ type: "input", data: "y" });
    await requests.started(1);
    await microtasks();
    advanceSendTimer();
    await requests.started(2);
    await microtasks();
    advanceSendTimer();
    await requests.started(3);

    expect(requests.posted()).toEqual([
      { data: "x", sequence: "0" },
      { data: "x", sequence: "0" },
      { data: "y", sequence: "1" },
    ]);
    const [first, second, third] = requests.streams();
    expect(second).not.toBe(first);
    expect(third).toBe(second);
    transport.close();
  });
});

describe("reconnection", () => {
  test("sends fresh input on an open WebSocket", () => {
    const transport = new ReconnectingTransport("demo", {
      onMessage() {},
      onState() {},
    });
    transport.connect();
    const socket = FakeWebSocket.opened[0]!;
    socket.readyState = FakeWebSocket.OPEN;
    socket.emit("message", {
      data: JSON.stringify({ type: "status", running: true }),
    });
    transport.send({ type: "input", data: "fresh" });
    expect(socket.sent).toEqual([
      JSON.stringify({ type: "input", data: "fresh" }),
    ]);
    transport.close();
  });

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
