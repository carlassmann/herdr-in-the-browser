import type { SessionMode, SessionSummary } from "../shared/protocol";
import { el, replaceChildren } from "./dom";
import { plusIcon } from "./icons";

interface SessionPickerOptions {
  onOpen(name: string, mode: SessionMode): Promise<void>;
  onRefresh(): void;
}

export interface SessionPicker {
  element: HTMLElement;
  reset(): void;
  showLoading(): void;
  showSessions(sessions: SessionSummary[]): void;
  showError(message: string): void;
}

export function createSessionPicker({
  onOpen,
  onRefresh,
}: SessionPickerOptions): SessionPicker {
  const error = el("p", { class: "form-error", role: "alert", hidden: true });
  const list = el("div");
  const form = createNewSessionForm((name) => onOpen(name, "create"));

  const element = el(
    "main",
    { class: "app session-page" },
    el(
      "section",
      { class: "session-picker" },
      el(
        "header",
        { class: "brand-header" },
        el("div", { class: "brand-mark", "aria-hidden": "true" }, "H"),
        el(
          "div",
          {},
          el("h1", {}, "Herdr Terminal"),
          el(
            "p",
            {},
            "Your Herdr terminal in a browser. Pick a session or start one.",
          ),
        ),
      ),
      form.element,
      error,
      el(
        "div",
        { class: "session-list-header" },
        el("h2", {}, "Sessions"),
        el(
          "button",
          { type: "button", class: "text-button", onclick: onRefresh },
          "Refresh",
        ),
      ),
      list,
    ),
  );

  const showError = (message: string) => {
    error.textContent = message;
    error.hidden = !message;
  };

  return {
    element,
    reset() {
      form.reset();
      showError("");
    },
    showLoading() {
      replaceChildren(
        list,
        el("p", { class: "empty-state" }, "Loading sessions…"),
      );
    },
    showSessions(sessions) {
      if (!sessions.length) {
        replaceChildren(
          list,
          el("p", { class: "empty-state" }, "No Herdr sessions yet."),
        );
        return;
      }
      replaceChildren(
        list,
        el(
          "ul",
          { class: "session-list", role: "list" },
          ...sessions.map((session) => el("li", {}, sessionRow(session))),
        ),
      );
    },
    showError,
  };

  function sessionRow(session: SessionSummary) {
    return el(
      "button",
      {
        type: "button",
        class: "session-row",
        onclick: () => {
          void onOpen(
            session.name,
            session.status === "running" ? "attach" : "create",
          ).catch(() => {});
        },
      },
      el("span", { class: "session-name" }, session.name),
      el(
        "span",
        { class: "session-meta" },
        el("span", {
          class: `status-dot status-${session.status}`,
          "aria-hidden": "true",
        }),
        session.status,
      ),
    );
  }
}

function createNewSessionForm(onCreate: (name: string) => Promise<void>) {
  const input = el("input", {
    id: "session-name",
    name: "sessionName",
    placeholder: "feature-auth",
    autocapitalize: "none",
    autocorrect: "off",
    required: true,
  });
  const submit = el(
    "button",
    { type: "submit", class: "primary-button", disabled: true },
    plusIcon(),
    "Start",
  );

  input.addEventListener("input", () => {
    submit.disabled = !input.value.trim();
  });

  const element = el(
    "form",
    {
      class: "new-session",
      onsubmit: (event: Event) => {
        event.preventDefault();
        submit.disabled = true;
        void onCreate(input.value)
          .catch(() => {})
          .finally(() => {
            submit.disabled = !input.value.trim();
          });
      },
    },
    el("label", { for: "session-name" }, "New session"),
    el("div", { class: "new-session-controls" }, input, submit),
  );

  const reset = () => {
    input.value = "";
    submit.disabled = true;
  };

  return { element, reset };
}
