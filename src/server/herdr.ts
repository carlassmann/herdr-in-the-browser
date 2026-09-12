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

// bun-pty ignores its `env` option, so the child inherits the server's own
// environment. A shell wrapper clears Herdr's nesting markers before exec'ing
// the real binary, which otherwise refuses to run nested inside a Herdr pane.
export function herdrCommand(
  args: string[],
  environment: Record<string, string> = {},
): string[] {
  const lines = [`unset ${HERDR_RUNTIME_VARIABLES.join(" ")}`];
  for (const [name, value] of Object.entries(environment)) {
    lines.push(`export ${name}=${shellQuote(value)}`);
  }
  lines.push('exec "$@"');
  return ["/bin/sh", "-c", lines.join("; "), "sh", herdrExecutable(), ...args];
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
