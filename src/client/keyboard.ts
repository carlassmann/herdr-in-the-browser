export interface Modifiers {
  control: boolean;
  alt: boolean;
}

const CONTROL_CHARACTERS: Record<string, string> = {
  " ": "\u0000",
  "@": "\u0000",
  "[": "\u001b",
  "\\": "\u001c",
  "]": "\u001d",
  "^": "\u001e",
  _: "\u001f",
  "?": "\u007f",
};

export function encodeModifiedInput(
  data: string,
  modifiers: Modifiers,
): string {
  const encoded = modifiers.control ? controlCharacter(data) : data;
  return modifiers.alt ? `\u001b${encoded}` : encoded;
}

function controlCharacter(data: string): string {
  if (/^[a-z]$/i.test(data)) {
    return String.fromCharCode(data.toUpperCase().charCodeAt(0) & 31);
  }
  return CONTROL_CHARACTERS[data] ?? data;
}
