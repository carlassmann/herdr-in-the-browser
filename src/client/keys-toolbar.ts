import { el } from "./dom";
import { commandLineIcon } from "./icons";
import { encodeModifiedInput } from "./keyboard";
import { openPopover, type Overlay } from "./overlays";
import type { TerminalControls } from "./terminal-controls";

const keys = [
  ["Esc", ""],
  ["Tab", "\t"],
  ["↑", "[A"],
  ["↓", "[B"],
  ["←", "[D"],
  ["→", "[C"],
] as const;

export function createKeysToolbar(
  sessionId: string,
  controls: TerminalControls,
): HTMLButtonElement {
  let popover: Overlay | undefined;

  const trigger = el(
    "button",
    {
      type: "button",
      class: "keys-trigger",
      "aria-label": "Terminal keys",
      "aria-expanded": "false",
      onclick: () => {
        if (popover?.open) popover.close();
        else popover = openKeysPopover(trigger, sessionId, controls);
      },
    },
    commandLineIcon(),
    el("span", {}, "Keys"),
  );

  return trigger;
}

function openKeysPopover(
  trigger: HTMLElement,
  sessionId: string,
  controls: TerminalControls,
): Overlay {
  const modifierKey = (label: string, modifier: "control" | "alt") =>
    el(
      "button",
      {
        type: "button",
        class: "key key-modifier",
        "aria-pressed": String(controls.modifiers[modifier]),
        onpointerdown: (event: Event) => {
          event.preventDefault();
          controls.setModifiers({
            ...controls.modifiers,
            [modifier]: !controls.modifiers[modifier],
          });
        },
      },
      label,
    );

  const control = modifierKey("Ctrl", "control");
  const alt = modifierKey("Alt", "alt");

  const grid = el(
    "div",
    {
      class: "keys-grid",
      role: "group",
      "aria-label": `Keys for ${sessionId}`,
    },
    control,
    alt,
    ...keys.map(([label, data]) =>
      el(
        "button",
        {
          type: "button",
          class: "key",
          onpointerdown: (event: Event) => {
            event.preventDefault();
            controls.sendInput(encodeModifiedInput(data, controls.modifiers));
            controls.setModifiers({ control: false, alt: false });
          },
        },
        label,
      ),
    ),
  );

  const unsubscribe = controls.onModifiersChange((modifiers) => {
    control.setAttribute("aria-pressed", String(modifiers.control));
    alt.setAttribute("aria-pressed", String(modifiers.alt));
  });

  return openPopover({
    trigger,
    popup: el("div", { class: "keys-popup" }, grid),
    onClose: unsubscribe,
  });
}
