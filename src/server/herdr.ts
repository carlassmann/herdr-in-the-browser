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

export function herdrExecutable(): string {
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
export function outsideHerdr(
  command: string[],
  environment: Record<string, string> = {},
): string[] {
  const unsets = HERDR_RUNTIME_VARIABLES.flatMap((name) => ["-u", name]);
  const assignments = Object.entries(environment).map(
    ([name, value]) => `${name}=${value}`,
  );
  return ["/usr/bin/env", ...unsets, ...assignments, ...command];
}
