/**
 * Pure editing functions for the topology builder. Each takes a graph and returns a new one
 * (never mutating its input), so the screen can keep the graph in React state and undo is easy
 * to add later.
 *
 * Edits that can be refused (placing, moving, connecting) return an `EditResult`: the graph
 * unchanged (the same object) plus a plain-language `reason` when refused, or the new graph plus
 * the `id` of what was added.
 */
import {
  KIND_LABELS,
  canConnect,
  defaultCall,
  defaultSettings,
  type BuilderEdge,
  type BuilderGraph,
  type BuilderNode,
  type CallSettings,
  type ClientSettings,
  type ComponentKind,
  type CacheSettings,
  type PoolSettings,
  type QueueSettings,
  type ServiceSettings,
  aKind,
} from './graph';
import { shareFractions, shareWeight } from '../engine/config';
import { flowCalls } from './graphWalk';

/** Size of the builder's canvas grid. Positions are 1-based, like the topology diagram's. */
export const GRID_COLS = 9;
export const GRID_ROWS = 5;

export interface Cell {
  col: number;
  row: number;
}

export interface EditResult {
  graph: BuilderGraph;
  /** Why the edit was refused, in plain words. Absent when it was made. */
  reason?: string;
  /** Id of the node or edge the edit added. */
  id?: string;
}

const refused = (graph: BuilderGraph, reason: string): EditResult => ({ graph, reason });

export function nodeAt(graph: BuilderGraph, col: number, row: number): BuilderNode | undefined {
  return graph.nodes.find((n) => n.col === col && n.row === row);
}

export function inGrid(col: number, row: number): boolean {
  return Number.isInteger(col) && Number.isInteger(row) && col >= 1 && col <= GRID_COLS && row >= 1 && row <= GRID_ROWS;
}

/** The first empty cell in reading order (left to right, then top to bottom), or null when the grid is full. */
export function firstFreeCell(graph: BuilderGraph): Cell | null {
  for (let row = 1; row <= GRID_ROWS; row++) {
    for (let col = 1; col <= GRID_COLS; col++) {
      if (!nodeAt(graph, col, row)) return { col, row };
    }
  }
  return null;
}

/** Whether a cell is empty and none of the eight cells around it holds a box. */
function roomy(graph: BuilderGraph, col: number, row: number): boolean {
  return inGrid(col, row) && graph.nodes.every((n) => Math.abs(n.col - col) > 1 || Math.abs(n.row - row) > 1);
}

/**
 * Where the Add button puts a new component: one empty cell to the right of `besideId` (the
 * selected box) when there is room, else two rows below or above that (where a load balancer's or
 * app server's next part goes, so its arrows fan out instead of running through the first one),
 * else the first cell with room around it on the example's layout lines (every other column; the
 * middle row, then the top, then the bottom), else any cell with room around it, else the first
 * empty cell. Null when the grid is full.
 * ASSUMPTION: boxes in touching cells hide the arrow (and its label) between them; one empty cell
 * between boxes leaves room for both, as on the example. Below before above, so a new part comes
 * after the existing ones in call order (top to bottom).
 */
export function addCell(graph: BuilderGraph, besideId?: string): Cell | null {
  const beside = graph.nodes.find((n) => n.id === besideId);
  if (beside) {
    for (const row of [beside.row, beside.row + 2, beside.row - 2]) if (roomy(graph, beside.col + 2, row)) return { col: beside.col + 2, row };
  }
  for (const row of [3, 1, 5]) {
    for (let col = 1; col <= GRID_COLS; col += 2) if (roomy(graph, col, row)) return { col, row };
  }
  for (let row = 1; row <= GRID_ROWS; row++) {
    for (let col = 1; col <= GRID_COLS; col++) if (roomy(graph, col, row)) return { col, row };
  }
  return firstFreeCell(graph);
}

/**
 * The empty cell closest to (col, row) (straight-line distance; ties go to the earlier cell in
 * reading order), or null when the grid is full. A target outside the grid is clamped onto it.
 */
export function nearestFreeCell(graph: BuilderGraph, col: number, row: number): Cell | null {
  const c = Math.min(GRID_COLS, Math.max(1, Math.round(col)));
  const r = Math.min(GRID_ROWS, Math.max(1, Math.round(row)));
  let best: Cell | null = null;
  let bestDistance = Infinity;
  for (let y = 1; y <= GRID_ROWS; y++) {
    for (let x = 1; x <= GRID_COLS; x++) {
      if (nodeAt(graph, x, y)) continue;
      const d = (x - c) ** 2 + (y - r) ** 2;
      if (d < bestDistance) {
        best = { col: x, row: y };
        bestDistance = d;
      }
    }
  }
  return best;
}

