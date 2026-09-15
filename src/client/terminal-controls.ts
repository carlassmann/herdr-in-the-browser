export interface TerminalModifiers {
  control: boolean;
  alt: boolean;
}

// Shared between the on-screen keys and the terminal: the toolbar latches
// modifiers and sends synthetic input, the terminal consumes and clears them.
export class TerminalControls {
  #modifiers: TerminalModifiers = { control: false, alt: false };
  #listeners = new Set<(modifiers: TerminalModifiers) => void>();
  #inputHandler: (data: string) => void = () => {};

  get modifiers(): TerminalModifiers {
    return this.#modifiers;
  }

  setModifiers(modifiers: TerminalModifiers) {
    this.#modifiers = modifiers;
    for (const listener of this.#listeners) listener(modifiers);
  }

  onModifiersChange(listener: (modifiers: TerminalModifiers) => void) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  sendInput(data: string) {
    this.#inputHandler(data);
  }

  setInputHandler(handler: (data: string) => void) {
    this.#inputHandler = handler;
    return () => {
      if (this.#inputHandler === handler) this.#inputHandler = () => {};
    };
  }
}
