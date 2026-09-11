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
});
