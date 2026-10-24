/**
 * Walking a system's calls: on a drawn graph (who calls whom, in which order, how deep) and on a
 * compiled topology (each part's share of the users' requests).
 *
 * NOTE: the engine/analysis work for branching adds similar helpers to `analysis/helpers.ts`
 * (`callersOf`, `callsFrom`, `trafficShares(config)`). These are kept here so the builder does not
 * depend on analysis; `trafficShares` follows the same rules (see below) and can be swapped for
 * that one once both are in.
 */
import { callsOf, type CallPolicy, type TierConfig } from '../engine/config';
import type { BuilderEdge, BuilderGraph, BuilderNode } from './graph';

const isCache = (n: BuilderNode | undefined) => n?.settings.kind === 'cache';

/**
 * Canvas order: top to bottom, then left to right (then by id, so equal positions still sort the
 * same way every time). The order a component makes its calls in, and the order branches are laid
 * out in.
 * ASSUMPTION: people read a sketch top to bottom, so "the first call" is the top-most arrow; moving a
 * box up or down is how its call order is changed.
 */
export function canvasOrder(a: BuilderNode, b: BuilderNode): number {
  return a.row - b.row || a.col - b.col || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** The calls from `id` that pass requests on (everything but cache lookups), in call order (canvas order of their targets). */
export function flowCalls(graph: BuilderGraph, id: string): BuilderEdge[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  return graph.edges
    .filter((e) => e.from === id && byId.has(e.to) && !isCache(byId.get(e.to)))
    .sort((a, b) => canvasOrder(byId.get(a.to)!, byId.get(b.to)!));
}

/** The cache `id` looks things up in (its first, in canvas order), if any. */
export function cacheCall(graph: BuilderGraph, id: string): BuilderEdge | undefined {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  return graph.edges.filter((e) => e.from === id && isCache(byId.get(e.to))).sort((a, b) => canvasOrder(byId.get(a.to)!, byId.get(b.to)!))[0];
}

/** Ids of the components that pass requests to `id` (cache lookups excluded). */
export function flowCallers(graph: BuilderGraph, id: string): string[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  return isCache(byId.get(id)) ? [] : graph.edges.filter((e) => e.to === id && byId.has(e.from)).map((e) => e.from);
}

/**
 * How far each component is from `rootId` along the longest chain of calls (cache lookups
 * excluded): the root is 0, what it calls 1, … A part reached by two paths gets the longer one, so
 * every call goes left to right on the diagram. Only parts reached from the root are included.
 * Call only on a graph without loops (`validateGraph` checks).
 */
export function longestDepths(graph: BuilderGraph, rootId: string): Map<string, number> {
  const depth = new Map<string, number>([[rootId, 0]]);
  // Relax in topological order (Kahn's algorithm over the parts reached from the root).
  const reached = new Set<string>([rootId]);
  const todo = [rootId];
  while (todo.length) {
    for (const e of flowCalls(graph, todo.pop()!)) if (!reached.has(e.to)) (reached.add(e.to), todo.push(e.to));
  }
  const indegree = new Map([...reached].map((id) => [id, flowCallers(graph, id).filter((c) => reached.has(c)).length]));
  const ready = [rootId];
  while (ready.length) {
    const id = ready.shift()!;
    for (const e of flowCalls(graph, id)) {
      depth.set(e.to, Math.max(depth.get(e.to) ?? 0, depth.get(id)! + 1));
      indegree.set(e.to, indegree.get(e.to)! - 1);
      if (indegree.get(e.to) === 0) ready.push(e.to);
    }
  }
  return depth;
}

/** What a share computation needs: where users' requests go first, and the tiers. */
export interface CallGraph {
  clientCall: Pick<CallPolicy, 'target'>;
  tiers: Array<Pick<TierConfig, 'id' | 'downstream' | 'moreDownstream' | 'fanOut' | 'cacheAside'>>;
}

/**
 * Each tier's share of the users' requests (1 = every request reaches it once), ignoring retries,
 * cache hits and failures: the entry tier gets 1; a tier that splits ('split') gives each call its
 * share of its own; one that calls one after another or all at once gives every call its whole
 * share; a cache gets the share of each tier that looks things up in it. Shares add up where calls
 * meet (two app servers using one database).
 * ASSUMPTION: an estimate of where traffic goes on a healthy system, for sizing scenarios and maps
 * and for splitting a shared part's measured arrivals between the arrows into it.
 */
export function trafficShares(topology: CallGraph): Record<string, number> {
  const byId = new Map(topology.tiers.map((t) => [t.id, t]));
  const share: Record<string, number> = Object.fromEntries(topology.tiers.map((t) => [t.id, 0]));
  const sends = (t: CallGraph['tiers'][number]): Array<[string, number]> => {
    const calls = callsOf(t);
    const out: Array<[string, number]> = [];
    if (t.fanOut === 'split' && calls.length > 1) {
      const total = calls.reduce((a, c) => a + weight(c), 0);
      for (const c of calls) out.push([c.target, total > 0 ? weight(c) / total : 1 / calls.length]);
    } else for (const c of calls) out.push([c.target, 1]);
    if (t.cacheAside) out.push([t.cacheAside.target, 1]);
    return out;
  };
  // Topological order over the tiers reached from the entry (the topology has no loops).
  const indegree = new Map(topology.tiers.map((t) => [t.id, 0]));
  for (const t of topology.tiers) for (const [to] of sends(t)) indegree.set(to, (indegree.get(to) ?? 0) + 1);
  const ready = topology.tiers.filter((t) => indegree.get(t.id) === 0).map((t) => t.id);
  if (byId.has(topology.clientCall.target)) share[topology.clientCall.target] = 1;
  while (ready.length) {
    const t = byId.get(ready.shift()!)!;
    for (const [to, part] of sends(t)) {
      if (!byId.has(to)) continue;
      share[to] += share[t.id] * part;
      indegree.set(to, indegree.get(to)! - 1);
      if (indegree.get(to) === 0) ready.push(to);
    }
  }
  return share;
}

/** A call's split weight: its share, or 1 when it has none (or a nonsensical one). */
function weight(c: Pick<CallPolicy, 'share'>): number {
  return c.share !== undefined && Number.isFinite(c.share) && c.share >= 0 ? c.share : 1;
}
