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
 * selected box) when there is room, else the first cell with room around it on the example's
 * layout lines (every other column; the middle row, then the top, then the bottom), else any
 * cell with room around it, else the first empty cell. Null when the grid is full.
 * ASSUMPTION: boxes in touching cells hide the arrow (and its label) between them; one empty cell
 * between boxes leaves room for both, as on the example.
 */
export function addCell(graph: BuilderGraph, besideId?: string): Cell | null {
  const beside = graph.nodes.find((n) => n.id === besideId);
  if (beside && roomy(graph, beside.col + 2, beside.row)) return { col: beside.col + 2, row: beside.row };
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
  if (to === 'client') return 'Nothing calls the Client: it is where requests start.';
  if (from === 'database' || from === 'cache') return `${aKind(from, true)} only answers calls; it doesn't call other components.`;
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
  if (from === to) return refused(graph, "A component can't call itself.");
  if (graph.edges.some((e) => e.from === from && e.to === to)) return refused(graph, `${name(a)} already calls ${name(b)}.`);
  const why = connectRefusal(a.settings.kind, b.settings.kind);
  if (why) return refused(graph, why);
  const edge: BuilderEdge = { id: `${from}--${to}`, from, to, call: defaultCall(a.settings.kind, b.settings.kind) };
  return { graph: { ...graph, edges: [...graph.edges, edge] }, id: edge.id };
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

/** A split weight as used: its share, or 1 when it has none (or a nonsensical one). */
export const shareWeight = (share: number | undefined): number => (share !== undefined && Number.isFinite(share) && share >= 0 ? share : 1);

/** Each weight as a fraction of all of them (even when they add up to nothing). */
export function shareFractions(shares: Array<number | undefined>): number[] {
  const w = shares.map(shareWeight);
  const total = w.reduce((a, b) => a + b, 0);
  return w.map((x) => (total > 0 ? x / total : 1 / w.length));
}

/**
 * The shares after one of them is set to `percent` of the traffic: the others keep their
 * proportions between themselves and share what is left. Returned as fractions adding up to 1.
 * E.g. three even shares, the first set to 50% → 0.5, 0.25, 0.25.
 * ASSUMPTION: people think of a split in percent of the traffic, and expect the other arrows to make
 * up the rest rather than to have to balance every arrow by hand.
 */
export function sharesWith(shares: Array<number | undefined>, index: number, percent: number): number[] {
  const f = shareFractions(shares);
  const p = Math.min(1, Math.max(0, percent / 100));
  const rest = 1 - f[index];
  const round = (x: number) => Math.round(x * 1e6) / 1e6;
  return f.map((x, i) => round(i === index ? p : rest > 0 ? (x * (1 - p)) / rest : (1 - p) / (f.length - 1)));
}

/**
 * Sets the share of traffic a load balancer sends along one of its arrows (in percent); its other
 * arrows share the rest in their current proportions (see `sharesWith`).
 */
export function setShare(graph: BuilderGraph, edgeId: string, percent: number): BuilderGraph {
  const edge = graph.edges.find((e) => e.id === edgeId);
  if (!edge) return graph;
  const siblings = flowCalls(graph, edge.from);
  const index = siblings.findIndex((e) => e.id === edgeId);
  if (index < 0 || siblings.length < 2) return graph;
  const next = sharesWith(siblings.map((e) => e.call.share), index, percent);
  const byId = new Map(siblings.map((e, i) => [e.id, next[i]]));
  return { ...graph, edges: graph.edges.map((e) => (byId.has(e.id) ? { ...e, call: { ...e.call, share: byId.get(e.id) } } : e)) };
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
