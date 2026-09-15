import { describe, expect, test } from "bun:test";
import { ReplayBuffer } from "./session";

describe("terminal replay", () => {
  test("replays only output after the client's cursor", () => {
    const replay = new ReplayBuffer();
    const firstCursor = replay.append("first");
    replay.append("second");

    expect(replay.after(firstCursor)).toMatchObject({
      reset: false,
      chunks: [{ data: "second" }],
    });
  });

  test("requests a reset when the cursor is outside the current process", () => {
    const replay = new ReplayBuffer(5);
    replay.append("old");
    replay.append("new");

    expect(replay.after(0)).toMatchObject({
      cursor: 3,
      reset: true,
      chunks: [{ data: "new", cursor: 6 }],
    });

    expect(new ReplayBuffer().after(999_999)).toMatchObject({
      cursor: 0,
      reset: true,
      chunks: [],
    });
  });

  test("keeps every chunk while the buffer is exactly full", () => {
    const replay = new ReplayBuffer(6);
    replay.append("abc");
    replay.append("def");

    expect(replay.after(0)).toMatchObject({
      cursor: 0,
      reset: false,
      chunks: [{ data: "abc" }, { data: "def" }],
    });
  });

  test("evicts the oldest chunk once the buffer overflows", () => {
    const replay = new ReplayBuffer(6);
    replay.append("abc");
    replay.append("def");
    replay.append("g");

    expect(replay.after(0)).toMatchObject({
      cursor: 3,
      reset: true,
      chunks: [{ data: "def" }, { data: "g" }],
    });
  });
});

describe("sideband replay", () => {
  test("replays notifications a client missed between polls", () => {
    const replay = new ReplayBuffer();
    const seen = replay.append("before");
    replay.append("after");
    replay.mark({ type: "notify" });
    replay.mark({ type: "clipboard", text: "copied" });

    expect(replay.after(seen).markers).toEqual([
      { type: "notify" },
      { type: "clipboard", text: "copied" },
    ]);
    expect(replay.after(replay.append("later")).markers).toEqual([]);
  });

  test("does not replay markers after a reset", () => {
    const replay = new ReplayBuffer(4);
    replay.append("abc");
    replay.mark({ type: "notify" });
    replay.append("def");

    expect(replay.after(0)).toMatchObject({ reset: true, markers: [] });
  });

  test("keeps the newest markers and drops them with their output", () => {
    const replay = new ReplayBuffer(6, 1);
    replay.append("abc");
    replay.mark({ type: "notify" });
    replay.mark({ type: "clipboard", text: "kept" });
    expect(replay.after(0).markers).toEqual([
      { type: "clipboard", text: "kept" },
    ]);

    replay.append("def");
    replay.append("ghi");
    expect(replay.after(3).markers).toEqual([]);
  });
});
