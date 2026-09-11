export interface Modifiers {
  control: boolean;
  alt: boolean;
}

export function encodeModifiedInput(
  data: string,
  modifiers: Modifiers,
): string {
  let encoded = data;
  if (modifiers.control && /^[a-z]$/i.test(data)) {
    encoded = String.fromCharCode(data.toUpperCase().charCodeAt(0) & 31);
  }
  return modifiers.alt ? `\u001b${encoded}` : encoded;
}
