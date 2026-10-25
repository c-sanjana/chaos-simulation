/**
 * Walking a drawn graph's calls: who calls whom, in which order, and how deep. (A compiled
 * topology's call graph is walked by `analysis/helpers.ts`: `callsFrom`, `callersOf`,
 * `trafficShares`, … These work on the canvas's graph, before it is compiled.)
 */
import type { BuilderEdge, BuilderGraph, BuilderNode } from './graph';

const isCache = (n: BuilderNode | undefined) => n?.settings.kind === 'cache';

/**
 * The graph's nodes by id, built once per list of nodes (edits make a new list), so walking every
 * node's calls stays linear (code review 3). A list that grew or shrank in place is read afresh.
 */
const nodeMaps = new WeakMap<BuilderNode[], Map<string, BuilderNode>>();
function nodesById(graph: BuilderGraph): Map<string, BuilderNode> {
  let byId = nodeMaps.get(graph.nodes);
  if (!byId || byId.size !== graph.nodes.length) nodeMaps.set(graph.nodes, (byId = new Map(graph.nodes.map((n) => [n.id, n]))));
  return byId;
}

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
  const byId = nodesById(graph);
  return graph.edges
    .filter((e) => e.from === id && byId.has(e.to) && !isCache(byId.get(e.to)))
    .sort((a, b) => canvasOrder(byId.get(a.to)!, byId.get(b.to)!));
}

/** The cache `id` looks things up in (its first, in canvas order), if any. */
export function cacheCall(graph: BuilderGraph, id: string): BuilderEdge | undefined {
  const byId = nodesById(graph);
  return graph.edges.filter((e) => e.from === id && isCache(byId.get(e.to))).sort((a, b) => canvasOrder(byId.get(a.to)!, byId.get(b.to)!))[0];
}

/** Ids of the components that pass requests to `id` (cache lookups excluded). */
export function flowCallers(graph: BuilderGraph, id: string): string[] {
  const byId = nodesById(graph);
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
