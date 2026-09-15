import { el } from "./dom";
import { arrowLeftIcon, stopIcon } from "./icons";
import { createKeysToolbar } from "./keys-toolbar";
import { openModal } from "./overlays";
import { errorMessage, stopSession } from "./sessions";
import { TerminalControls } from "./terminal-controls";
import { attachTerminal, type SessionState } from "./terminal-session";

interface TerminalPageOptions {
  sessionId: string;
  onLeave(): void;
  onExit(): void;
}

export interface TerminalPage {
  element: HTMLElement;
  dispose(): void;
}

export function createTerminalPage({
  sessionId,
  onLeave,
  onExit,
}: TerminalPageOptions): TerminalPage {
  const controls = new TerminalControls();
  const connection = el("span", { class: "connection connection-connecting" });
  const shell = el("div", { class: "terminal-shell" });

  const showConnection = (state: SessionState) => {
    connection.className = `connection connection-${state}`;
    connection.replaceChildren(
      el("span", { "aria-hidden": "true" }),
      document.createTextNode(state),
    );
    if (state === "exited") onExit();
  };
  showConnection("connecting");

  const element = el(
    "main",
    { class: "app terminal-page" },
    el(
      "header",
      { class: "terminal-header" },
      el(
        "button",
        {
          type: "button",
          class: "icon-button",
          "aria-label": "Choose terminal",
          onclick: onLeave,
        },
        arrowLeftIcon(),
      ),
      el("div", { class: "session-title" }, el("p", {}, sessionId), connection),
      el(
        "button",
        {
          type: "button",
          class: "icon-button",
          "aria-label": `Stop ${sessionId}`,
          onclick: () => openStopDialog(sessionId, onLeave),
        },
        stopIcon(),
      ),
      createKeysToolbar(sessionId, controls),
    ),
    shell,
  );

  const detachTerminal = attachTerminal(shell, {
    sessionId,
    controls,
    onConnectionChange: showConnection,
  });

  return { element, dispose: detachTerminal };
}

function openStopDialog(sessionId: string, onStopped: () => void) {
  const title = el("h2", { class: "dialog-title", id: "stop-dialog-title" });
  title.textContent = `Stop ${sessionId}?`;
  const error = el("p", { class: "dialog-error", role: "alert", hidden: true });

  const cancel = el(
    "button",
    { type: "button", class: "dialog-button" },
    "Cancel",
  );
  const confirm = el(
    "button",
    { type: "button", class: "dialog-button dialog-button-danger" },
    "Stop session",
  );

  const popup = el(
    "div",
    {
      class: "dialog-popup",
      role: "alertdialog",
      "aria-modal": "true",
      "aria-labelledby": "stop-dialog-title",
      tabindex: "-1",
    },
    title,
    el(
      "p",
      { class: "dialog-description" },
      "Running work will end. The named session stays available to restart.",
    ),
    error,
    el("div", { class: "dialog-actions" }, cancel, confirm),
  );

  const dialog = openModal({ popup });

  cancel.addEventListener("click", () => dialog.close());
  confirm.addEventListener("click", () => {
    cancel.disabled = true;
    confirm.disabled = true;
    confirm.textContent = "Stopping…";
    void stopSession(sessionId)
      .then(() => {
        dialog.close();
        onStopped();
      })
      .catch((failure: unknown) => {
        error.textContent = errorMessage(
          failure,
          "Could not stop that session.",
        );
        error.hidden = false;
        cancel.disabled = false;
        confirm.disabled = false;
        confirm.textContent = "Stop session";
      });
  });
}
