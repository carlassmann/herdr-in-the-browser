import { FitAddon, init, Terminal } from "ghostty-web";
import type { TerminalAppearance, TerminalTheme } from "../shared/protocol";
import { TerminalModeTracker } from "../shared/terminal-modes";
import {
  applyAppearance,
  loadAppearance,
  resolveAppearance,
  watchSystemAppearance,
} from "./appearance";
import { writeClipboard } from "./clipboard";
import { el } from "./dom";
import {
  encodeModifiedInput,
  TerminalKeyEncoder,
  type Modifiers,
} from "./keyboard";
import {
  playNotificationSound,
  unlockNotificationSound,
} from "./notification-sound";
import type { TerminalControls } from "./terminal-controls";
import {
  createWheelTickAccumulator,
  encodeTerminalMouse,
  wheelDeltaMode,
} from "./terminal-mouse";
import { attachPaddingLayout } from "./terminal-padding";
import { ReconnectingTransport, type TransportState } from "./transport";

const ghosttyReady = init();

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
  const container = el("div", {
    class: "terminal-canvas",
    "aria-label": `Terminal ${sessionId}`,
  });
  shell.dataset.ready = "false";
  shell.append(container);

  let terminal: Terminal | undefined;
  let transport: ReconnectingTransport | undefined;
  let disposed = false;
  const disposals: Array<() => void> = [];
  const disposeWithEffect = (dispose: () => void) => {
    if (disposed) dispose();
    else disposals.push(dispose);
  };

  const focusTerminal = () => terminal?.focus();
  shell.addEventListener("pointerdown", focusTerminal);
  disposeWithEffect(controls.onModifiersChange(focusTerminal));
  disposeWithEffect(
    controls.setInputHandler((data) => {
      transport?.send({ type: "input", data });
      focusTerminal();
    }),
  );

  void (async () => {
    const [, appearance] = await Promise.all([ghosttyReady, loadAppearance()]);
    if (disposed) return;
    const fontFamily = await loadConfiguredFont(appearance);
    if (disposed) return;
    applyAppearance(appearance);
    const { theme } = resolveAppearance(appearance);

    const openedTerminal = new Terminal({
      cursorBlink: appearance.cursorBlink,
      cursorStyle: appearance.cursorStyle,
      fontFamily,
      fontSize: appearance.fontSize,
      cellWidthAdjustment: appearance.cellWidthAdjustment,
      cellHeightAdjustment: appearance.cellHeightAdjustment,
      scrollback: 5000,
      theme,
    });
    disposeWithEffect(() => openedTerminal.dispose());
    const fitAddon = new FitAddon();
    disposeWithEffect(() => fitAddon.dispose());
    openedTerminal.loadAddon(fitAddon);
    await openedTerminal.open(container);
    if (disposed) return;
    terminal = openedTerminal;
    const paddingLayout = attachPaddingLayout(
      container,
      openedTerminal,
      appearance,
      theme,
    );
    disposeWithEffect(() => paddingLayout.dispose());
    if (appearance.colorScheme === "system") {
      disposeWithEffect(
        watchSystemAppearance(() => {
          applyAppearance(appearance);
          const { theme: nextTheme } = resolveAppearance(appearance);
          repaintWithTheme(openedTerminal, nextTheme);
          paddingLayout.setTheme(nextTheme);
        }),
      );
    }

    let exited = false;
    const modes = new TerminalModeTracker();
    const openedTransport = new ReconnectingTransport(sessionId, {
      getSize: () => ({
        cols: openedTerminal.cols,
        rows: openedTerminal.rows,
      }),
      onMessage(message) {
        if (message.type === "output") {
          modes.observe(message.data);
          openedTerminal.write(message.data);
        } else if (message.type === "sync") {
          if (message.reset) {
            openedTerminal.reset();
            modes.reset();
          }
        } else if (message.type === "notify") {
          playNotificationSound();
        } else if (message.type === "clipboard") {
          writeClipboard(message.text);
        } else if (!message.running) {
          exited = true;
          onConnectionChange("exited");
          openedTransport.close();
        }
      },
      onState(state) {
        if (!exited) onConnectionChange(state);
      },
    });
    disposeWithEffect(() => openedTransport.close());
    disposeWithEffect(unlockNotificationSound());
    transport = openedTransport;

    const releaseModifiers = () =>
      controls.setModifiers({ control: false, alt: false });
    const inputSubscription = openedTerminal.onData((data) => {
      const modifiers = controls.modifiers;
      const transformed = encodeModifiedInput(data, modifiers);
      if (modifiers.control || modifiers.alt) releaseModifiers();
      openedTransport.send({ type: "input", data: transformed });
    });
    disposeWithEffect(() => inputSubscription.dispose());
    disposeWithEffect(
      attachKeyboardInput(container, openedTerminal, modes, {
        heldModifiers: () => controls.modifiers,
        releaseModifiers,
        send: (data) => openedTransport.send({ type: "input", data }),
      }),
    );
    const resizeSubscription = openedTerminal.onResize(({ cols, rows }) =>
      openedTransport.send({ type: "resize", cols, rows }),
    );
    disposeWithEffect(() => resizeSubscription.dispose());
    disposeWithEffect(
      attachMouseReporting(container, openedTerminal, (data) =>
        openedTransport.send({ type: "input", data }),
      ),
    );
    fitAddon.fit();
    fitAddon.observeResize();
    openedTransport.connect();
    if (disposed) return;
    shell.dataset.ready = "true";
    openedTerminal.focus();
  })().catch(() => {
    if (!disposed) onConnectionChange("disconnected");
  });

  const reconnect = () => {
    if (navigator.onLine && !disposed) {
      transport?.close();
      transport?.connect();
    }
  };
  const reconnectWhenVisible = () => {
    if (document.visibilityState === "visible") reconnect();
  };
  window.addEventListener("online", reconnect);
  document.addEventListener("visibilitychange", reconnectWhenVisible);

  return () => {
    disposed = true;
    shell.removeEventListener("pointerdown", focusTerminal);
    window.removeEventListener("online", reconnect);
    document.removeEventListener("visibilitychange", reconnectWhenVisible);
    while (disposals.length) disposals.pop()?.();
    transport = undefined;
    terminal = undefined;
    container.remove();
  };
}

