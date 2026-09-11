import { useEffect, useRef, useState } from "react";
import { FitAddon, init, Terminal } from "ghostty-web";
import type { TerminalAppearance, TerminalTheme } from "../shared/protocol";
import { encodeModifiedInput } from "./keyboard";
import { encodeTerminalMouse } from "./terminal-mouse";
import { useTerminalControls } from "./TerminalControls";
import { ReconnectingTransport, type TransportState } from "./transport";

const ghosttyReady = init();
const fallbackAppearance: TerminalAppearance = {
  fontFamily: "Geist Mono Variable",
  fontSize: 15,
  padding: { top: 2, right: 2, bottom: 2, left: 2 },
  colorScheme: "system",
  cursorBlink: true,
  cursorStyle: "block",
  theme: { background: "#09090b", foreground: "#e4e4e7", cursor: "#34d399" },
};

interface TerminalViewProps {
  sessionId: string;
  onConnectionChange(state: TransportState): void;
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
    const abortController = new AbortController();
    const disposals: Array<() => void> = [];
    const disposeWithEffect = (dispose: () => void) => {
      if (disposed) dispose();
      else disposals.push(dispose);
    };
    setReady(false);

    void (async () => {
      const [, appearance] = await Promise.all([
        ghosttyReady,
        fetchAppearance(abortController.signal),
      ]);
      if (disposed || !containerRef.current) return;
      const fontFamily = await loadConfiguredFont(appearance);
      if (disposed || !containerRef.current) return;
      const terminalTheme = resolveTerminalTheme(appearance);
      applyAppearanceVariables(appearance, terminalTheme);

      const terminal = new Terminal({
        cursorBlink: appearance.cursorBlink,
        cursorStyle: appearance.cursorStyle,
        fontFamily,
        fontSize: appearance.fontSize,
        cellWidthAdjustment: appearance.cellWidthAdjustment,
        cellHeightAdjustment: appearance.cellHeightAdjustment,
        scrollback: 5000,
        theme: terminalTheme,
      });
      disposeWithEffect(() => terminal.dispose());
      const fitAddon = new FitAddon();
      disposeWithEffect(() => fitAddon.dispose());
      terminal.loadAddon(fitAddon);
      await terminal.open(containerRef.current);
      if (disposed) return;
      terminalRef.current = terminal;
      disposeWithEffect(watchSystemAppearance(appearance, terminal));

      const transport = new ReconnectingTransport(sessionId, {
        onMessage(message) {
          if (message.type === "output") terminal?.write(message.data);
          else if (message.type === "sync") {
            if (message.reset) terminal.reset();
          } else if (!message.connected) onConnectionChange("disconnected");
        },
        onState: onConnectionChange,
        onFreshConnection() {
          transport.send({
            type: "resize",
            cols: terminal.cols,
            rows: terminal.rows,
          });
        },
      });
      disposeWithEffect(() => transport.close());
      transportRef.current = transport;

      const inputSubscription = terminal.onData((data) => {
        const modifiers = modifiersRef.current;
        const transformed = encodeModifiedInput(data, modifiers);
        if (modifiers.control || modifiers.alt) {
          modifiersRef.current = { control: false, alt: false };
          setModifiers({ control: false, alt: false });
        }
        transport.send({ type: "input", data: transformed });
      });
      disposeWithEffect(() => inputSubscription.dispose());
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
      transport.send({
        type: "resize",
        cols: terminal.cols,
        rows: terminal.rows,
      });
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
      abortController.abort();
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

function attachMouseReporting(
  container: HTMLDivElement,
  terminal: Terminal,
  send: (data: string) => void,
): () => void {
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
    if (!terminal.hasMouseTracking() || !terminal.renderer) return false;
    const canvas = terminal.renderer.getCanvas();
    const bounds = canvas.getBoundingClientRect();
    const metrics = terminal.renderer.getMetrics();
    const col = Math.floor((event.clientX - bounds.left) / metrics.width) + 1;
    const row = Math.floor((event.clientY - bounds.top) / metrics.height) + 1;
    if (col < 1 || col > terminal.cols || row < 1 || row > terminal.rows)
      return false;

    send(
      encodeTerminalMouse(
        {
          button: options.motion ? heldButton(event) : pointerButton(event),
          col,
          row,
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
    event.stopPropagation();
    return true;
  };

  const onPointerDown = (event: PointerEvent) => {
    if (!sendPointer(event)) return;
    container.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent) => {
    const anyMotion = terminal.getMode(1003);
    const buttonMotion = terminal.getMode(1002) && event.buttons !== 0;
    if (anyMotion || buttonMotion) sendPointer(event, { motion: true });
  };
  const onPointerUp = (event: PointerEvent) => {
    sendPointer(event, { release: true });
    if (container.hasPointerCapture(event.pointerId)) {
      container.releasePointerCapture(event.pointerId);
    }
  };
  const onContextMenu = (event: MouseEvent) => {
    if (terminal.hasMouseTracking()) event.preventDefault();
  };

  terminal.attachCustomWheelEventHandler((event) => {
    if (!terminal.hasMouseTracking() || !terminal.renderer) return false;
    const canvas = terminal.renderer.getCanvas();
    const bounds = canvas.getBoundingClientRect();
    const metrics = terminal.renderer.getMetrics();
    const col = Math.floor((event.clientX - bounds.left) / metrics.width) + 1;
    const row = Math.floor((event.clientY - bounds.top) / metrics.height) + 1;
    send(
      encodeTerminalMouse(
        {
          button: 3,
          col,
          row,
          wheel: event.deltaY < 0 ? "up" : "down",
          shift: event.shiftKey,
          alt: event.altKey,
          control: event.ctrlKey,
        },
        terminal.getMode(1006),
      ),
    );
    return true;
  });

  container.addEventListener("pointerdown", onPointerDown, true);
  container.addEventListener("pointermove", onPointerMove, true);
  container.addEventListener("pointerup", onPointerUp, true);
  container.addEventListener("pointercancel", onPointerUp, true);
  container.addEventListener("contextmenu", onContextMenu);

  return () => {
    terminal.attachCustomWheelEventHandler(undefined);
    container.removeEventListener("pointerdown", onPointerDown, true);
    container.removeEventListener("pointermove", onPointerMove, true);
    container.removeEventListener("pointerup", onPointerUp, true);
    container.removeEventListener("pointercancel", onPointerUp, true);
    container.removeEventListener("contextmenu", onContextMenu);
  };
}

async function fetchAppearance(
  signal: AbortSignal,
): Promise<TerminalAppearance> {
  try {
    const response = await fetch("/api/appearance", { signal });
    if (!response.ok) return fallbackAppearance;
    return (await response.json()) as TerminalAppearance;
  } catch {
    return fallbackAppearance;
  }
}

async function loadConfiguredFont(
  appearance: TerminalAppearance,
): Promise<string> {
  const configuredFamily = appearance.fontFamily.replace(/["\\]/g, "");
  const faces =
    appearance.fontFaces ??
    (appearance.fontUrl
      ? [
          {
            url: appearance.fontUrl,
            style: "normal" as const,
            weight: "400" as const,
          },
        ]
      : []);
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

function resolveTerminalTheme(appearance: TerminalAppearance): TerminalTheme {
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const useDark =
    appearance.colorScheme === "dark" ||
    (appearance.colorScheme === "system" && prefersDark);
  return (
    (useDark ? appearance.darkTheme : appearance.lightTheme) ?? appearance.theme
  );
}

function applyAppearanceVariables(
  appearance: TerminalAppearance,
  theme: TerminalTheme,
) {
  const root = document.documentElement.style;
  root.setProperty("--terminal-background", theme.background);
  root.setProperty("--terminal-foreground", theme.foreground);
  root.setProperty("--terminal-padding-top", `${appearance.padding.top}px`);
  root.setProperty("--terminal-padding-right", `${appearance.padding.right}px`);
  root.setProperty(
    "--terminal-padding-bottom",
    `${appearance.padding.bottom}px`,
  );
  root.setProperty("--terminal-padding-left", `${appearance.padding.left}px`);
}

function watchSystemAppearance(
  appearance: TerminalAppearance,
  terminal: Terminal,
): () => void {
  if (appearance.colorScheme !== "system") return () => {};
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const update = () => {
    const theme = resolveTerminalTheme(appearance);
    terminal.options.theme = theme;
    applyAppearanceVariables(appearance, theme);
  };
  media.addEventListener("change", update);
  return () => media.removeEventListener("change", update);
}
