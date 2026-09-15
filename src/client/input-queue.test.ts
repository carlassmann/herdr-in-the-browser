import { expect, test } from "bun:test";
import { InputQueue } from "./input-queue";

test("retries retain sequence and order across aborts", () => {
  const queue = new InputQueue();
  queue.enqueue({ type: "input", data: "a" });
  const first = queue.take()!;
  queue.enqueue({ type: "input", data: "b" });
  queue.abortInFlight();
  expect(queue.take()).toBe(first);
  expect(first.sequence).toBe(0);
  expect(queue.take()?.sequence).toBe(1);
});

test("merges only unsent input, restarts identity after stream conflict", () => {
  const queue = new InputQueue();
  queue.enqueue({ type: "input", data: "a" });
  const first = queue.take()!;
  queue.enqueue({ type: "input", data: "b" });
  queue.enqueue({ type: "input", data: "c" });
  queue.fail(first);
  queue.restartStream();
  expect(queue.take()?.message).toEqual({ type: "input", data: "a" });
  expect(queue.take()?.message).toEqual({ type: "input", data: "bc" });
  expect(queue.nextSendRetry()).toBe(500);
  expect(queue.nextSendRetry()).toBe(1000);
  expect(queue.nextSendRetry()).toBe(2000);
});
