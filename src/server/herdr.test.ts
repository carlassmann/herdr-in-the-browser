import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { herdrCommand, webTerminalConfigPath } from "./herdr";

describe("Herdr child environment", () => {
  test("drops nesting markers and adds extras for the spawned process", async () => {
    const originalExecutable = process.env.HERDR_BIN;
    process.env.HERDR_BIN = "/usr/bin/env";
    try {
      const [file, ...args] = herdrCommand([], {
        TERM_PROGRAM: "HerdrWeb",
      });
      const child = Bun.spawn([file!, ...args], {
        env: { ...process.env, HERDR_PANE_ID: "pane-1", HERDR_ENV: "1" },
        stdout: "pipe",
      });
      const environment = await new Response(child.stdout).text();

      expect(await child.exited).toBe(0);
      expect(environment.includes("TERM_PROGRAM=HerdrWeb")).toBe(true);
      expect(environment.includes("HERDR_PANE_ID=")).toBe(false);
      expect(environment.includes("HERDR_ENV=")).toBe(false);
    } finally {
      if (originalExecutable === undefined) delete process.env.HERDR_BIN;
      else process.env.HERDR_BIN = originalExecutable;
    }
  });

  test("refreshes the derived config when the source changes", () => {
    const directory = mkdtempSync(join(tmpdir(), "herdr-terminal-config-"));
    const source = join(directory, "config.toml");
    const originalPath = process.env.HERDR_CONFIG_PATH;
    process.env.HERDR_CONFIG_PATH = source;
    try {
      writeFileSync(source, '[theme]\nname = "first"\n');
      const derived = webTerminalConfigPath();
      expect(derived).toBe(join(directory, "config.web-terminal.toml"));
      expect(readFileSync(derived!, "utf8")).toContain('name = "first"');

      writeFileSync(source, '[theme]\nname = "second"\n');
      expect(webTerminalConfigPath()).toBe(derived);
      expect(readFileSync(derived!, "utf8")).toContain('name = "second"');
    } finally {
      if (originalPath === undefined) delete process.env.HERDR_CONFIG_PATH;
      else process.env.HERDR_CONFIG_PATH = originalPath;
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
