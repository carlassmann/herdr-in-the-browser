import { CellFlags, type GhosttyCell } from "ghostty-web";
import type { PaddingBalance, PaddingColor } from "../shared/protocol";

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface PaddingExtension {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
}

interface BalanceOptions {
  leftover: { width: number; height: number };
  explicit: Insets;
  cellWidth: number;
  mode: PaddingBalance;
}

// Mirrors Ghostty's Size.balancePadding: leftover space is split evenly, and
// the `true` mode caps the top so the first row never floats too far down.
export function balancedOffsets({
  leftover,
  explicit,
  cellWidth,
  mode,
}: BalanceOptions): { left: number; top: number } {
  if (mode === "off") return { left: 0, top: 0 };
  const left = Math.floor(Math.max(0, leftover.width) / 2);
  const top = Math.floor(Math.max(0, leftover.height) / 2);
  if (mode === "equal") return { left, top };
  const maxTotalTop = Math.floor(
    (explicit.left + explicit.right + cellWidth) / 2,
  );
  return { left, top: Math.max(0, Math.min(top, maxTotalTop - explicit.top)) };
}

export function parseHexColor(value: string): Rgb | undefined {
  const match = /^#?([0-9a-f]{6})$/i.exec(value.trim());
  if (!match) return;
  const packed = Number.parseInt(match[1]!, 16);
  return { r: packed >> 16, g: (packed >> 8) & 255, b: packed & 255 };
}

const isPowerlineGlyph = (codepoint: number) =>
  (codepoint >= 0xe0b0 && codepoint <= 0xe0c8) ||
  codepoint === 0xe0ca ||
  (codepoint >= 0xe0cc && codepoint <= 0xe0d2) ||
  codepoint === 0xe0d4;

// ghostty-web reports an unset background as pure black, so black is treated
// as default here just like an explicit background matching the theme.
export function cellBackground(
  cell: GhosttyCell,
  defaultBackground: Rgb,
): Rgb | undefined {
  const inverse = (cell.flags & CellFlags.INVERSE) !== 0;
  const background: Rgb = inverse
    ? { r: cell.fg_r, g: cell.fg_g, b: cell.fg_b }
    : { r: cell.bg_r, g: cell.bg_g, b: cell.bg_b };
  const unset = background.r === 0 && background.g === 0 && background.b === 0;
  if (unset || sameColor(background, defaultBackground)) return;
  return background;
}

export function rowNeverExtendsBackground(
  cells: readonly GhosttyCell[],
  defaultBackground: Rgb,
): boolean {
  return cells.some(
    (cell) =>
      isPowerlineGlyph(cell.codepoint) ||
      cellBackground(cell, defaultBackground) === undefined,
  );
}

export function paddingExtension(
  mode: PaddingColor,
  edges: { top: readonly GhosttyCell[]; bottom: readonly GhosttyCell[] },
  defaultBackground: Rgb,
): PaddingExtension {
  if (mode === "background") {
    return { up: false, down: false, left: false, right: false };
  }
  if (mode === "extend-always") {
    return { up: true, down: true, left: true, right: true };
  }
  return {
    left: true,
    right: true,
    up: !rowNeverExtendsBackground(edges.top, defaultBackground),
    down: !rowNeverExtendsBackground(edges.bottom, defaultBackground),
  };
}

const sameColor = (a: Rgb, b: Rgb) => a.r === b.r && a.g === b.g && a.b === b.b;

export const cssColor = ({ r, g, b }: Rgb) => `rgb(${r}, ${g}, ${b})`;
