import { AlertDialog } from "@base-ui/react/alert-dialog";
import { ArrowLeftIcon, PlusIcon, StopIcon } from "@heroicons/react/16/solid";
import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionMode, SessionSummary } from "../shared/protocol";
import {
  applyAppearance,
  loadAppearance,
  watchSystemAppearance,
} from "./appearance";
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
  const [stopDialogOpen, setStopDialogOpen] = useState(false);
  const [stopping, setStopping] = useState(false);
  const openedSessionRef = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/sessions");
      if (!response.ok) {
        throw new Error(
          await responseError(response, "Could not load sessions."),
        );
      }
      const body = (await response.json()) as { sessions: SessionSummary[] };
      setSessions(body.sessions);
      setError("");
    } catch (error) {
      setError(errorMessage(error, "Could not load sessions."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    let dispose = () => {};
    let cancelled = false;
    void loadAppearance().then((appearance) => {
      if (cancelled) return;
      applyAppearance(appearance);
      if (appearance.colorScheme === "system") {
        dispose = watchSystemAppearance(() => applyAppearance(appearance));
      }
    });
    return () => {
      cancelled = true;
      dispose();
    };
  }, []);

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
    try {
      const response = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, mode }),
      });
      if (!response.ok) {
        throw new Error(
          await responseError(response, "Could not open that session."),
        );
      }
      const body = (await response.json()) as { session?: SessionSummary };
      if (!body.session) throw new Error("Could not open that session.");
      const session = body.session;
      setSessions((current) => [
        session,
        ...current.filter((item) => item.name !== session.name),
      ]);
      localStorage.setItem(LAST_SESSION_KEY, session.name);
      setActiveSession(session.name);
    } catch (error) {
      openedSessionRef.current = null;
      const message = errorMessage(error, "Could not open that session.");
      setError(message);
      throw new Error(message);
    }
  };

  const stopSession = async () => {
    if (!activeSession) return;
    setStopping(true);
    try {
      const response = await fetch(
        `/api/session/${encodeURIComponent(activeSession)}`,
        { method: "DELETE" },
      );
      if (!response.ok) {
        setError(await responseError(response, "Could not stop that session."));
        return;
      }
      setStopDialogOpen(false);
      leaveTerminal();
    } catch (error) {
      setError(errorMessage(error, "Could not stop that session."));
    } finally {
      setStopping(false);
    }
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
            <AlertDialog.Root
              open={stopDialogOpen}
              onOpenChange={(open) => {
                if (stopping) return;
                setStopDialogOpen(open);
                if (open) setError("");
              }}
            >
              <AlertDialog.Trigger
                className="icon-button"
                aria-label={`Stop ${activeSession}`}
              >
                <StopIcon aria-hidden="true" />
              </AlertDialog.Trigger>
              <AlertDialog.Portal>
                <AlertDialog.Backdrop className="dialog-backdrop" />
                <AlertDialog.Popup className="dialog-popup">
                  <AlertDialog.Title className="dialog-title">
                    Stop {activeSession}?
                  </AlertDialog.Title>
                  <AlertDialog.Description className="dialog-description">
                    Running work will end. The named session stays available to
                    restart.
                  </AlertDialog.Description>
                  {error ? (
                    <p className="dialog-error" role="alert">
                      {error}
                    </p>
                  ) : null}
                  <div className="dialog-actions">
                    <AlertDialog.Close
                      className="dialog-button"
                      disabled={stopping}
                    >
                      Cancel
                    </AlertDialog.Close>
                    <button
                      type="button"
                      className="dialog-button dialog-button-danger"
                      disabled={stopping}
                      onClick={() => void stopSession()}
                    >
                      {stopping ? "Stopping…" : "Stop session"}
                    </button>
                  </div>
                </AlertDialog.Popup>
              </AlertDialog.Portal>
            </AlertDialog.Root>
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
                    ).catch(() => {})
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

async function responseError(
  response: Response,
  fallback: string,
): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    return typeof body.error === "string" ? body.error : fallback;
  } catch {
    return fallback;
  }
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.name === "Error"
    ? error.message
    : fallback;
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
        void onCreate(name)
          .catch(() => {})
          .finally(() => setSubmitting(false));
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
