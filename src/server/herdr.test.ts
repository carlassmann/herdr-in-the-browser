import { describe, expect, test } from "bun:test";
import { outsideHerdr } from "./herdr";

describe("Herdr child environment", () => {
  test("drops nesting markers and adds extras for the spawned process", async () => {
    const [file, ...args] = outsideHerdr(["/usr/bin/env"], {
      TERM_PROGRAM: "HerdrWeb",
    });
    const child = Bun.spawn([file!, ...args], {
      env: { ...process.env, HERDR_PANE_ID: "pane-1", HERDR_ENV: "1" },
      stdout: "pipe",
    });
    const environment = await new Response(child.stdout).text();

    expect(await child.exited).toBe(0);
    expect(environment).toContain("TERM_PROGRAM=HerdrWeb");
    expect(environment).not.toMatch(/^HERDR_/m);
  });
});
