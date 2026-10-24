/**
 * Canvas layout in pixels. The grid has fixed-size cells so arrows (drawn in SVG) and boxes
 * (laid out by CSS grid) line up exactly; builder.css reads these through CSS variables set
 * inline by the canvas, so they are defined once, here.
 *
 * ASSUMPTION: 9 × 118 px by 5 × 100 px (1062 × 500) fits beside a 300 px settings panel inside the
 * app's 1400 px content width at a 1440 × 900 viewport, with the palette above, without scrolling.
 */
import type { BuilderEdge, BuilderGraph, BuilderNode } from '../../builder/graph';

export const CELL_W = 118;
export const CELL_H = 100;
/** Space between a box and the edge of its cell. */
export const INSET_X = 6;
export const INSET_Y = 8;
export const BOX_W = CELL_W - 2 * INSET_X;
export const BOX_H = CELL_H - 2 * INSET_Y;
/** Gap between an arrow's tip and the box it points at. */
const TIP_GAP = 3;
/** How far apart two opposite calls between the same pair are drawn, so both stay visible. */
const PAIR_OFFSET = 7;

export interface Point {
  x: number;
  y: number;
}

export function cellCenter(col: number, row: number): Point {
  return { x: (col - 0.5) * CELL_W, y: (row - 0.5) * CELL_H };
}

/** Where a ray from a box's centre in direction (dx, dy) leaves the box (plus `gap`). */
export function boxExit(center: Point, dx: number, dy: number, gap = TIP_GAP): Point {
  const hw = BOX_W / 2 + gap;
  const hh = BOX_H / 2 + gap;
  const t = Math.min(dx === 0 ? Infinity : hw / Math.abs(dx), dy === 0 ? Infinity : hh / Math.abs(dy));
  return { x: center.x + t * dx, y: center.y + t * dy };
}

export interface EdgeLine {
  start: Point;
  end: Point;
  /** Midpoint, where the arrow's label goes. */
  mid: Point;
}

/**
 * The visible segment of an arrow from one box to another: from the edge of the caller's box to
 * the edge of the callee's. When the callee also calls the caller back, each arrow is shifted to
 * its own side so the two don't overlap.
 */
export function edgeLine(from: BuilderNode, to: BuilderNode, twoWay: boolean): EdgeLine {
  let a = cellCenter(from.col, from.row);
  let b = cellCenter(to.col, to.row);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  if (twoWay) {
    // Shift to the right of the direction of travel (in screen coordinates).
    const ox = (-dy / length) * PAIR_OFFSET;
    const oy = (dx / length) * PAIR_OFFSET;
    a = { x: a.x + ox, y: a.y + oy };
    b = { x: b.x + ox, y: b.y + oy };
  }
  const start = boxExit(a, dx, dy);
  const end = boxExit(b, -dx, -dy);
  return { start, end, mid: { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 } };
}

/** Each edge with its line, skipping any whose ends are missing. */
export function edgeLines(graph: BuilderGraph): Array<{ edge: BuilderEdge; line: EdgeLine }> {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const out: Array<{ edge: BuilderEdge; line: EdgeLine }> = [];
  for (const edge of graph.edges) {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (!from || !to) continue;
    const twoWay = graph.edges.some((e) => e.from === edge.to && e.to === edge.from);
    out.push({ edge, line: edgeLine(from, to, twoWay) });
  }
  return out;
}
