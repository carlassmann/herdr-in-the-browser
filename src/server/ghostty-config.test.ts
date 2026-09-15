import { describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  forgetGhosttyConfig,
  loadGhosttyAppearance,
  loadGhosttyFont,
} from "./ghostty-config";

describe("Ghostty config reloading", () => {
  test("invalidates font-only reads when config changes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ghostty-font-config-"));
    const config = join(directory, "config");
    const reads = join(directory, "reads");
    const ghostty = join(directory, "ghostty");
    const originalBin = process.env.GHOSTTY_BIN;
    const originalConfig = process.env.GHOSTTY_CONFIG_FILE;
    writeFileSync(config, "font-family = Missing One\n");
    writeFileSync(
      ghostty,
      `#!/bin/sh\necho read >> ${reads}\ncat "$GHOSTTY_CONFIG_FILE"\n`,
      {
        mode: 0o755,
      },
    );
    process.env.GHOSTTY_BIN = ghostty;
    process.env.GHOSTTY_CONFIG_FILE = config;
    try {
      forgetGhosttyConfig();
      await loadGhosttyFont();
      await loadGhosttyFont();
      expect(readFileSync(reads, "utf8").trim().split("\n")).toHaveLength(1);

      writeFileSync(config, "font-family = Missing Two\n");
      utimesSync(config, new Date(), new Date(Date.now() + 1000));
      await loadGhosttyFont();
      expect(readFileSync(reads, "utf8").trim().split("\n")).toHaveLength(2);
    } finally {
      if (originalBin === undefined) delete process.env.GHOSTTY_BIN;
      else process.env.GHOSTTY_BIN = originalBin;
      if (originalConfig === undefined) delete process.env.GHOSTTY_CONFIG_FILE;
      else process.env.GHOSTTY_CONFIG_FILE = originalConfig;
      forgetGhosttyConfig();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("reads Ghostty again only after the config file changes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ghostty-config-"));
    const config = join(directory, "config");
    const reads = join(directory, "reads");
    const ghostty = join(directory, "ghostty");
    writeFileSync(config, "font-size = 16\n");
    writeFileSync(
      ghostty,
      `#!/bin/sh\necho read >> ${reads}\ncat "$GHOSTTY_CONFIG_FILE"\n`,
      { mode: 0o755 },
    );
    process.env.GHOSTTY_BIN = ghostty;
    process.env.GHOSTTY_CONFIG_FILE = config;

    try {
      forgetGhosttyConfig();
      expect((await loadGhosttyAppearance()).fontSize).toBe(16);
      expect((await loadGhosttyAppearance()).fontSize).toBe(16);
      expect(readFileSync(reads, "utf8").trim().split("\n")).toHaveLength(1);

      writeFileSync(config, "font-size = 22\n");
      utimesSync(config, new Date(), new Date(Date.now() + 1000));

      expect((await loadGhosttyAppearance()).fontSize).toBe(22);
      expect(readFileSync(reads, "utf8").trim().split("\n")).toHaveLength(2);
    } finally {
      delete process.env.GHOSTTY_BIN;
      delete process.env.GHOSTTY_CONFIG_FILE;
      forgetGhosttyConfig();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
