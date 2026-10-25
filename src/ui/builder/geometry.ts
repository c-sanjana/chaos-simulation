/**
 * Canvas layout in pixels. The grid has fixed-size cells so arrows (drawn in SVG) and boxes
 * (laid out by CSS grid) line up exactly; builder.css reads these through CSS variables set
 * inline by the canvas, so they are defined once, here.
 *
 * ASSUMPTION: 9 × 118 px by 5 × 96 px (1062 × 480, plus a 1 px border) fits beside a 288 px
 * settings panel inside the app's 1400 px content width at a 1440 × 900 viewport, with the toolbar
 * and palette above and up to three problems below, without scrolling. An 80 px box holds a
 * one-line name, its kind and two lines of numbers; a two-line name may cut the last line short
 * (the full text is in its tooltip).
 */
import { GRID_COLS, GRID_ROWS, inGrid } from '../../builder/edit';
import type { BuilderEdge, BuilderGraph, BuilderNode } from '../../builder/graph';

export const CELL_W = 118;
export const CELL_H = 96;
/** Space between a box and the edge of its cell. */
export const INSET_X = 3;
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

/** Which side of its arrow a label sits on, so it never covers the arrow itself. */
export type LabelSide = 'above' | 'below' | 'left' | 'right';

export interface EdgeLine {
  start: Point;
  end: Point;
  /**
   * The line's corners from start to end: just [start, end] for a straight arrow; an arrow that a
   * straight line would draw under another box bends through empty cells instead (routeAround).
   */
  points: Point[];
  /** Where the arrow's label is anchored (see `labelSide`). */
  mid: Point;
  /**
   * Mostly horizontal arrows get their label above (a two-way pair: each on its own outer side),
   * mostly vertical ones beside them, on the right (a pair: each on its own outer side).
   */
  labelSide: LabelSide;
  /** The label is too wide for any place beside the line on one line, so it takes two (wrapLabel). */
  labelWrap?: boolean;
}

/** A label on two lines: "33% · 2 s · 1 retry" → ["33% · 2 s", "1 retry"] (split at its last " · "). */
export function wrapLabel(text: string): [string] | [string, string] {
  const at = text.lastIndexOf(' · ');
  return at < 0 ? [text] : [text.slice(0, at), text.slice(at + 3)];
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
  // A pair is shifted to the right of travel: going right that is down, going down it is left.
  const horizontal = Math.abs(dx) >= Math.abs(dy);
  const labelSide: LabelSide = horizontal ? (twoWay && dx > 0 ? 'below' : 'above') : twoWay && dy > 0 ? 'left' : 'right';
  return { start, end, points: [start, end], mid: { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }, labelSide };
}

/** A box's rectangle on the canvas. */
interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function boxRect(n: BuilderNode): Rect {
  const c = cellCenter(n.col, n.row);
  return { left: c.x - BOX_W / 2, top: c.y - BOX_H / 2, right: c.x + BOX_W / 2, bottom: c.y + BOX_H / 2 };
}

const overlaps = (a: Rect, b: Rect) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

/** Whether the segment p→q passes through the rectangle (Liang–Barsky clipping). */
export function segmentHitsRect(p: Point, q: Point, r: Rect): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  for (const [step, room] of [[-dx, p.x - r.left], [dx, r.right - p.x], [-dy, p.y - r.top], [dy, r.bottom - p.y]]) {
    if (step === 0) {
      if (room < 0) return false;
      continue;
    }
    const t = room / step;
    if (step < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return false;
  }
  return true;
}

/**
 * The cells an arrow passes through when a straight line would run under another box: the
 * fewest steps (then the fewest bends) from the caller's cell to the callee's, moving up, down,
 * left or right through empty cells only. Null when there is no such way (then it stays straight).
 */
