import { writeClipboard } from "./clipboard";
import {
  playNotificationSound,
  unlockNotificationSound,
} from "./notification-sound";
import type { TerminalControls } from "./terminal-controls";
import { attachTerminalView, type TerminalView } from "./terminal-view";
import { ReconnectingTransport, type TransportState } from "./transport";

export type SessionState = TransportState | "exited";

interface TerminalSessionOptions {
  sessionId: string;
  controls: TerminalControls;
  onConnectionChange(state: SessionState): void;
}

export function attachTerminal(
  shell: HTMLElement,
  { sessionId, controls, onConnectionChange }: TerminalSessionOptions,
): () => void {
  let view: TerminalView | undefined;
  let exited = false;
  let disposed = false;
  const transport = new ReconnectingTransport(sessionId, {
    getSize: () => view?.size() ?? { cols: 80, rows: 24 },
    onMessage(message) {
      if (message.type === "output") view?.write(message.data);
      else if (message.type === "sync") {
        if (message.reset) view?.reset();
      } else if (message.type === "notify") playNotificationSound();
      else if (message.type === "clipboard") writeClipboard(message.text);
      else if (!message.running) {
        exited = true;
        onConnectionChange("exited");
        transport.close();
      }
    },
    onState(state) {
      if (!exited && !disposed) onConnectionChange(state);
    },
  });
  const disposeSound = unlockNotificationSound();
  const disposeView = attachTerminalView(shell, {
    label: sessionId,
    controls,
    sendInput: (data) => transport.send({ type: "input", data }),
    sendResize: (cols, rows) => transport.send({ type: "resize", cols, rows }),
    onReady(openedView) {
      view = openedView;
      transport.connect();
    },
    onError() {
      onConnectionChange("disconnected");
    },
  });

  // Typed-but-unsent input survives reconnect; transport retains its sequence.
  const reconnect = () => {
    if (navigator.onLine && !disposed && !exited && view) transport.connect();
  };
  const reconnectWhenVisible = () => {
    if (document.visibilityState === "visible") reconnect();
  };
  window.addEventListener("online", reconnect);
  document.addEventListener("visibilitychange", reconnectWhenVisible);

  return () => {
    disposed = true;
    window.removeEventListener("online", reconnect);
    document.removeEventListener("visibilitychange", reconnectWhenVisible);
    transport.close();
    disposeSound();
    disposeView();
    view = undefined;
  };
}
