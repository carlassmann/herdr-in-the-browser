import { afterEach, describe, expect, test } from "bun:test";
import type { ServerMessage } from "../shared/protocol";
import { INPUT_SEQUENCE_HEADER, INPUT_STREAM_HEADER } from "../shared/protocol";
import { serverRoutes, type SessionRegistry } from "./routes";
import { TerminalSession, type TerminalProcess } from "./session";

const BEL = "";

class FakeProcess implements TerminalProcess {
  written: string[] = [];
  sizes: Array<[number, number]> = [];
  private dataListeners: Array<(data: string) => void> = [];
  private exitListeners: Array<Parameters<TerminalProcess["onExit"]>[0]> = [];
  onData = (listener: (data: string) => void) => {
    this.dataListeners.push(listener);
    return { dispose() {} };
  };
  onExit = (listener: Parameters<TerminalProcess["onExit"]>[0]) => {
    this.exitListeners.push(listener);
    return { dispose() {} };
  };
  write(data: string): void {
    this.written.push(data);
  }
  resize(cols: number, rows: number): void {
    this.sizes.push([cols, rows]);
  }
  kill(): void {}
  emit(data: string): void {
    for (const listener of this.dataListeners) listener(data);
  }
  exit(): void {
    for (const listener of this.exitListeners)
      listener({ exitCode: 0 } as never);
  }
}

const servers: Array<ReturnType<typeof Bun.serve>> = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

// The routes in front of one session with a scripted PTY behind it.
function startServer() {
  const process = new FakeProcess();
  const session = new TerminalSession("demo", process);
  const sessions: SessionRegistry = {
    get: (id) => (id === "demo" ? session : undefined),
    open: () => session,
    stop: async () => {},
    list: async () => [session.summary()],
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    ...serverRoutes({
      sessions,
      publicHosts: [],
      publicDirectory: "/nonexistent",
      homepage: new Response("page"),
    }),
  });
  servers.push(server);
  const origin = `http://127.0.0.1:${server.port}`;
  const request = (path: string, init: RequestInit = {}) =>
    fetch(`${origin}${path}`, {
      ...init,
      headers: { Origin: origin, ...init.headers },
    });
  return { process, session, request, origin };
}

async function poll(
  request: ReturnType<typeof startServer>["request"],
  query: string,
): Promise<ServerMessage[]> {
  const response = await request(`/api/session/demo/poll?${query}`);
  const body = (await response.json()) as { messages: ServerMessage[] };
  return body.messages;
}

describe("session routes", () => {
  test("refuses a request from a host it does not know", async () => {
    const { origin } = startServer();
    const response = await fetch(`${origin}/api/sessions`, {
      headers: { Host: "evil.example" },
    });
    expect(response.status).toBe(403);
  });

  test("resizes only when the client sends a size", async () => {
    const { process, request } = startServer();
    process.emit("ready");

    await poll(request, "cursor=0");
    expect(process.sizes).toEqual([]);

    await poll(request, "cursor=0&cols=120&rows=40");
    expect(process.sizes).toEqual([[120, 40]]);
  });

  test("replays output and notifications that arrived between polls", async () => {
    const { process, request } = startServer();
    process.emit("a");
    const first = await poll(request, "cursor=0");
    expect(first.at(-1)).toEqual({ type: "output", data: "a", cursor: 1 });

    process.emit(`done${BEL}`);

    const second = await poll(request, "cursor=1");
    expect(second).toEqual([
      { type: "status", running: true },
      { type: "sync", cursor: 1, reset: false },
      { type: "output", data: `done${BEL}`, cursor: 6 },
      { type: "notify" },
    ]);
  });

  test("applies numbered input in order and answers 409 for a broken stream", async () => {
    const { process, request } = startServer();
    const post = (data: string, sequence: number, stream = "s1") =>
      request("/api/session/demo/input", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [INPUT_STREAM_HEADER]: stream,
          [INPUT_SEQUENCE_HEADER]: String(sequence),
        },
        body: JSON.stringify({ type: "input", data }),
      });

    const second = post("b", 1);
    expect((await post("a", 0)).status).toBe(204);
    expect((await second).status).toBe(204);
    expect((await post("a", 0)).status).toBe(204);
    expect(process.written).toEqual(["a", "b"]);

    expect((await post("z", 9, "s2")).status).toBe(409);
  });

  test("rejects a message of the wrong shape", async () => {
    const { request } = startServer();
    const response = await request("/api/session/demo/resize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "input", data: "x" }),
    });
    expect(response.status).toBe(400);
  });

  test("ends SSE when a session exits", async () => {
    const { process, request } = startServer();
    const response = await request("/api/session/demo/events?cursor=0");
    const reader = response.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    process.exit();
    let ended = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      if ((await reader.read()).done) {
        ended = true;
        break;
      }
    }
    expect(ended).toBe(true);
  });

  test("detaches an SSE client that falls behind during replay", async () => {
    let detached = 0;
    const source = {
      isRunning: () => true,
      attach(listener: (message: ServerMessage) => void) {
        listener({ type: "status", running: true });
        listener({ type: "sync", cursor: 0, reset: false });
        listener({
          type: "output",
          data: "x".repeat(1024 * 1024),
          cursor: 1024 * 1024,
        });
        listener({ type: "output", data: "y", cursor: 1024 * 1024 + 1 });
        return () => {
          detached++;
        };
      },
    } as unknown as TerminalSession;
    const sessions: SessionRegistry = {
      get: () => source,
      open: () => source,
      stop: async () => {},
      list: async () => [],
    };
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      ...serverRoutes({
        sessions,
        publicHosts: [],
        publicDirectory: "/nonexistent",
        homepage: new Response("page"),
      }),
    });
    servers.push(server);
    const origin = `http://127.0.0.1:${server.port}`;
    const response = await fetch(`${origin}/api/session/demo/events?cursor=0`, {
      headers: { Origin: origin },
    });
    await response.text();
    expect(detached).toBe(1);
  });

  test("detaches a WebSocket when Bun drops a replay send", () => {
    let detached = 0;
    const source = {
      attach(listener: (message: ServerMessage) => void) {
        listener({ type: "status", running: true });
        return () => {
          detached++;
        };
      },
    } as unknown as TerminalSession;
    const sessions: SessionRegistry = {
      get: () => source,
      open: () => source,
      stop: async () => {},
      list: async () => [],
    };
    const routes = serverRoutes({
      sessions,
      publicHosts: [],
      publicDirectory: "/nonexistent",
      homepage: new Response("page"),
    });
    const closes: number[] = [];
    const socket = {
      data: { sessionName: "demo", attach: { cursor: 0 } },
      getBufferedAmount: () => 0,
      send: () => 0,
      close: (code: number) => {
        closes.push(code);
      },
    } as unknown as Parameters<typeof routes.websocket.open>[0];
    routes.websocket.open(socket);
    expect(detached).toBe(1);
    expect(closes).toEqual([1011]);
  });
});
