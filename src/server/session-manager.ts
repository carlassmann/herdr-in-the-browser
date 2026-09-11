import type { SessionMode, SessionSummary } from "../shared/protocol";
import { TerminalSession } from "./session";
import { VALID_SESSION_NAME, validateSessionName } from "./session-name";

export class SessionManager {
  private readonly sessions = new Map<string, TerminalSession>();

  get(id: string): TerminalSession | undefined {
    return this.sessions.get(id);
  }

  open(name: string, mode: SessionMode): TerminalSession {
    validateSessionName(name);
    const existing = this.sessions.get(name);
    if (existing?.isRunning()) return existing;

    const session = new TerminalSession(name, mode);
    this.sessions.set(name, session);
    return session;
  }

  async stop(name: string): Promise<void> {
    validateSessionName(name);
    const session = this.sessions.get(name);
    session?.stop();
    this.sessions.delete(name);

    const herdrExecutable = process.env.HERDR_BIN ?? Bun.which("herdr");
    if (!herdrExecutable) throw new Error("herdr was not found on PATH.");
    const child = Bun.spawn([herdrExecutable, "session", "stop", name], {
      stdout: "ignore",
      stderr: "pipe",
    });
    const error = await new Response(child.stderr).text();
    if (
      (await child.exited) !== 0 &&
      !error.includes("not running or cannot be reached")
    ) {
      throw new Error(error.trim() || `Could not stop ${name}.`);
    }
  }

  async list(): Promise<SessionSummary[]> {
    const managed = new Map(
      [...this.sessions.values()].map((session) => [
        session.name,
        session.summary(),
      ]),
    );

    for (const session of await listHerdrSessions()) {
      if (!managed.has(session.name)) managed.set(session.name, session);
    }

    return [...managed.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
}

async function listHerdrSessions(): Promise<SessionSummary[]> {
  const herdrExecutable = process.env.HERDR_BIN ?? Bun.which("herdr");
  if (!herdrExecutable) return [];
  const child = Bun.spawn([herdrExecutable, "session", "list"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const output = await new Response(child.stdout).text();
  if ((await child.exited) !== 0) return [];

  return output
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter(
      (parts) => parts.length >= 2 && VALID_SESSION_NAME.test(parts[0] ?? ""),
    )
    .map(([name, status]) => ({
      name: name!,
      status: status === "running" ? "running" : "stopped",
    }));
}
