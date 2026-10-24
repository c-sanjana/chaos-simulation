/**
 * Where the run diagram draws each call (see TopologyDiagram.tsx). Pure, grid-based decisions; the
 * diagram measures the boxes to draw the lines.
 *
 * - Neighbours on one row: a straight arrow in the cell between them (as in every preset).
 * - A cache straight above its server: a double-headed vertical arrow in the cell between them.
 * - Anything else ("routed"): a line with right-angle bends, drawn over the grid, and its text (rate,
 *   retries, failures) in one arrow cell, as a straight arrow's text would be:
 *   - from a part that calls several (a load balancer's servers): the line leaves the caller's
 *     middle, turns just after it ("trunk at the source", shared like a tree's), and runs into
 *     the callee along the callee's row; the text sits in the cell left of the callee.
 *   - into a part called by several (a shared database): the line runs along the caller's row,
 *     turns just before the callee ("trunk at the target") and meets the other arrows at the
 *     callee's middle; the text sits in the cell right of the caller.
 *   - its text sits on the side of the line away from the bend (above it when the line comes up
 *     from below), so the vertical part never crosses it.
 *   - on one row but further apart (a part reached by a longer path elsewhere): a straight line
 *     past the empty cells, text in the cell left of the callee, like a straight arrow.
 * - A straight arrow beside a trunk keeps room clear on that side (`clearStart`/`clearEnd`), so
 *   its text never runs under the trunk.
 *
 * ASSUMPTION: the layout (builder/compile.ts) puts a fan-out's callees on their own rows and keeps
 * the cells a routed line passes through empty; in the rare layouts where a text cell is taken
 * twice, the second arrow's text tries the other end before sharing the cell.
 */

export interface GridPlace {
  label?: string;
  col: number;
  row: number;
}

export interface CallEnds {
  from: string;
  to: string;
  /** A cache lookup (drawn vertically, double-headed). */
  cache: boolean;
}

export type Trunk = 'source' | 'target' | 'none';
export type TextSide = 'above' | 'below' | 'straight';

export interface Route {
  /** Where the vertical part of the line runs: just after the caller, just before the callee, or nowhere (one row). */
  trunk: Trunk;
  /** Where the text sits against the line in its cell. */
  text: TextSide;
}

export type Placement =
  | { orientation: 'horizontal'; col: number; row: number }
  | { orientation: 'vertical'; col: number; row: number }
  | { orientation: 'routed'; col: number; row: number; route: Route };

/** Each call's placement (null when an end is not on the diagram, or a cache is not straight above its server). */
export function placeCalls(layout: Record<string, GridPlace>, calls: CallEnds[]): Array<Placement | null> {
  const placed = calls.filter((c) => layout[c.from] && layout[c.to] && !c.cache);
  const outs = (id: string) => placed.filter((c) => c.from === id).length;
  const ins = (id: string) => placed.filter((c) => c.to === id).length;
  const taken = new Set<string>();
  const cell = (col: number, row: number) => `${col}:${row}`;

  const first = calls.map((c): Placement | null | 'route' => {
    const a = layout[c.from];
    const b = layout[c.to];
    if (!a || !b) return null;
    if (a.row === b.row && Math.abs(a.col - b.col) === 2 && !c.cache) {
      taken.add(cell(Math.min(a.col, b.col) + 1, a.row));
      return { orientation: 'horizontal', col: Math.min(a.col, b.col) + 1, row: a.row };
    }
    if (a.col === b.col && Math.abs(a.row - b.row) === 2) return { orientation: 'vertical', col: a.col, row: Math.min(a.row, b.row) + 1 };
    // ASSUMPTION: a cache shared by a second server is not drawn from that server (the layout puts
    // each cache above its first user only); its lookups still show on the cache's box.
    if (c.cache || b.col <= a.col) return null;
    return 'route';
  });

  return first.map((p, i) => {
    if (p !== 'route') return p;
    const c = calls[i];
    const a = layout[c.from];
    const b = layout[c.to];
    if (a.row === b.row) {
      // One row, cells apart: text left of the callee, like a straight arrow.
      taken.add(cell(b.col - 1, b.row));
      return { orientation: 'routed', col: b.col - 1, row: b.row, route: { trunk: 'none', text: 'straight' } };
    }
    const down = b.row > a.row;
    const nearTarget = { col: b.col - 1, row: b.row, route: { trunk: 'source' as const, text: down ? ('below' as const) : ('above' as const) } };
    const nearSource = { col: a.col + 1, row: a.row, route: { trunk: 'target' as const, text: down ? ('above' as const) : ('below' as const) } };
    // Into a shared part from a part with this one call: the text goes by the caller; otherwise by the callee.
    const preferred = ins(c.to) > 1 && outs(c.from) === 1 ? [nearSource, nearTarget] : [nearTarget, nearSource];
    const choice = preferred.find((x) => !taken.has(cell(x.col, x.row))) ?? preferred[0];
    taken.add(cell(choice.col, choice.row));
    return { orientation: 'routed', ...choice };
  });
}

/**
 * For each straight arrow (by index), whether a routed arrow's trunk runs at its start (just after
 * its caller) or at its end (just before its callee), so its text keeps clear of that side.
 */
export function trunkSides(calls: CallEnds[], placements: Array<Placement | null>): Array<{ clearStart: boolean; clearEnd: boolean }> {
  const trunkAt = (id: string, trunk: Trunk, end: 'from' | 'to') =>
    placements.some((p, j) => p?.orientation === 'routed' && p.route.trunk === trunk && calls[j][end] === id);
  return calls.map((c, i) =>
    placements[i]?.orientation === 'horizontal' ? { clearStart: trunkAt(c.from, 'source', 'from'), clearEnd: trunkAt(c.to, 'target', 'to') } : { clearStart: false, clearEnd: false },
  );
}
