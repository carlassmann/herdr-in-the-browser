import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawn, type IPty } from "bun-pty";
import type { SessionMode } from "../shared/protocol";

const HERDR_RUNTIME_VARIABLES = [
  "HERDR_ENV",
  "HERDR_SESSION",
  "HERDR_PANE_ID",
  "HERDR_TAB_ID",
  "HERDR_WORKSPACE_ID",
  "HERDR_SOCKET_PATH",
  "HERDR_STARTUP_CWD",
  "HERDR_BIN_PATH",
];

export function findHerdr(): string | undefined {
  return process.env.HERDR_BIN ?? Bun.which("herdr") ?? undefined;
}

function herdrExecutable(): string {
  const executable = findHerdr();
  if (!executable) {
    throw new Error("herdr was not found on PATH. Set HERDR_BIN to its path.");
  }
  return executable;
}

export function herdrCommand(
  args: string[],
  environment: Record<string, string> = {},
): string[] {
  return outsideHerdr([herdrExecutable(), ...args], environment);
}

// Herdr refuses to run nested inside another Herdr pane. bun-pty's `env`
// option only adds variables to the inherited environment, so the nesting
// markers are removed by `env -u` in front of the real command instead.
function outsideHerdr(
  command: string[],
  environment: Record<string, string> = {},
): string[] {
  const unsets = HERDR_RUNTIME_VARIABLES.flatMap((name) => ["-u", name]);
  const assignments = Object.entries(environment).map(
    ([name, value]) => `${name}=${value}`,
  );
  return ["/usr/bin/env", ...unsets, ...assignments, ...command];
}

export function spawnHerdr(name: string, mode: SessionMode): IPty {
  const args =
    mode === "attach" ? ["session", "attach", name] : ["--session", name];
  const configPath = webTerminalConfigPath();
  // Present a browser terminal as a remote login so Herdr sends OSC 52
  // instead of opening the host clipboard.
  const [file, ...command] = herdrCommand(args, {
    COLORTERM: "truecolor",
    TERM_PROGRAM: "ghostty",
    SSH_TTY: "/dev/tty",
    ...(configPath ? { HERDR_CONFIG_PATH: configPath } : {}),
  });
  return spawn(file!, command, {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    cwd: process.cwd(),
  });
}

const DERIVED_CONFIG_NAME = "config.web-terminal.toml";

function herdrConfigPath(): string {
  return (
    process.env.HERDR_CONFIG_PATH ??
    join(homedir(), ".config", "herdr", "config.toml")
  );
}

// Host toasts and sounds cannot reach the browser; terminal notifications can.
export function forwardNotificationsToTerminal(config: string): string {
  return withSetting(
    withSetting(config, "ui.toast", "delivery", '"terminal"'),
    "ui.sound",
    "enabled",
    "false",
  );
}

function withSetting(
  config: string,
  section: string,
  key: string,
  value: string,
): string {
  const setting = `${key} = ${value}`;
  const lines = config.split("\n");
  const header = lines.findIndex((line) => line.trim() === `[${section}]`);
  if (header === -1) {
    const separator = config.endsWith("\n") || config === "" ? "" : "\n";
    return `${config}${separator}\n[${section}]\n${setting}\n`;
  }
  const sectionEnd = lines.findIndex(
    (line, index) => index > header && line.trim().startsWith("["),
  );
  const end = sectionEnd === -1 ? lines.length : sectionEnd;
  const kept = lines
    .slice(header + 1, end)
    .filter((line) => !isAssignmentOf(line, key));
  return [
    ...lines.slice(0, header + 1),
    setting,
    ...kept,
    ...lines.slice(end),
  ].join("\n");
}

function isAssignmentOf(line: string, key: string): boolean {
  const [assigned = ""] = line.split("=");
  return assigned.trim() === key;
}

// Keep relative theme/sound paths resolving beside the source config.
export function webTerminalConfigPath(): string | undefined {
  const source = herdrConfigPath();
  const derived = join(dirname(source), DERIVED_CONFIG_NAME);
  try {
    const config = forwardNotificationsToTerminal(readSafely(source));
    if (readSafely(derived) !== config) writeFileSync(derived, config);
  } catch {
    return undefined;
  }
  return derived;
}

function readSafely(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}
