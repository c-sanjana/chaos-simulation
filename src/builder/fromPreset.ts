import type { CallPolicy, TierConfig } from '../engine/config';
import type { TopologyPreset } from '../data/types';
import type { BuilderEdge, BuilderGraph, BuilderNode, CallSettings, ComponentKind, NodeSettings, PoolSettings } from './graph';

/** What a preset tier is, read off its config: a cache, a queue, a leaf (database), the first tier (load balancer) or a server. */
export function kindOfTier(topology: TopologyPreset, t: TierConfig): ComponentKind {
  if (t.cache) return 'cache';
  if (t.queue) return 'queue';
  if (!t.downstream) return 'database';
  return t.id === topology.clientCall.target ? 'loadBalancer' : 'server';
}

const call = (p: CallPolicy): CallSettings => ({ timeoutMs: p.timeoutMs, retries: p.retries, backoffBaseMs: p.backoffBaseMs, jitter: p.jitter });

const service = (t: TierConfig) =>
  t.service.kind === 'lognormal' ? { medianMs: t.service.medianMs, p99Ms: t.service.p99Ms } : { medianMs: 1, p99Ms: 5 }; // presets use lognormal

/**
 * A preset (or compiled) topology as a builder graph, so it can be opened on the canvas and changed.
 * Placed where the preset's diagram draws it. `rps` is the client's traffic.
 */
export function graphFromPreset(topology: TopologyPreset, rps: number): BuilderGraph {
  const place = (id: string) => topology.layout[id] ?? { label: id, col: 1, row: 1 };
  const nodes: BuilderNode[] = [{ id: 'client', label: place('client').label, col: place('client').col, row: place('client').row, settings: { kind: 'client', rps } }];
  const edges: BuilderEdge[] = [{ id: `client-${topology.clientCall.target}`, from: 'client', to: topology.clientCall.target, call: call(topology.clientCall) }];
  for (const t of topology.tiers) {
    const kind = kindOfTier(topology, t);
    const s = service(t);
    let settings: NodeSettings;
    if (kind === 'cache') {
      settings = { kind, instances: t.instances, workersPerInstance: t.workersPerInstance, coresPerInstance: t.coresPerInstance, service: s, ...t.cache! };
    } else if (kind === 'queue') {
      settings = { kind, maxDepth: t.queue!.maxDepth, consumers: t.queue!.consumers, service: s };
    } else {
      settings = { kind: kind as PoolSettings['kind'], instances: t.instances, workersPerInstance: t.workersPerInstance, coresPerInstance: t.coresPerInstance, service: s, queueLimit: t.queueLimit, dropExpired: t.dropExpired };
    }
    const { label, col, row } = place(t.id);
    nodes.push({ id: t.id, label, col, row, settings });
    if (t.cacheAside) edges.push({ id: `${t.id}-${t.cacheAside.target}`, from: t.id, to: t.cacheAside.target, call: call(t.cacheAside) });
    if (t.downstream) edges.push({ id: `${t.id}-${t.downstream.target}`, from: t.id, to: t.downstream.target, call: call(t.downstream) });
  }
  return { nodes, edges };
}

/**
 * Brings a graph up to date with settings changed outside the canvas (the settings drawer edits
 * the compiled topology; the failure editor edits traffic and retries). Positions, labels and
 * what each component is stay as drawn.
 */
export function syncGraph(graph: BuilderGraph, topology: TopologyPreset, rps: number): BuilderGraph {
  const fresh = graphFromPreset(topology, rps);
  // The compiled topology calls the client "client"; the canvas may have named it anything.
  const clientId = graph.nodes.find((n) => n.settings.kind === 'client')?.id ?? 'client';
  const local = (id: string) => (id === 'client' ? clientId : id);
  const node = new Map(fresh.nodes.map((n) => [local(n.id), n]));
  const edge = new Map(fresh.edges.map((e) => [`${local(e.from)}>${e.to}`, e]));
  return {
    nodes: graph.nodes.map((n) => {
      const f = node.get(n.id);
      return f ? { ...n, settings: { ...f.settings, kind: n.settings.kind } as NodeSettings } : n;
    }),
    edges: graph.edges.map((e) => ({ ...e, call: edge.get(`${e.from}>${e.to}`)?.call ?? e.call })),
  };
}
