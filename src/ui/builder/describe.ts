/**
 * Plain-language text for the builder: the key numbers on a box, the label on an arrow, and the
 * fuller sentences screen readers hear. Pure, so it is easy to test and reuse.
 */
import { KIND_LABELS, type BuilderEdge, type BuilderGraph, type BuilderNode, type CallSettings, type NodeSettings } from '../../builder/graph';

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
      return [`${formatCount(s.instances)} × ${plural(s.workersPerInstance, 'worker', 'workers')}`, `~${formatMs(s.service.medianMs)} each`];
  }
}

/** The short label on an arrow, e.g. "1 s · 1 retry", "no timeout · no retries". */
export function callLabel(call: CallSettings): string {
  const timeout = call.timeoutMs === null ? 'no timeout' : formatMs(call.timeoutMs);
  const retries = call.retries === 0 ? 'no retries' : plural(call.retries, 'retry', 'retries');
  return `${timeout} · ${retries}`;
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

/** "Server calls Database", using names (or kinds for blank names). */
export function edgeTitle(graph: BuilderGraph, edge: BuilderEdge): string {
  const { from, to } = edgeEnds(graph, edge);
  return `${from ? displayName(from) : edge.from} calls ${to ? displayName(to) : edge.to}`;
}

/** Accessible name of a box: "Server 2, a server: 4 × 200 workers, ~4 ms each". */
export function nodeSummary(node: BuilderNode): string {
  const kind = KIND_LABELS[node.settings.kind].toLowerCase();
  return `${displayName(node)}, a ${kind}: ${nodeLines(node.settings).join(', ')}`;
}
