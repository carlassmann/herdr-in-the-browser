import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

export interface TerminalModifiers {
  control: boolean;
  alt: boolean;
}

interface TerminalControls {
  modifiers: TerminalModifiers;
  setModifiers(modifiers: TerminalModifiers): void;
  sendInput(data: string): void;
  registerInputHandler(handler: (data: string) => void): () => void;
}

const TerminalControlsContext = createContext<TerminalControls | null>(null);

export function TerminalControlsProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [modifiers, setModifiers] = useState<TerminalModifiers>({
    control: false,
    alt: false,
  });
  const inputHandler = useRef<(data: string) => void>(() => {});
  const sendInput = useCallback(
    (data: string) => inputHandler.current(data),
    [],
  );
  const registerInputHandler = useCallback(
    (handler: (data: string) => void) => {
      inputHandler.current = handler;
      return () => {
        if (inputHandler.current === handler) inputHandler.current = () => {};
      };
    },
    [],
  );
  const value = useMemo(
    () => ({ modifiers, setModifiers, sendInput, registerInputHandler }),
    [modifiers, sendInput, registerInputHandler],
  );

  return (
    <TerminalControlsContext.Provider value={value}>
      {children}
    </TerminalControlsContext.Provider>
  );
}

export function useTerminalControls(): TerminalControls {
  const controls = useContext(TerminalControlsContext);
  if (!controls) throw new Error("Terminal controls require their provider.");
  return controls;
}
