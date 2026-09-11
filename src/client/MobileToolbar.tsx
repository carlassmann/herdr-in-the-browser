import { Popover } from "@base-ui/react/popover";
import { CommandLineIcon } from "@heroicons/react/16/solid";
import { encodeModifiedInput } from "./keyboard";
import { useTerminalControls } from "./TerminalControls";

interface MobileToolbarProps {
  sessionId: string;
}

const keys = [
  ["Esc", "\u001b"],
  ["Tab", "\t"],
  ["↑", "\u001b[A"],
  ["↓", "\u001b[B"],
  ["←", "\u001b[D"],
  ["→", "\u001b[C"],
] as const;

export function MobileToolbar({ sessionId }: MobileToolbarProps) {
  const { modifiers, setModifiers, sendInput } = useTerminalControls();
  const { control, alt } = modifiers;

  const modifierPointerDown =
    (modifier: "control" | "alt") => (event: React.PointerEvent) => {
      event.preventDefault();
      setModifiers({
        control: modifier === "control" ? !control : control,
        alt: modifier === "alt" ? !alt : alt,
      });
    };

  return (
    <Popover.Root>
      <Popover.Trigger className="keys-trigger" aria-label="Terminal keys">
        <CommandLineIcon aria-hidden="true" />
        <span>Keys</span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner
          sideOffset={8}
          align="end"
          className="keys-positioner"
        >
          <Popover.Popup className="keys-popup">
            <div
              className="keys-grid"
              role="group"
              aria-label={`Keys for ${sessionId}`}
            >
              <button
                type="button"
                className="key key-modifier"
                aria-pressed={control}
                onPointerDown={modifierPointerDown("control")}
              >
                Ctrl
              </button>
              <button
                type="button"
                className="key key-modifier"
                aria-pressed={alt}
                onPointerDown={modifierPointerDown("alt")}
              >
                Alt
              </button>
              {keys.map(([label, data]) => (
                <button
                  key={label}
                  type="button"
                  className="key"
                  onPointerDown={(event) => {
                    event.preventDefault();
                    const value = encodeModifiedInput(data, { control, alt });
                    sendInput(value);
                    setModifiers({ control: false, alt: false });
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
