/**
 * Plain-language text for the builder: the key numbers on a box, the label on an arrow, and the
 * fuller sentences screen readers hear. Pure, so it is easy to test and reuse.
 */
import { shareFractions } from '../../builder/edit';
import { aKind, KIND_LABELS, type BuilderEdge, type BuilderGraph, type BuilderNode, type CallSettings, type NodeSettings } from '../../builder/graph';
import { flowCalls } from '../../builder/graphWalk';

/** 1234 → "1,234". */
export function formatCount(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

/** 0.3 → "0.3 ms", 20 → "20 ms", 1000 → "1 s", 1500 → "1.5 s", 60000 → "60 s". */
export function formatMs(ms: number): string {
  if (ms >= 1000) return `${formatCount(Math.round(ms / 100) / 10)} s`;
  return `${formatCount(ms < 10 ? Math.round(ms * 10) / 10 : Math.round(ms))} ms`;
}

export function plural(count: number, one: string, many: string): string {
  return `${formatCount(count)} ${count === 1 ? one : many}`;
}

/** What a component is called on screen: its name, or its kind when the name is blank. */
export function displayName(node: BuilderNode): string {
  return node.label.trim() || KIND_LABELS[node.settings.kind];
}

/** The one or two key numbers shown on a box, e.g. ["4 × 200 workers", "~4 ms each"]. */
export function nodeLines(s: NodeSettings): string[] {
  switch (s.kind) {
    case 'client':
      return [`${formatCount(s.rps)} req/s`];
    case 'cache':
      return [`holds ${formatCount(s.capacity)} keys`, `~${formatMs(s.service.medianMs)} each`];
    case 'queue':
      return [`holds ${formatCount(s.maxDepth)}`, plural(s.consumers, 'consumer', 'consumers')];
    default:
      // Narrow no-break spaces around "×" keep "2 × 1,024 workers" on one line in a small box.
      return [`${formatCount(s.instances)}\u202F×\u202F${plural(s.workersPerInstance, 'worker', 'workers')}`, `~${formatMs(s.service.medianMs)} each`];
  }
}

/** The short label on an arrow, e.g. "1 s · 1 retry", "no timeout · no retries". */
export function callLabel(call: CallSettings): string {
  const timeout = call.timeoutMs === null ? 'no timeout' : formatMs(call.timeoutMs);
  const retries = call.retries === 0 ? 'no retries' : plural(call.retries, 'retry', 'retries');
  return `${timeout} · ${retries}`;
}

/**
 * The share of traffic a load balancer sends along this arrow, as a fraction (0..1), or null when
 * the caller doesn't split (not a load balancer, or only one call).
 */
export function splitShare(graph: BuilderGraph, edge: BuilderEdge): number | null {
  const from = graph.nodes.find((n) => n.id === edge.from);
  if (from?.settings.kind !== 'loadBalancer') return null;
  const calls = flowCalls(graph, edge.from);
  const i = calls.findIndex((e) => e.id === edge.id);
  if (calls.length < 2 || i < 0) return null;
  return shareFractions(calls.map((e) => e.call.share))[i];
}

/** An arrow's label on the canvas: "50% · 2 s · 1 retry" for a load balancer's split, else as `callLabel`. */
export function edgeLabel(graph: BuilderGraph, edge: BuilderEdge): string {
  const share = splitShare(graph, edge);
  return share === null ? callLabel(edge.call) : `${Math.round(share * 100)}% · ${callLabel(edge.call)}`;
}

/** e.g. "gives up after 1 s, then tries again up to 1 time". */
export function callSentence(call: CallSettings): string {
  const wait = call.timeoutMs === null ? 'waits as long as it takes' : `gives up after ${formatMs(call.timeoutMs)}`;
  const again = call.retries === 0 ? 'and does not try again' : `then tries again up to ${plural(call.retries, 'time', 'times')}`;
  return `${wait}, ${again}`;
}

export function edgeEnds(graph: BuilderGraph, edge: BuilderEdge): { from?: BuilderNode; to?: BuilderNode } {
  return { from: graph.nodes.find((n) => n.id === edge.from), to: graph.nodes.find((n) => n.id === edge.to) };
}

/** "App server calls Database", using names (or kinds for blank names). */
export function edgeTitle(graph: BuilderGraph, edge: BuilderEdge): string {
  const { from, to } = edgeEnds(graph, edge);
  return `${from ? displayName(from) : edge.from} calls ${to ? displayName(to) : edge.to}`;
}

/** Accessible name of a box: "App server 2, an app server: 4 × 200 workers, ~4 ms each". */
export function nodeSummary(node: BuilderNode): string {
  return `${displayName(node)}, ${aKind(node.settings.kind)}: ${nodeLines(node.settings).join(', ')}`;
}