/** "server-1", "server-2", …: the lowest number not already used by a node id. */
function freshId(graph: BuilderGraph, kind: ComponentKind): string {
  for (let n = 1; ; n++) {
    const id = `${kind}-${n}`;
    if (!graph.nodes.some((node) => node.id === id)) return id;
  }
}

/** "App server" for the first one, then "App server 2", "App server 3", …: the lowest label not already used. */
function freshLabel(graph: BuilderGraph, kind: ComponentKind): string {
  const base = KIND_LABELS[kind];
  const used = new Set(graph.nodes.map((n) => n.label));
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    if (!used.has(`${base} ${n}`)) return `${base} ${n}`;
  }
}

/**
 * Adds a component with default settings on the free cell nearest (col, row).
 * Refused when the grid is full, or for a second Client.
 * ASSUMPTION: one Client stands for all users; more than one would make "the traffic" ambiguous.
 */
export function addNode(graph: BuilderGraph, kind: ComponentKind, col: number, row: number): EditResult {
  if (kind === 'client' && graph.nodes.some((n) => n.settings.kind === 'client')) {
    return refused(graph, 'There is already a Client. One Client stands for all your users; change its traffic in its settings.');
  }
  const cell = nearestFreeCell(graph, col, row);
  if (!cell) return refused(graph, 'The canvas is full. Remove a component to make room.');
  const node: BuilderNode = { id: freshId(graph, kind), label: freshLabel(graph, kind), ...cell, settings: defaultSettings(kind) };
  return { graph: { ...graph, nodes: [...graph.nodes, node] }, id: node.id };
}

/** Moves a component to another cell. Refused when the cell is off the grid or taken. */
export function moveNode(graph: BuilderGraph, id: string, col: number, row: number): EditResult {
  const node = graph.nodes.find((n) => n.id === id);
  if (!node) return refused(graph, 'That component no longer exists.');
  if (!inGrid(col, row)) return refused(graph, 'That is outside the canvas.');
  if (node.col === col && node.row === row) return { graph };
  const other = nodeAt(graph, col, row);
  if (other) return refused(graph, `That spot is taken by ${name(other)}.`);
  return { graph: { ...graph, nodes: graph.nodes.map((n) => (n.id === id ? { ...n, col, row } : n)) } };
}

/** Removes a component and every call to or from it. */
export function removeNode(graph: BuilderGraph, id: string): BuilderGraph {
  return {
    nodes: graph.nodes.filter((n) => n.id !== id),
    edges: graph.edges.filter((e) => e.from !== id && e.to !== id),
  };
}

/** Why `from` may not call `to`, in plain words, or null when it may. Mirrors `canConnect`. */
export function connectRefusal(from: ComponentKind, to: ComponentKind): string | null {
  if (canConnect(from, to)) return null;
  if (to === 'client') return 'The Client is where requests start, so nothing sends to it.';
  if (from === 'database' || from === 'cache') return `${aKind(from, true)} only answers requests; it doesn't send any.`;
  if (from === 'client') return `The Client sends requests to a load balancer, an app server or a queue, not straight to ${aKind(to)}.`;
  // The only pair left that canConnect rules out: a load balancer or queue calling a cache.
  return 'Only an app server looks things up in a cache.';
}

function name(node: BuilderNode): string {
  return node.label.trim() || KIND_LABELS[node.settings.kind];
}

/**
 * Makes `from` call `to`, with the usual call settings for that pair (`defaultCall`).
 * Refused for a component calling itself, a call that already exists, or a pair `canConnect`
 * rules out; the reason says which.
 */
export function connect(graph: BuilderGraph, from: string, to: string): EditResult {
  const a = graph.nodes.find((n) => n.id === from);
  const b = graph.nodes.find((n) => n.id === to);
  if (!a || !b) return refused(graph, 'That component no longer exists.');
  if (from === to) return refused(graph, "A box can't have an arrow to itself.");
  if (graph.edges.some((e) => e.from === from && e.to === to)) return refused(graph, `There's already an arrow from ${name(a)} to ${name(b)}.`);
  const why = connectRefusal(a.settings.kind, b.settings.kind);
  if (why) return refused(graph, why);
  const edge: BuilderEdge = { id: `${from}--${to}`, from, to, call: defaultCall(a.settings.kind, b.settings.kind) };
  const next = { ...graph, edges: [...graph.edges, edge] };
  return { graph: a.settings.kind === 'loadBalancer' ? withEvenNewShare(next, edge.id) : next, id: edge.id };
}

