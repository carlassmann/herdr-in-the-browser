import { ArrowLeftIcon, PlusIcon, StopIcon } from "@heroicons/react/16/solid";
import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionMode, SessionSummary } from "../shared/protocol";
import { MobileToolbar } from "./MobileToolbar";
import { TerminalControlsProvider } from "./TerminalControls";
import { TerminalView } from "./TerminalView";
import type { TransportState } from "./transport";

const LAST_SESSION_KEY = "herdr-web:last-session";

export function App() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activeSession, setActiveSession] = useState<string | null>(() =>
    localStorage.getItem(LAST_SESSION_KEY),
  );
  const [connection, setConnection] = useState<TransportState>("connecting");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const openedSessionRef = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/sessions");
      const body = (await response.json()) as { sessions: SessionSummary[] };
      setSessions(body.sessions);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!activeSession || loading) return;
    if (openedSessionRef.current === activeSession) return;
    const known = sessions.find((session) => session.name === activeSession);
    openedSessionRef.current = activeSession;
    void openSession(
      activeSession,
      known?.status === "stopped" ? "create" : "attach",
    ).catch(() => {
      openedSessionRef.current = null;
      localStorage.removeItem(LAST_SESSION_KEY);
      setActiveSession(null);
    });
  }, [activeSession, loading, sessions]);

  const openSession = async (name: string, mode: SessionMode) => {
    openedSessionRef.current = name;
    setError("");
    const response = await fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, mode }),
    });
    const body = (await response.json()) as {
      session?: SessionSummary;
      error?: string;
    };
    if (!response.ok || !body.session) {
      openedSessionRef.current = null;
      const message = body.error ?? "Could not open that session.";
      setError(message);
      throw new Error(message);
    }
    setSessions((current) => [
      body.session!,
      ...current.filter((item) => item.name !== body.session!.name),
    ]);
    localStorage.setItem(LAST_SESSION_KEY, body.session.name);
    setActiveSession(body.session.name);
  };

  const stopSession = async () => {
    if (!activeSession) return;
    const response = await fetch(
      `/api/session/${encodeURIComponent(activeSession)}`,
      { method: "DELETE" },
    );
    if (!response.ok) {
      const body = (await response.json()) as { error?: string };
      setError(body.error ?? "Could not stop that session.");
      return;
    }
    leaveTerminal();
  };

  const leaveTerminal = () => {
    localStorage.removeItem(LAST_SESSION_KEY);
    openedSessionRef.current = null;
    setActiveSession(null);
    setConnection("connecting");
    setError("");
    void refresh();
  };

  if (activeSession) {
    return (
      <TerminalControlsProvider>
        <main className="app terminal-page">
          <header className="terminal-header">
            <button
              type="button"
              className="icon-button"
              aria-label="Choose terminal"
              onClick={leaveTerminal}
            >
              <ArrowLeftIcon aria-hidden="true" />
            </button>
            <div className="session-title">
              <p>{activeSession}</p>
              <span className={`connection connection-${connection}`}>
                <span aria-hidden="true" />
                {connection}
              </span>
            </div>
            <button
              type="button"
              className="icon-button"
              aria-label={`Stop ${activeSession}`}
              onClick={() => void stopSession()}
            >
              <StopIcon aria-hidden="true" />
            </button>
            <MobileToolbar sessionId={activeSession} />
          </header>
          <TerminalView
            sessionId={activeSession}
            onConnectionChange={setConnection}
          />
        </main>
      </TerminalControlsProvider>
    );
  }

  return (
    <main className="app session-page">
      <section className="session-picker">
        <header className="brand-header">
          <div className="brand-mark" aria-hidden="true">
            H
          </div>
          <div>
            <h1>Herdr Terminal</h1>
            <p>Pick up an existing workspace or start a new one.</p>
          </div>
        </header>

        <NewSessionForm
          error={error}
          onCreate={(name) => openSession(name, "create")}
        />

        <div className="session-list-header">
          <h2>Sessions</h2>
          <button
            type="button"
            className="text-button"
            onClick={() => void refresh()}
          >
            Refresh
          </button>
        </div>
        {loading ? (
          <p className="empty-state">Loading sessions…</p>
        ) : sessions.length ? (
          <ul className="session-list" role="list">
            {sessions.map((session) => (
              <li key={session.name}>
                <button
                  type="button"
                  className="session-row"
                  onClick={() =>
                    void openSession(
                      session.name,
                      session.status === "running" ? "attach" : "create",
                    )
                  }
                >
                  <span className="session-name">{session.name}</span>
                  <span className="session-meta">
                    <span
                      className={`status-dot status-${session.status}`}
                      aria-hidden="true"
                    />
                    {session.status}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty-state">No Herdr sessions yet.</p>
        )}
      </section>
    </main>
  );
}

function NewSessionForm({
  error,
  onCreate,
}: {
  error: string;
  onCreate(name: string): Promise<void>;
}) {
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);

  return (
    <form
      className="new-session"
      onSubmit={(event) => {
        event.preventDefault();
        setSubmitting(true);
        void onCreate(name).finally(() => setSubmitting(false));
      }}
    >
      <label htmlFor="session-name">New session</label>
      <div className="new-session-controls">
        <input
          id="session-name"
          name="sessionName"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="feature-auth"
          autoCapitalize="none"
          autoCorrect="off"
          required
        />
        <button
          type="submit"
          className="primary-button"
          disabled={submitting || !name.trim()}
        >
          <PlusIcon aria-hidden="true" />
          Start
        </button>
      </div>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
