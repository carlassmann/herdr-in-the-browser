import type { SessionMode, SessionSummary } from "../shared/protocol";
import { findHerdr, herdrCommand } from "./herdr";
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

    const session = TerminalSession.spawn(name, mode, () => {
      if (this.sessions.get(name) === session) this.sessions.delete(name);
    });
    this.sessions.set(name, session);
    return session;
  }

  async stop(name: string): Promise<void> {
    validateSessionName(name);
    if (!findHerdr()) throw new Error("herdr was not found on PATH.");

    const session = this.sessions.get(name);
    session?.stop();
    this.sessions.delete(name);

    const [file, ...args] = herdrCommand(["session", "stop", name]);
    const child = Bun.spawn([file!, ...args], {
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
  if (!findHerdr()) return [];
  const [file, ...args] = herdrCommand(["session", "list"]);
  const child = Bun.spawn([file!, ...args], {
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