/**
 * After a new arrow from a load balancer: when its other arrows have shares set, the new arrow
 * gets an even share (1 of n arrows: 25% as the 4th) and the others share the rest in their
 * proportions, the way `setShare` rebalances; e.g. 50/25/25 + a new server → 37.5/18.75/18.75/25.
 * Without shares set, every arrow (the new one too) is even already.
 * ASSUMPTION: a new server joins as an equal; without this, the new arrow (no share = weight 1)
 * would take half the traffic of three arrows whose shares add up to 1.
 */
function withEvenNewShare(graph: BuilderGraph, edgeId: string): BuilderGraph {
  const edge = graph.edges.find((e) => e.id === edgeId)!;
  const siblings = flowCalls(graph, edge.from);
  if (!siblings.some((e) => e.id !== edgeId && e.call.share !== undefined)) return graph;
  const others = siblings.filter((e) => e.id !== edgeId);
  const rest = shareFractions(others.map((e) => e.call.share));
  const even = 1 / siblings.length;
  const share = new Map<string, number>([[edgeId, roundShare(even)], ...others.map((e, i): [string, number] => [e.id, roundShare(rest[i] * (1 - even))])]);
  return { ...graph, edges: graph.edges.map((e) => (share.has(e.id) ? { ...e, call: { ...e.call, share: share.get(e.id) } } : e)) };
}

/** Whether `connect(graph, from, to)` would succeed. */
export function canConnectNodes(graph: BuilderGraph, from: string, to: string): boolean {
  return connect(graph, from, to).reason === undefined;
}

export function removeEdge(graph: BuilderGraph, edgeId: string): BuilderGraph {
  return { ...graph, edges: graph.edges.filter((e) => e.id !== edgeId) };
}

/**
 * A change to any component's settings. Keys that the component doesn't have are ignored (a
 * Client has no `instances`), so one patch type serves every kind. `service` is merged, so
 * `{ service: { p99Ms: 50 } }` keeps the median.
 */
export type SettingsPatch = Partial<Omit<ClientSettings, 'kind'>> &
  Partial<Omit<PoolSettings, 'kind' | 'service'>> &
  Partial<Omit<CacheSettings, 'kind' | 'service'>> &
  Partial<Omit<QueueSettings, 'kind' | 'service'>> & { service?: Partial<ServiceSettings> };

export interface NodePatch {
  /** Stored as typed (not trimmed), so a name can be typed with spaces; a blank name is shown as its kind. */
  label?: string;
  settings?: SettingsPatch;
}

/** Renames a component and/or changes its settings. */
export function updateNode(graph: BuilderGraph, id: string, patch: NodePatch): BuilderGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((n) => {
      if (n.id !== id) return n;
      const settings = { ...n.settings } as Record<string, unknown>;
      for (const [key, value] of Object.entries(patch.settings ?? {})) {
        if (!(key in settings) || key === 'kind') continue;
        settings[key] = key === 'service' ? { ...(settings.service as ServiceSettings), ...(value as Partial<ServiceSettings>) } : value;
      }
      return { ...n, label: patch.label ?? n.label, settings: settings as unknown as BuilderNode['settings'] };
    }),
  };
}

/** Changes how a caller calls: timeout, retries, backoff, jitter, share. */
export function updateCall(graph: BuilderGraph, edgeId: string, patch: Partial<CallSettings>): BuilderGraph {
  return { ...graph, edges: graph.edges.map((e) => (e.id === edgeId ? { ...e, call: { ...e.call, ...patch } } : e)) };
}

/** Share maths lives with the config's `share` (one definition for the builder, the drawer and the analysis). */
export { shareFractions, shareWeight };

/** A share edit's result: the new shares (fractions adding up to 1), and the arrows set by hand so far (see shareEdit). */
export interface ShareEdit {
  shares: number[];
  pinned: number[];
}

/**
 * The shares after one of them (`index`) is set to `percent` of the traffic. The arrows set by
 * hand earlier in the same round of edits (`pinned`) keep their shares, and the others share what
 * is left in their proportions; so typing 70, then 20, then 10 gives exactly 70/20/10. When that
 * can't work (no other arrow is left to make up the rest and the sum is off, or the arrows set by
 * hand already add up to more than is left), every other arrow shares the rest in its proportions,
 * and the round starts again from this arrow. Returned with the arrows set by hand after this edit.
 * E.g. three even shares, the first set to 50% → 0.5, 0.25, 0.25.
 * ASSUMPTION: people think of a split in percent of the traffic, and expect the other arrows to make
 * up the rest rather than to have to balance every arrow by hand.
 */
