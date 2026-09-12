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

export type WheelDeltaMode = "pixel" | "line" | "page";

export function wheelDeltaMode(deltaMode: number): WheelDeltaMode {
  if (deltaMode === 1) return "line";
  if (deltaMode === 2) return "page";
  return "pixel";
}

// Trackpads fire many small pixel deltas per gesture; a terminal wheel event is
// a whole line, so partial lines carry over until they add up to a full one.
export function createWheelTickAccumulator() {
  let carry = 0;
  return (
    deltaY: number,
    mode: WheelDeltaMode,
    cell: { height: number; rows: number },
  ): number => {
    const lines =
      mode === "pixel"
        ? deltaY / cell.height
        : mode === "page"
          ? deltaY * cell.rows
          : deltaY;
    if (Math.sign(lines) !== Math.sign(carry)) carry = 0;
    carry += lines;
    const ticks = Math.trunc(carry) || 0;
    carry -= ticks;
    return ticks;
  };
}
