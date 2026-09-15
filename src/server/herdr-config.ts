import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";

const DERIVED_CONFIG_NAME = "config.web-terminal.toml";

export function herdrConfigPath(): string {
  return (
    process.env.HERDR_CONFIG_PATH ??
    join(homedir(), ".config", "herdr", "config.toml")
  );
}

// Herdr's own client would pop a desktop toast on the machine hosting the PTY
// and play its sound there, where nobody is listening. Asking it to hand
// notifications to the outer terminal instead turns them into OSC sequences
// that travel down the session stream to the browser.
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

let derivedConfigPath: string | undefined;

// Written next to the original so relative sound and theme paths still resolve.
export function webTerminalConfigPath(): string | undefined {
  if (derivedConfigPath) return derivedConfigPath;
  const source = herdrConfigPath();
  const derived = join(source, "..", DERIVED_CONFIG_NAME);
  try {
    const config = forwardNotificationsToTerminal(readSafely(source));
    if (readSafely(derived) !== config) writeFileSync(derived, config);
    derivedConfigPath = derived;
  } catch {
    return undefined;
  }
  return derivedConfigPath;
}

function readSafely(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}
