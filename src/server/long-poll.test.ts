import { describe, expect, test } from "bun:test";
import type { ServerMessage } from "../shared/protocol";
import { collectMessages, type MessageSource } from "./long-poll";

class FakeSource implements MessageSource {
  listeners = new Set<(message: ServerMessage) => void>();
  cursors: number[] = [];

  constructor(private readonly replay: ServerMessage[] = []) {}

  subscribe(listener: (message: ServerMessage) => void, cursor: number) {
    this.cursors.push(cursor);
    this.listeners.add(listener);
    listener({ type: "status", running: true });
    listener({ type: "sync", cursor, reset: false });
    for (const message of this.replay) listener(message);
    return () => this.listeners.delete(listener);
  }

  publish(message: ServerMessage) {
    for (const listener of this.listeners) listener(message);
  }
}

describe("long poll collection", () => {
  test("returns replayed output right away", async () => {
    const source = new FakeSource([
      { type: "output", data: "a", cursor: 1 },
      { type: "output", data: "b", cursor: 2 },
    ]);

    const messages = await collectMessages(source, 0, {
      timeoutMs: 10_000,
      batchMs: 0,
    });

    expect(messages.map((message) => message.type)).toEqual([
      "status",
      "sync",
      "output",
      "output",
    ]);
    expect(source.cursors).toEqual([0]);
    expect(source.listeners.size).toBe(0);
  });

  test("holds the request until live output arrives", async () => {
    const source = new FakeSource();
    const pending = collectMessages(source, 5, {
      timeoutMs: 10_000,
      batchMs: 0,
    });
    await Promise.resolve();
    expect(source.listeners.size).toBe(1);

    source.publish({ type: "output", data: "late", cursor: 9 });

    expect(await pending).toContainEqual({
      type: "output",
      data: "late",
      cursor: 9,
    });
    expect(source.listeners.size).toBe(0);
  });

  test("batches a burst that follows the first chunk", async () => {
    const source = new FakeSource();
    const pending = collectMessages(source, 0, {
      timeoutMs: 10_000,
      batchMs: 20,
    });

    source.publish({ type: "output", data: "1", cursor: 1 });
    source.publish({ type: "output", data: "2", cursor: 2 });

    const outputs = (await pending).filter(
      (message) => message.type === "output",
    );
    expect(outputs).toHaveLength(2);
  });

  test("returns heartbeats alone once the timeout passes", async () => {
    const source = new FakeSource();

    const messages = await collectMessages(source, 0, { timeoutMs: 5 });

    expect(messages.map((message) => message.type)).toEqual(["status", "sync"]);
    expect(source.listeners.size).toBe(0);
  });

  test("returns a stopped status without waiting", async () => {
    const source = new FakeSource();
    const pending = collectMessages(source, 0, {
      timeoutMs: 10_000,
      batchMs: 0,
    });

    source.publish({ type: "status", running: false });

    expect(await pending).toContainEqual({ type: "status", running: false });
  });

  test("unsubscribes when the client aborts", async () => {
    const source = new FakeSource();
    const controller = new AbortController();
    const pending = collectMessages(source, 0, {
      timeoutMs: 10_000,
      signal: controller.signal,
    });

    controller.abort();

    await pending;
    expect(source.listeners.size).toBe(0);
  });
});