function routeAround(graph: BuilderGraph, from: BuilderNode, to: BuilderNode): Array<{ col: number; row: number }> | null {
  const taken = new Set(graph.nodes.map((n) => `${n.col}:${n.row}`));
  type State = { col: number; row: number; dir: number; cost: number; path: Array<{ col: number; row: number }> };
  const steps = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const best = new Map<string, number>();
  const open: State[] = [{ col: from.col, row: from.row, dir: -1, cost: 0, path: [] }];
  while (open.length > 0) {
    open.sort((x, y) => x.cost - y.cost);
    const s = open.shift()!;
    for (const [d, [dc, dr]] of steps.entries()) {
      const col = s.col + dc;
      const row = s.row + dr;
      if (!inGrid(col, row)) continue;
      // A bend costs a little, so the way with the fewest corners wins among equally short ones.
      const cost = s.cost + 1 + (s.dir >= 0 && s.dir !== d ? 0.4 : 0);
      if (col === to.col && row === to.row) return s.path;
      if (taken.has(`${col}:${row}`)) continue;
      const key = `${col}:${row}:${d}`;
      if ((best.get(key) ?? Infinity) <= cost) continue;
      best.set(key, cost);
      open.push({ col, row, dir: d, cost, path: [...s.path, { col, row }] });
    }
  }
  return null;
}

/** The line through `cells` (cell centres), from the caller's box edge to the callee's, without corners that don't turn. */
function bentLine(from: BuilderNode, to: BuilderNode, cells: Array<{ col: number; row: number }>): Point[] {
  const a = cellCenter(from.col, from.row);
  const b = cellCenter(to.col, to.row);
  const inner = cells.map((c) => cellCenter(c.col, c.row));
  const first = inner[0];
  const last = inner[inner.length - 1];
  const all = [boxExit(a, first.x - a.x, first.y - a.y), ...inner, boxExit(b, last.x - b.x, last.y - b.y)];
  return all.filter((p, i) => i === 0 || i === all.length - 1 || !((all[i - 1].x === p.x && p.x === all[i + 1].x) || (all[i - 1].y === p.y && p.y === all[i + 1].y)));
}

/** Estimated size of an arrow's label (11 px monospace, padding and border), in px; `wrap`: on two lines (wrapLabel). */
export function labelSize(text: string, wrap = false): { w: number; h: number } {
  const lines = wrap ? wrapLabel(text) : [text];
  return { w: Math.max(...lines.map((l) => Array.from(l).length)) * 6.7 + 14, h: 4 + 14 * lines.length };
}

/** Where a label anchored at `at` on `side` sits (as .csl-bcanvas__edge-label--<side> places it). */
function labelRect(at: Point, side: LabelSide, size: { w: number; h: number }): Rect {
  if (side === 'above') return { left: at.x - size.w / 2, right: at.x + size.w / 2, top: at.y - 3 - size.h, bottom: at.y - 3 };
  if (side === 'below') return { left: at.x - size.w / 2, right: at.x + size.w / 2, top: at.y + 3, bottom: at.y + 3 + size.h };
  if (side === 'right') return { left: at.x + 5, right: at.x + 5 + size.w, top: at.y - size.h / 2, bottom: at.y + size.h / 2 };
  return { left: at.x - 5 - size.w, right: at.x - 5, top: at.y - size.h / 2, bottom: at.y + size.h / 2 };
}

/**
 * Each edge with its line, skipping any whose ends are missing. A line that would run under
 * another box bends through empty cells instead (when there is a way); each label goes where it
 * covers no box and no label placed before it: the middle of its line (or of the longest part of
 * a bent one), else further along or on the other side. `labelText` gives a label's text, to
 * estimate its size (labels are left where they are without it).
 * ASSUMPTION: boxes in touching cells leave no room for an arrow's label; the label then goes
 * where it covers least (the first place tried).
 */
