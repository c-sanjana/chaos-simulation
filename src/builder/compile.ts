import type { CallPolicy, TierConfig } from '../engine/config';
import type { TopologyPreset } from '../data/types';
import type { BuilderGraph, BuilderNode, CallSettings } from './graph';

/** The id a built topology gets (scenarios and saved drafts refer to it). */
export const CUSTOM_TOPOLOGY_ID = 'custom';

/**
 * Turns a drawn topology into the same data the presets use, so every screen (replay, tipping
 * point, fixes) works on it unchanged. Call only when `validateGraph` finds no problems.
 *
 * Layout: the diagram draws a chain left to right on one row with an arrow between neighbours,
 * and a cache above the server that uses it. The canvas positions are the user's sketch; the
 * diagram is laid out afresh from the chain, the way the presets are.
 */
export function compileGraph(graph: BuilderGraph, name = 'Your topology'): TopologyPreset {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const client = graph.nodes.find((n) => n.settings.kind === 'client')!;
  const outOf = (id: string) => graph.edges.filter((e) => e.from === id).map((e) => ({ edge: e, to: byId.get(e.to)! }));
  const nextOf = (id: string) => outOf(id).find((o) => o.to.settings.kind !== 'cache');
  const cacheOf = (id: string) => outOf(id).find((o) => o.to.settings.kind === 'cache');

  // Walk the chain from the client.
  const chain: BuilderNode[] = [];
  for (let next = nextOf(client.id); next; next = nextOf(next.to.id)) chain.push(next.to);
  const caches = [...new Set(chain.map((n) => cacheOf(n.id)?.to).filter((c): c is BuilderNode => c !== undefined))];

  const layout: TopologyPreset['layout'] = { client: { label: client.label, col: 1, row: 3 } };
  chain.forEach((n, i) => (layout[n.id] = { label: n.label, col: 3 + 2 * i, row: 3 }));
  for (const c of caches) {
    const user = chain.find((n) => cacheOf(n.id)?.to.id === c.id)!;
    layout[c.id] = { label: c.label, col: layout[user.id].col, row: 1 };
  }

  // Each cache right after the first server that uses it (the presets' order; a tier's position
  // keys its random values, so the same system gives the same run whichever way it was made).
  const ordered = chain.flatMap((n) => {
    const c = cacheOf(n.id)?.to;
    return c && chain.find((m) => cacheOf(m.id)?.to.id === c.id) === n ? [n, c] : [n];
  });
  const tiers = ordered.map((n): TierConfig => {
    const next = nextOf(n.id);
    const cache = cacheOf(n.id);
    return {
      ...tierSettings(n),
      downstream: next ? policy(next.to.id, next.edge.call) : null,
      ...(cache ? { cacheAside: policy(cache.to.id, cache.edge.call) } : {}),
    };
  });
  const entry = nextOf(client.id)!;
  return { id: CUSTOM_TOPOLOGY_ID, name, clientCall: policy(entry.to.id, entry.edge.call), tiers, layout };
}

function policy(target: string, call: CallSettings): CallPolicy {
  return { target, timeoutMs: call.timeoutMs, retries: call.retries, backoffBaseMs: call.backoffBaseMs, jitter: call.jitter };
}

/** A component's own settings as a tier, without its calls. */
function tierSettings(n: BuilderNode): Omit<TierConfig, 'downstream'> {
  const s = n.settings;
  const service = { kind: 'lognormal' as const, medianMs: s.kind === 'client' ? 1 : s.service.medianMs, p99Ms: s.kind === 'client' ? 2 : s.service.p99Ms };
  switch (s.kind) {
    case 'loadBalancer':
    case 'server':
    case 'database':
      return { id: n.id, instances: s.instances, workersPerInstance: s.workersPerInstance, coresPerInstance: s.coresPerInstance, queueLimit: s.queueLimit, service, dropExpired: s.dropExpired };
    case 'cache':
      return {
        id: n.id,
        instances: s.instances,
        workersPerInstance: s.workersPerInstance,
        coresPerInstance: s.coresPerInstance,
        queueLimit: null,
        service,
        dropExpired: false,
        cache: { capacity: s.capacity, ttlMs: s.ttlMs, keys: s.keys, skew: s.skew },
      };
    case 'queue':
      // ASSUMPTION: the broker itself is roomy (storing a message is cheap and highly concurrent);
      // what limits a queue is how fast its consumers get through the messages.
      return { id: n.id, instances: 1, workersPerInstance: 1024, coresPerInstance: 8, queueLimit: null, service, dropExpired: false, queue: { maxDepth: s.maxDepth, consumers: s.consumers } };
    case 'client':
      throw new Error('The client is not a tier');
  }
}
