export interface TerminalMouseEvent {
  button: 0 | 1 | 2 | 3;
  col: number;
  row: number;
  release?: boolean;
  motion?: boolean;
  wheel?: "up" | "down";
  shift?: boolean;
  alt?: boolean;
  control?: boolean;
}

export function encodeTerminalMouse(
  event: TerminalMouseEvent,
  sgr: boolean,
): string {
  let code =
    event.wheel === "up" ? 64 : event.wheel === "down" ? 65 : event.button;
  if (event.motion) code += 32;
  if (event.shift) code += 4;
  if (event.alt) code += 8;
  if (event.control) code += 16;

  const col = Math.max(1, Math.floor(event.col));
  const row = Math.max(1, Math.floor(event.row));
  if (sgr) return `\u001b[<${code};${col};${row}${event.release ? "m" : "M"}`;

  const legacyCode = event.release ? 3 : code;
  return `\u001b[M${String.fromCharCode(legacyCode + 32, Math.min(col, 223) + 32, Math.min(row, 223) + 32)}`;
}