export function edgeLines(graph: BuilderGraph, labelText?: (edge: BuilderEdge) => string): Array<{ edge: BuilderEdge; line: EdgeLine }> {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const boxes = graph.nodes.map((n) => ({ id: n.id, rect: boxRect(n) }));
  const placed: Rect[] = [];
  const out: Array<{ edge: BuilderEdge; line: EdgeLine }> = [];
  for (const edge of graph.edges) {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (!from || !to) continue;
    const twoWay = graph.edges.some((e) => e.from === edge.to && e.to === edge.from);
    let line = edgeLine(from, to, twoWay);
    const under = (p: Point, q: Point) => boxes.some((b) => b.id !== from.id && b.id !== to.id && segmentHitsRect(p, q, b.rect));
    if (under(line.start, line.end)) {
      const cells = routeAround(graph, from, to);
      if (cells && cells.length > 0) {
        const points = bentLine(from, to, cells);
        // The label goes by the longest part of the line, beside it.
        const parts = points.slice(1).map((q, i) => [points[i], q] as const);
        const size = ([p, q]: readonly [Point, Point]) => Math.hypot(q.x - p.x, q.y - p.y);
        const [p, q] = parts.reduce((x, y) => (size(y) > size(x) ? y : x));
        line = { start: points[0], end: points[points.length - 1], points, mid: { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 }, labelSide: p.y === q.y ? 'above' : 'right' };
      }
    }
    if (labelText) {
      const avoid = [...boxes.map((b) => b.rect), ...placed];
      // Beside the line on one line where it fits; else on two (a narrow gap between two boxes);
      // else clear of the boxes' edges (boxes in touching cells); else where it was.
      const one = labelSize(labelText(edge));
      const place = labelPlace(line, one, avoid) ?? labelPlace(line, labelSize(labelText(edge), true), avoid, true) ?? labelPlace(line, one, avoid, false, true);
      line = { ...line, ...(place ?? {}) };
      placed.push(labelRect(line.mid, line.labelSide, labelSize(labelText(edge), line.labelWrap)));
    }
    out.push({ edge, line });
  }
  return out;
}

/** The first place along the line (and on either side of it) where the label covers nothing in `avoid`, or null. */
function labelPlace(line: EdgeLine, size: { w: number; h: number }, avoid: Rect[], wrap = false, clearOfBoxes = false): Pick<EdgeLine, 'mid' | 'labelSide' | 'labelWrap'> | null {
  const candidates: Array<Pick<EdgeLine, 'mid' | 'labelSide'>> = [];
  const segments = line.points.slice(1).map((q, i) => [line.points[i], q] as const);
  // The anchor first (as it was chosen), then along each part of the line, on both sides.
  candidates.push({ mid: line.mid, labelSide: line.labelSide });
  const other: Record<LabelSide, LabelSide> = { above: 'below', below: 'above', left: 'right', right: 'left' };
  candidates.push({ mid: line.mid, labelSide: other[line.labelSide] });
  for (const [p, q] of segments) {
    const sides: LabelSide[] = Math.abs(q.x - p.x) >= Math.abs(q.y - p.y) ? ['above', 'below'] : ['right', 'left'];
    for (const t of [0.5, 0.3, 0.7, 0.15, 0.85]) for (const side of sides) candidates.push({ mid: { x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t }, labelSide: side });
  }
  // Last, clear of the boxes' edges: above or below a short arrow between boxes in touching cells.
  if (clearOfBoxes) {
    const { mid } = line;
    candidates.push({ mid: { x: mid.x, y: mid.y - BOX_H / 2 - 1 }, labelSide: 'above' }, { mid: { x: mid.x, y: mid.y + BOX_H / 2 + 1 }, labelSide: 'below' });
  }
  const canvas = { left: 0, top: 0, right: GRID_COLS * CELL_W, bottom: GRID_ROWS * CELL_H };
  const inside = (r: Rect) => r.left >= canvas.left && r.top >= canvas.top && r.right <= canvas.right && r.bottom <= canvas.bottom;
  const found = candidates.find((c) => inside(labelRect(c.mid, c.labelSide, size)) && !avoid.some((r) => overlaps(labelRect(c.mid, c.labelSide, size), r)));
  return found ? { ...found, ...(wrap ? { labelWrap: true } : {}) } : null;
}