export function shareEdit(shares: Array<number | undefined>, index: number, percent: number, pinned: number[] = []): ShareEdit {
  const f = shareFractions(shares);
  const p = Math.min(1, Math.max(0, percent / 100));
  const kept = pinned.filter((i) => i !== index && i >= 0 && i < f.length);
  const keptTotal = kept.reduce((sum, i) => sum + f[i], 0);
  const free = f.map((_, i) => i).filter((i) => i !== index && !kept.includes(i));
  // It holds while the others can make up the rest, or when the arrows set by hand already add up exactly.
  const holds = free.length > 0 ? keptTotal + p <= 1 + 1e-9 : Math.abs(keptTotal + p - 1) < 1e-6;
  const movable = holds ? free : f.map((_, i) => i).filter((i) => i !== index);
  const left = 1 - p - (holds ? keptTotal : 0);
  const movableTotal = movable.reduce((sum, i) => sum + f[i], 0);
  const next = f.map((x, i) => (i === index ? p : !movable.includes(i) ? x : movableTotal > 0 ? (x * left) / movableTotal : left / movable.length));
  return { shares: next.map(roundShare), pinned: holds ? [...kept, index] : [index] };
}

/** The shares after one of them is set to `percent` (shareEdit, with no arrow set by hand before). */
export function sharesWith(shares: Array<number | undefined>, index: number, percent: number): number[] {
  return shareEdit(shares, index, percent).shares;
}

/** A share kept to 6 decimals, so stored shares stay readable (0.333333, not 0.33333333333333337). */
const roundShare = (x: number) => Math.round(x * 1e6) / 1e6;

/**
 * Sets the share of traffic a load balancer sends along one of its arrows (in percent). The arrows
 * set by hand before in this round (`pinned`, by edge id) keep theirs; the others share the rest
 * (see shareEdit). Returns the graph and the arrows set by hand after this edit.
 */
export function editShare(graph: BuilderGraph, edgeId: string, percent: number, pinned: string[] = []): { graph: BuilderGraph; pinned: string[] } {
  const edge = graph.edges.find((e) => e.id === edgeId);
  if (!edge) return { graph, pinned };
  const siblings = flowCalls(graph, edge.from);
  const index = siblings.findIndex((e) => e.id === edgeId);
  if (index < 0 || siblings.length < 2) return { graph, pinned };
  const ids = siblings.map((e) => e.id);
  const next = shareEdit(siblings.map((e) => e.call.share), index, percent, pinned.map((id) => ids.indexOf(id)));
  const byId = new Map(siblings.map((e, i) => [e.id, next.shares[i]]));
  return {
    graph: { ...graph, edges: graph.edges.map((e) => (byId.has(e.id) ? { ...e, call: { ...e.call, share: byId.get(e.id) } } : e)) },
    pinned: next.pinned.map((i) => ids[i]),
  };
}

/** Sets one arrow's share of traffic, the others sharing the rest in their proportions (editShare with nothing set by hand before). */
export function setShare(graph: BuilderGraph, edgeId: string, percent: number): BuilderGraph {
  return editShare(graph, edgeId, percent).graph;
}

/** Whether an app server calls its parts one after another ('sequence') or all at once ('parallel'). */
export function setFanOut(graph: BuilderGraph, id: string, fanOut: 'sequence' | 'parallel'): BuilderGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((n) => (n.id === id && n.settings.kind === 'server' ? { ...n, settings: { ...n.settings, fanOut } } : n)),
  };
}

/** An empty canvas. */
export function emptyGraph(): BuilderGraph {
  return { nodes: [], edges: [] };
}

/**
 * The example to start from, laid out like the preset diagram: Client → Load balancer → App server →
 * Database left to right along the middle row, with the app server's Cache above it.
 */
export function starterGraph(): BuilderGraph {
  const node = (kind: ComponentKind, col: number, row: number): BuilderNode => ({ id: `${kind}-1`, label: KIND_LABELS[kind], col, row, settings: defaultSettings(kind) });
  const nodes = [node('client', 1, 3), node('loadBalancer', 3, 3), node('server', 5, 3), node('cache', 5, 1), node('database', 7, 3)];
  const edge = (from: ComponentKind, to: ComponentKind): BuilderEdge => ({ id: `${from}-1--${to}-1`, from: `${from}-1`, to: `${to}-1`, call: defaultCall(from, to) });
  return { nodes, edges: [edge('client', 'loadBalancer'), edge('loadBalancer', 'server'), edge('server', 'cache'), edge('server', 'database')] };
}