interface KeyboardInputSink {
  heldModifiers(): Modifiers;
  releaseModifiers(): void;
  send(data: string): void;
}

// ghostty-web's own key handling ignores the keyboard protocol an application
// negotiated, drops Shift from Enter and friends, and pastes without
// bracketing. Take over key, paste, and focus events and encode them the way
// native Ghostty does.
function attachKeyboardInput(
  container: HTMLElement,
  terminal: Terminal,
  modes: TerminalModeTracker,
  sink: KeyboardInputSink,
): () => void {
  const keys = new TerminalKeyEncoder(terminal.ghostty.createKeyEncoder(), {
    optionAsAlt: true,
  });

  terminal.attachCustomKeyEventHandler((event) => {
    const held = sink.heldModifiers();
    const data = keys.encode(event, held, {
      kittyFlags: modes.kittyFlags,
      modifyOtherKeys: modes.modifyOtherKeys,
      applicationCursorKeys: terminal.getMode(1),
      applicationKeypad: terminal.getMode(66),
    });
    if (data === undefined) return false;
    if (held.control || held.alt) sink.releaseModifiers();
    if (data) sink.send(data);
    return true;
  });

  const onPaste = (event: ClipboardEvent) => {
    const text = event.clipboardData?.getData("text/plain");
    if (!text) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    sink.send(terminal.getMode(2004) ? `\u001b[200~${text}\u001b[201~` : text);
  };
  const onFocusIn = () => {
    if (terminal.getMode(1004)) sink.send("\u001b[I");
  };
  const onFocusOut = () => {
    if (terminal.getMode(1004)) sink.send("\u001b[O");
  };
  container.addEventListener("paste", onPaste, true);
  container.addEventListener("focusin", onFocusIn);
  container.addEventListener("focusout", onFocusOut);

  return () => {
    terminal.attachCustomKeyEventHandler(() => false);
    container.removeEventListener("paste", onPaste, true);
    container.removeEventListener("focusin", onFocusIn);
    container.removeEventListener("focusout", onFocusOut);
    keys.dispose();
  };
}

