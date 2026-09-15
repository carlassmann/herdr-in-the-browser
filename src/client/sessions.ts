import type { SessionMode, SessionSummary } from "../shared/protocol";

// Only a message the server explained is worth showing; network failures
// surface as their own generic fallback instead of "Failed to fetch".
export class RequestError extends Error {}

export async function listSessions(): Promise<SessionSummary[]> {
  const response = await fetch("/api/sessions");
  if (!response.ok) {
    throw await responseError(response, "Could not load sessions.");
  }
  const body = (await response.json()) as { sessions: SessionSummary[] };
  return body.sessions;
}

export async function openSession(
  name: string,
  mode: SessionMode,
): Promise<SessionSummary> {
  const response = await fetch("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, mode }),
  });
  if (!response.ok) {
    throw await responseError(response, "Could not open that session.");
  }
  const body = (await response.json()) as { session?: SessionSummary };
  if (!body.session) throw new RequestError("Could not open that session.");
  return body.session;
}

export async function stopSession(name: string): Promise<void> {
  const response = await fetch(`/api/session/${encodeURIComponent(name)}`, {
    method: "DELETE",
  });
  if (!response.ok) {
    throw await responseError(response, "Could not stop that session.");
  }
}

export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof RequestError ? error.message : fallback;
}

async function responseError(
  response: Response,
  fallback: string,
): Promise<RequestError> {
  try {
    const body = (await response.json()) as { error?: unknown };
    return new RequestError(
      typeof body.error === "string" ? body.error : fallback,
    );
  } catch {
    return new RequestError(fallback);
  }
}
