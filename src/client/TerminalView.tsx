import { useEffect, useRef, useState } from "react";
import { FitAddon, init, Terminal } from "ghostty-web";
import type { TerminalAppearance, TerminalTheme } from "../shared/protocol";
import {
  applyAppearance,
  loadAppearance,
  resolveAppearance,
  watchSystemAppearance,
} from "./appearance";
import { TerminalModeTracker } from "../shared/terminal-modes";
import {
  encodeModifiedInput,
  TerminalKeyEncoder,
  type Modifiers,
} from "./keyboard";
import {
  createWheelTickAccumulator,
  encodeTerminalMouse,
  wheelDeltaMode,
} from "./terminal-mouse";
import { attachPaddingLayout } from "./terminal-padding";
import { useTerminalControls } from "./TerminalControls";
import {
  playNotificationSound,
  unlockNotificationSound,
} from "./notification-sound";
import { ReconnectingTransport, type TransportState } from "./transport";

const ghosttyReady = init();

export type SessionState = TransportState | "exited";

interface TerminalViewProps {
  sessionId: string;
  onConnectionChange(state: SessionState): void;
}

export function TerminalView({
  sessionId,
  onConnectionChange,
}: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | undefined>(undefined);
  const transportRef = useRef<ReconnectingTransport | undefined>(undefined);
  const modifiersRef = useRef({ control: false, alt: false });
  const [ready, setReady] = useState(false);
  const { modifiers, setModifiers, registerInputHandler } =
    useTerminalControls();

  useEffect(() => {
    modifiersRef.current = modifiers;
    terminalRef.current?.focus();
  }, [modifiers]);

  useEffect(
    () =>
      registerInputHandler((data) => {
        transportRef.current?.send({ type: "input", data });
        terminalRef.current?.focus();
      }),
    [registerInputHandler],
  );

  useEffect(() => {
    let disposed = false;
    const disposals: Array<() => void> = [];
    const disposeWithEffect = (dispose: () => void) => {
      if (disposed) dispose();
      else disposals.push(dispose);
    };
    setReady(false);

    void (async () => {
      const [, appearance] = await Promise.all([
        ghosttyReady,
        loadAppearance(),
      ]);
      if (disposed || !containerRef.current) return;
      const fontFamily = await loadConfiguredFont(appearance);
      if (disposed || !containerRef.current) return;
      applyAppearance(appearance);
      const { theme } = resolveAppearance(appearance);

      const terminal = new Terminal({
        cursorBlink: appearance.cursorBlink,
        cursorStyle: appearance.cursorStyle,
        fontFamily,
        fontSize: appearance.fontSize,
        cellWidthAdjustment: appearance.cellWidthAdjustment,
        cellHeightAdjustment: appearance.cellHeightAdjustment,
        scrollback: 5000,
        theme,
      });
      disposeWithEffect(() => terminal.dispose());
      const fitAddon = new FitAddon();
      disposeWithEffect(() => fitAddon.dispose());
      terminal.loadAddon(fitAddon);
      await terminal.open(containerRef.current);
      if (disposed) return;
      terminalRef.current = terminal;
      const paddingLayout = attachPaddingLayout(
        containerRef.current,
        terminal,
        appearance,
        theme,
      );
      disposeWithEffect(() => paddingLayout.dispose());
      if (appearance.colorScheme === "system") {
        disposeWithEffect(
          watchSystemAppearance(() => {
            applyAppearance(appearance);
            const { theme: nextTheme } = resolveAppearance(appearance);
            repaintWithTheme(terminal, nextTheme);
            paddingLayout.setTheme(nextTheme);
          }),
        );
      }

      let exited = false;
      const modes = new TerminalModeTracker();
      const transport = new ReconnectingTransport(sessionId, {
        getSize: () => ({ cols: terminal.cols, rows: terminal.rows }),
        onMessage(message) {
          if (message.type === "output") {
            modes.observe(message.data);
            terminal.write(message.data);
          } else if (message.type === "sync") {
            if (message.reset) {
              terminal.reset();
              modes.reset();
            }
          } else if (message.type === "notify") {
            playNotificationSound();
          } else if (!message.running) {
            exited = true;
            onConnectionChange("exited");
            transport.close();
          }
        },
        onState(state) {
          if (!exited) onConnectionChange(state);
        },
      });
      disposeWithEffect(() => transport.close());
      disposeWithEffect(unlockNotificationSound());
      transportRef.current = transport;

      const releaseModifiers = () => {
        modifiersRef.current = { control: false, alt: false };
        setModifiers({ control: false, alt: false });
      };
      const inputSubscription = terminal.onData((data) => {
        const modifiers = modifiersRef.current;
        const transformed = encodeModifiedInput(data, modifiers);
        if (modifiers.control || modifiers.alt) releaseModifiers();
        transport.send({ type: "input", data: transformed });
      });
      disposeWithEffect(() => inputSubscription.dispose());
      disposeWithEffect(
        attachKeyboardInput(containerRef.current, terminal, modes, {
          heldModifiers: () => modifiersRef.current,
          releaseModifiers,
          send: (data) => transport.send({ type: "input", data }),
        }),
      );
      const resizeSubscription = terminal.onResize(({ cols, rows }) =>
        transport.send({ type: "resize", cols, rows }),
      );
      disposeWithEffect(() => resizeSubscription.dispose());
      disposeWithEffect(
        attachMouseReporting(containerRef.current, terminal, (data) =>
          transport.send({ type: "input", data }),
        ),
      );
      fitAddon.fit();
      fitAddon.observeResize();
      transport.connect();
      if (disposed) return;
      setReady(true);
      terminal.focus();
    })().catch(() => {
      if (!disposed) onConnectionChange("disconnected");
    });

    const reconnect = () => {
      if (navigator.onLine && !disposed) {
        transportRef.current?.close();
        transportRef.current?.connect();
      }
    };
    window.addEventListener("online", reconnect);
    const reconnectWhenVisible = () => {
      if (document.visibilityState === "visible") reconnect();
    };
    document.addEventListener("visibilitychange", reconnectWhenVisible);

    return () => {
      disposed = true;
      window.removeEventListener("online", reconnect);
      document.removeEventListener("visibilitychange", reconnectWhenVisible);
      while (disposals.length) disposals.pop()?.();
      transportRef.current = undefined;
      terminalRef.current = undefined;
    };
  }, [sessionId, onConnectionChange, setModifiers]);

  return (
    <div
      className="terminal-shell"
      data-ready={ready}
      onPointerDown={() => terminalRef.current?.focus()}
    >
      <div
        ref={containerRef}
        className="terminal-canvas"
        aria-label={`Terminal ${sessionId}`}
      />
    </div>
  );
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
  container: HTMLDivElement,
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
  container: HTMLDivElement,
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
