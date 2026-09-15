import type { SessionMode, SessionSummary } from "../shared/protocol";
import {
  applyAppearance,
  loadAppearance,
  watchSystemAppearance,
} from "./appearance";
import { createSessionPicker } from "./session-picker";
import { errorMessage, listSessions, openSession } from "./sessions";
import { createTerminalPage, type TerminalPage } from "./terminal-page";

const LAST_SESSION_KEY = "herdr-web:last-session";

export function startApp(root: HTMLElement) {
  let terminalPage: TerminalPage | undefined;
  let resumeAttempted = false;

  const picker = createSessionPicker({
    onOpen: open,
    onRefresh: () => void refresh(),
  });

  const showPicker = () => {
    terminalPage?.dispose();
    terminalPage = undefined;
    picker.reset();
    root.replaceChildren(picker.element);
  };

  async function open(name: string, mode: SessionMode) {
    picker.showError("");
    let session: SessionSummary;
    try {
      session = await openSession(name, mode);
    } catch (error) {
      picker.showError(errorMessage(error, "Could not open that session."));
      throw error;
    }
    localStorage.setItem(LAST_SESSION_KEY, session.name);
    terminalPage = createTerminalPage({
      sessionId: session.name,
      onLeave: () => {
        localStorage.removeItem(LAST_SESSION_KEY);
        showPicker();
        void refresh();
      },
      onExit: () => localStorage.removeItem(LAST_SESSION_KEY),
    });
    root.replaceChildren(terminalPage.element);
  }

  async function refresh() {
    picker.showError("");
    try {
      const sessions = await listSessions();
      picker.showSessions(sessions);
      await resumeLastSession(sessions);
    } catch (error) {
      picker.showError(errorMessage(error, "Could not load sessions."));
    }
  }

  // Reopening the app resumes the last session only while it is still running;
  // restarting a stopped one stays an explicit choice on the picker.
  async function resumeLastSession(sessions: SessionSummary[]) {
    if (resumeAttempted || terminalPage) return;
    resumeAttempted = true;
    const name = localStorage.getItem(LAST_SESSION_KEY);
    if (!name) return;
    const known = sessions.find((session) => session.name === name);
    if (known?.status !== "running") {
      localStorage.removeItem(LAST_SESSION_KEY);
      return;
    }
    await open(name, "attach").catch(() => {
      localStorage.removeItem(LAST_SESSION_KEY);
    });
  }

  void loadAppearance().then((appearance) => {
    applyAppearance(appearance);
    if (appearance.colorScheme === "system") {
      watchSystemAppearance(() => applyAppearance(appearance));
    }
  });

  showPicker();
  picker.showLoading();
  void refresh();
}
