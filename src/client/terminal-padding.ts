import { type GhosttyCell, type Terminal } from "ghostty-web";
import type { TerminalAppearance, TerminalTheme } from "../shared/protocol";
import {
  balancedOffsets,
  cellBackground,
  cssColor,
  paddingExtension,
  parseHexColor,
  type Insets,
  type Rgb,
} from "./padding-rules";

interface Geometry {
  width: number;
  height: number;
  gridLeft: number;
  gridTop: number;
  gridWidth: number;
  gridHeight: number;
}

export interface PaddingLayout {
  setTheme(theme: TerminalTheme): void;
  dispose(): void;
}

type LineRenderer = { renderLine(...args: unknown[]): void };

export function attachPaddingLayout(
  container: HTMLElement,
  terminal: Terminal,
  appearance: Pick<TerminalAppearance, "paddingBalance" | "paddingColor">,
  theme: TerminalTheme,
): PaddingLayout {
  const renderer = terminal.renderer;
  const wasmTerm = terminal.wasmTerm;
  if (!renderer || !wasmTerm) return { setTheme() {}, dispose() {} };

  const canvas = renderer.getCanvas();
  const extends_ = appearance.paddingColor !== "background";
  const layer = extends_ ? createLayer(container) : undefined;
  let defaultBackground = themeBackground(theme);
  let geometry: Geometry | undefined;

  const explicitPadding = (): Insets => {
    const style = getComputedStyle(container);
    const px = (property: string) =>
      Number.parseFloat(style.getPropertyValue(property)) || 0;
    return {
      top: px("padding-top"),
      right: px("padding-right"),
      bottom: px("padding-bottom"),
      left: px("padding-left"),
    };
  };

  const layout = () => {
    const metrics = renderer.getMetrics();
    const explicit = explicitPadding();
    const width = container.clientWidth;
    const height = container.clientHeight;
    const gridWidth = terminal.cols * metrics.width;
    const gridHeight = terminal.rows * metrics.height;
    const offsets = balancedOffsets({
      leftover: {
        width: width - explicit.left - explicit.right - gridWidth,
        height: height - explicit.top - explicit.bottom - gridHeight,
      },
      explicit,
      cellWidth: metrics.width,
      mode: appearance.paddingBalance,
    });
    canvas.style.marginLeft = `${offsets.left}px`;
    canvas.style.marginTop = `${offsets.top}px`;
    geometry = {
      width,
      height,
      gridLeft: explicit.left + offsets.left,
      gridTop: explicit.top + offsets.top,
      gridWidth,
      gridHeight,
    };
    if (layer) {
      const ratio = window.devicePixelRatio || 1;
      layer.width = Math.round(width * ratio);
      layer.height = Math.round(height * ratio);
      layer.style.width = `${width}px`;
      layer.style.height = `${height}px`;
      layer.getContext("2d")?.setTransform(ratio, 0, 0, ratio, 0, 0);
    }
  };

  const visibleRows = () => {
    const scrolled = Math.floor(terminal.getViewportY());
    const scrollbackLength = terminal.getScrollbackLength();
    const viewport = wasmTerm.getViewport();
    const cols = terminal.cols;
    return (row: number): readonly GhosttyCell[] => {
      if (row < scrolled) {
        return (
          terminal.getScrollbackLine(scrollbackLength - scrolled + row) ?? []
        );
      }
      const start = (row - scrolled) * cols;
      return viewport.slice(start, start + cols);
    };
  };

  const paint = () => {
    const context = layer?.getContext("2d");
    if (!layer || !context || !geometry) return;
    const { width, height, gridLeft, gridTop, gridWidth, gridHeight } =
      geometry;
    const metrics = renderer.getMetrics();
    const rows = terminal.rows;
    const cols = terminal.cols;
    const rowCells = visibleRows();
    const top = rowCells(0);
    const bottom = rowCells(rows - 1);
    const extension = paddingExtension(
      appearance.paddingColor,
      { top, bottom },
      defaultBackground,
    );
    const colorOf = (cell: GhosttyCell | undefined) =>
      cssColor(
        (cell && cellBackground(cell, defaultBackground)) ?? defaultBackground,
      );
    const gridRight = gridLeft + gridWidth;
    const gridBottom = gridTop + gridHeight;

    context.fillStyle = cssColor(defaultBackground);
    context.fillRect(0, 0, width, height);

    const fillColumns = (cells: readonly GhosttyCell[], y: number, h: number) =>
      cells.forEach((cell, col) => {
        if (cell.width === 0) return;
        context.fillStyle = colorOf(cell);
        context.fillRect(
          gridLeft + col * metrics.width,
          y,
          metrics.width * cell.width,
          h,
        );
      });
    if (extension.up) fillColumns(top, 0, gridTop);
    if (extension.down) fillColumns(bottom, gridBottom, height - gridBottom);

    if (extension.left || extension.right) {
      for (let row = 0; row < rows; row++) {
        const cells = rowCells(row);
        const y = gridTop + row * metrics.height;
        if (extension.left) {
          context.fillStyle = colorOf(cells[0]);
          context.fillRect(0, y, gridLeft, metrics.height);
        }
        if (extension.right) {
          context.fillStyle = colorOf(cells[cols - 1]);
          context.fillRect(gridRight, y, width - gridRight, metrics.height);
        }
      }
    }

    const corner = (
      show: boolean,
      cell: GhosttyCell | undefined,
      x: number,
      y: number,
      w: number,
      h: number,
    ) => {
      if (!show) return;
      context.fillStyle = colorOf(cell);
      context.fillRect(x, y, w, h);
    };
    corner(extension.left && extension.up, top[0], 0, 0, gridLeft, gridTop);
    corner(
      extension.right && extension.up,
      top[cols - 1],
      gridRight,
      0,
      width - gridRight,
      gridTop,
    );
    corner(
      extension.left && extension.down,
      bottom[0],
      0,
      gridBottom,
      gridLeft,
      height - gridBottom,
    );
    corner(
      extension.right && extension.down,
      bottom[cols - 1],
      gridRight,
      gridBottom,
      width - gridRight,
      height - gridBottom,
    );
  };

  const gridChanged = () => {
    const metrics = renderer.getMetrics();
    return (
      !geometry ||
      geometry.gridWidth !== terminal.cols * metrics.width ||
      geometry.gridHeight !== terminal.rows * metrics.height
    );
  };

  // ghostty-web never fires onRender, so the renderer itself is observed:
  // renderLine runs for every dirty row and render brackets each frame.
  const lineRenderer = renderer as unknown as LineRenderer;
  const originalRenderLine = lineRenderer.renderLine;
  const originalRender = renderer.render;
  let rowsRepainted = false;
  lineRenderer.renderLine = function (...args) {
    rowsRepainted = true;
    originalRenderLine.apply(this, args);
  };
  renderer.render = function (...args) {
    rowsRepainted = false;
    originalRender.apply(this, args);
    if (gridChanged()) layout();
    if (rowsRepainted) paint();
  };

  const observer = new ResizeObserver(() => {
    layout();
    paint();
  });
  observer.observe(container);
  layout();
  paint();

  return {
    setTheme(nextTheme) {
      defaultBackground = themeBackground(nextTheme);
      paint();
    },
    dispose() {
      observer.disconnect();
      lineRenderer.renderLine = originalRenderLine;
      renderer.render = originalRender;
      layer?.remove();
      canvas.style.marginLeft = "";
      canvas.style.marginTop = "";
    },
  };
}

function createLayer(container: HTMLElement): HTMLCanvasElement {
  const layer = document.createElement("canvas");
  layer.className = "terminal-padding";
  layer.setAttribute("aria-hidden", "true");
  container.prepend(layer);
  return layer;
}

function themeBackground(theme: TerminalTheme): Rgb {
  return parseHexColor(theme.background) ?? { r: 0, g: 0, b: 0 };
}