function attachMouseReporting(
  container: HTMLElement,
  terminal: Terminal,
  send: (data: string) => void,
): () => void {
  let forwardedPointer: number | undefined;

  const reportsMouse = () =>
    terminal.hasMouseTracking() && Boolean(terminal.renderer);

  // Like Ghostty, Shift bypasses mouse reporting so text stays selectable.
  const bypassesReporting = (event: MouseEvent) => event.shiftKey;

  const cellAt = (event: { clientX: number; clientY: number }) => {
    const renderer = terminal.renderer!;
    const bounds = renderer.getCanvas().getBoundingClientRect();
    const metrics = renderer.getMetrics();
    const col = Math.floor((event.clientX - bounds.left) / metrics.width) + 1;
    const row = Math.floor((event.clientY - bounds.top) / metrics.height) + 1;
    return {
      col: Math.min(terminal.cols, Math.max(1, col)),
      row: Math.min(terminal.rows, Math.max(1, row)),
    };
  };

  const pointerButton = (event: PointerEvent): 0 | 1 | 2 | 3 => {
    if (event.button === 1) return 1;
    if (event.button === 2) return 2;
    return event.button === 0 ? 0 : 3;
  };

  const heldButton = (event: PointerEvent): 0 | 1 | 2 | 3 => {
    if (event.buttons & 1) return 0;
    if (event.buttons & 4) return 1;
    if (event.buttons & 2) return 2;
    return 3;
  };

  const sendPointer = (
    event: PointerEvent,
    options: { release?: boolean; motion?: boolean } = {},
  ) => {
    send(
      encodeTerminalMouse(
        {
          button: options.motion ? heldButton(event) : pointerButton(event),
          ...cellAt(event),
          release: options.release,
          motion: options.motion,
          shift: event.shiftKey,
          alt: event.altKey,
          control: event.ctrlKey,
        },
        terminal.getMode(1006),
      ),
    );
    event.preventDefault();
  };

  const onPointerDown = (event: PointerEvent) => {
    if (!reportsMouse() || bypassesReporting(event)) return;
    terminal.focus();
    sendPointer(event);
    forwardedPointer = event.pointerId;
    container.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent) => {
    if (!reportsMouse()) return;
    const dragging =
      forwardedPointer === event.pointerId && event.buttons !== 0;
    const anyMotion = terminal.getMode(1003) && !bypassesReporting(event);
    if (dragging || anyMotion) sendPointer(event, { motion: true });
  };
  const onPointerUp = (event: PointerEvent) => {
    if (forwardedPointer !== event.pointerId) return;
    forwardedPointer = undefined;
    if (reportsMouse()) sendPointer(event, { release: true });
    if (container.hasPointerCapture(event.pointerId)) {
      container.releasePointerCapture(event.pointerId);
    }
  };
  const suppressWhileReporting = (event: MouseEvent) => {
    if (!reportsMouse() || bypassesReporting(event)) return;
    event.preventDefault();
    event.stopPropagation();
  };

  const wheelTicks = createWheelTickAccumulator();
  terminal.attachCustomWheelEventHandler((event) => {
    if (!reportsMouse() || bypassesReporting(event)) return false;
    const ticks = wheelTicks(event.deltaY, wheelDeltaMode(event.deltaMode), {
      height: terminal.renderer!.getMetrics().height,
      rows: terminal.rows,
    });
    const wheelEvent = encodeTerminalMouse(
      {
        button: 3,
        ...cellAt(event),
        wheel: ticks < 0 ? "up" : "down",
        shift: event.shiftKey,
        alt: event.altKey,
        control: event.ctrlKey,
      },
      terminal.getMode(1006),
    );
    for (let i = 0; i < Math.abs(ticks); i++) send(wheelEvent);
    return true;
  });

  container.addEventListener("pointerdown", onPointerDown, true);
  container.addEventListener("pointermove", onPointerMove, true);
  container.addEventListener("pointerup", onPointerUp, true);
  container.addEventListener("pointercancel", onPointerUp, true);
  container.addEventListener("dblclick", suppressWhileReporting, true);
  container.addEventListener("contextmenu", suppressWhileReporting, true);

  return () => {
    terminal.attachCustomWheelEventHandler(undefined);
    container.removeEventListener("pointerdown", onPointerDown, true);
    container.removeEventListener("pointermove", onPointerMove, true);
    container.removeEventListener("pointerup", onPointerUp, true);
    container.removeEventListener("pointercancel", onPointerUp, true);
    container.removeEventListener("dblclick", suppressWhileReporting, true);
    container.removeEventListener("contextmenu", suppressWhileReporting, true);
  };
}

// ghostty-web does not support a theme change through `terminal.options`, so
// the renderer is retinted directly and asked for one full repaint.
function repaintWithTheme(terminal: Terminal, theme: TerminalTheme): void {
  const { renderer, wasmTerm } = terminal;
  if (!renderer || !wasmTerm) return;
  renderer.setTheme(theme);
  renderer.render(wasmTerm, true, terminal.getViewportY(), terminal);
}

let configuredFontPromise: Promise<string> | undefined;

function loadConfiguredFont(appearance: TerminalAppearance): Promise<string> {
  configuredFontPromise ??= addConfiguredFontFaces(appearance);
  return configuredFontPromise;
}

async function addConfiguredFontFaces(
  appearance: TerminalAppearance,
): Promise<string> {
  const configuredFamily = appearance.fontFamily.replace(/["\\]/g, "");
  const faces = appearance.fontFaces ?? [];
  if (!faces.length) {
    return `"${configuredFamily}", "Geist Mono Variable", ui-monospace, monospace`;
  }

  try {
    const loadedFaces = await Promise.all(
      faces.map((face) =>
        new FontFace("Herdr Ghostty Font", `url(${face.url})`, {
          style: face.style,
          weight: face.weight,
        }).load(),
      ),
    );
    loadedFaces.forEach((font) => document.fonts.add(font));
    return '"Herdr Ghostty Font", "Geist Mono Variable", ui-monospace, monospace';
  } catch {
    return `"${configuredFamily}", "Geist Mono Variable", ui-monospace, monospace`;
  }
}
