import { describe, expect, test } from "bun:test";
import type { ServerMessage } from "../shared/protocol";
import { TerminalSession, type TerminalProcess } from "./session";

type ExitListener = Parameters<TerminalProcess["onExit"]>[0];

const ESC = "";
const BEL = "";

// A PTY that records what the session asks of it and emits on demand.
class FakeProcess implements TerminalProcess {
  written: string[] = [];
  sizes: Array<[number, number]> = [];
  killed = false;
  private dataListeners: Array<(data: string) => void> = [];
  private exitListeners: ExitListener[] = [];

  onData = (listener: (data: string) => void) => {
    this.dataListeners.push(listener);
    return { dispose() {} };
  };
  onExit = (listener: ExitListener) => {
    this.exitListeners.push(listener);
    return { dispose() {} };
  };
  write(data: string): void {
    this.written.push(data);
  }
  resize(cols: number, rows: number): void {
    this.sizes.push([cols, rows]);
  }
  kill(): void {
    this.killed = true;
    this.exit();
  }
  emit(data: string): void {
    for (const listener of this.dataListeners) listener(data);
  }
  exit(): void {
    for (const listener of this.exitListeners)
      listener({ exitCode: 0 } as never);
  }
}

function openSession() {
  const process = new FakeProcess();
  const session = new TerminalSession("demo", process);
  return { process, session };
}

function record() {
  const messages: ServerMessage[] = [];
  return {
    messages,
    listener: (message: ServerMessage) => messages.push(message),
  };
}

describe("attaching to a session", () => {
  test("applies the client's size before it hears anything", () => {
    const { process, session } = openSession();
    const seen = record();

    session.attach(seen.listener, {
      cursor: 0,
      size: { cols: 1000, rows: 40 },
    });

    expect(process.sizes).toEqual([[500, 40]]);
    expect(seen.messages).toEqual([
      { type: "status", running: true },
      { type: "sync", cursor: 0, reset: false },
    ]);
  });

  test("leaves the PTY size alone when the client sends none", () => {
    const { process, session } = openSession();
    session.attach(() => {}, { cursor: 0 });
    expect(process.sizes).toEqual([]);
  });

  test("replays missed output and its notifications, then stays live", () => {
    const { process, session } = openSession();
    process.emit("first");
    const first = record();
    const detach = session.attach(first.listener, { cursor: 0 });
    detach();
    process.emit(`second${BEL}`);

    const second = record();
    session.attach(second.listener, { cursor: 5 });
    process.emit("live");

    expect(first.messages.at(-1)).toEqual({
      type: "output",
      data: "first",
      cursor: 5,
    });
    expect(second.messages).toEqual([
      { type: "status", running: true },
      { type: "sync", cursor: 5, reset: false },
      { type: "output", data: `second${BEL}`, cursor: 12 },
      { type: "notify" },
      { type: "output", data: "live", cursor: 16 },
    ]);
  });

  test("restores terminal modes after a reset instead of replaying alerts", () => {
    const { process, session } = openSession();
    process.emit(`${ESC}[?1049h${ESC}]9;done${BEL}`);
    const seen = record();

    session.attach(seen.listener, { cursor: 999 });

    expect(seen.messages[1]).toEqual({ type: "sync", cursor: 0, reset: true });
    expect(seen.messages[2]).toMatchObject({ type: "output", cursor: 0 });
    expect((seen.messages[2] as { data: string }).data).toContain("?1049h");
    expect(seen.messages.filter((m) => m.type === "notify")).toHaveLength(0);
  });

  test("reports an exit to everyone attached and stops accepting input", async () => {
    const { process, session } = openSession();
    const seen = record();
    session.attach(seen.listener, { cursor: 0 });

    process.exit();
    await session.receive({ type: "input", data: "late" });

    expect(seen.messages.at(-1)).toEqual({ type: "status", running: false });
    expect(session.summary()).toEqual({ name: "demo", status: "stopped" });
    expect(process.written).toEqual([]);
  });
});

describe("receiving input", () => {
  test("writes live input straight through", async () => {
    const { process, session } = openSession();
    await session.receive({ type: "input", data: "ls\r" });
    await session.receive({ type: "resize", cols: 0, rows: 9999 });
    expect(process.written).toEqual(["ls\r"]);
    expect(process.sizes).toEqual([[2, 300]]);
  });

  test("applies numbered input in order and once", async () => {
    const { process, session } = openSession();
    const second = session.receive(
      { type: "input", data: "b" },
      { stream: "s", sequence: 1 },
    );
    await session.receive(
      { type: "input", data: "a" },
      { stream: "s", sequence: 0 },
    );
    await second;
    await session.receive(
      { type: "input", data: "a" },
      { stream: "s", sequence: 0 },
    );

    expect(process.written).toEqual(["a", "b"]);
  });

  test("rejects a stream the server no longer knows", async () => {
    const { session } = openSession();
    await expect(
      session.receive(
        { type: "input", data: "x" },
        { stream: "unknown", sequence: 7 },
      ),
    ).rejects.toThrow();
  });
});
