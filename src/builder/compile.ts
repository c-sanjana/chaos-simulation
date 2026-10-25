import type { CallPolicy, FanOut, TierConfig } from '../engine/config';
import type { TopologyPreset } from '../data/types';
import type { BuilderGraph, BuilderNode, CallSettings } from './graph';
import { cacheCall, canvasOrder, flowCallers, flowCalls, longestDepths } from './graphWalk';

/** The id a built topology gets (scenarios and saved drafts refer to it). */
export const CUSTOM_TOPOLOGY_ID = 'custom';

/**
 * Turns a drawn topology into the same data the presets use, so every screen (replay, tipping
 * point, fixes) works on it unchanged. Call only when `validateGraph` finds no problems.
 *
 * - Tier order: front to back (by how far each part is from the Client along its longest chain of
 *   calls, then canvas order), with each cache right after the first app server that uses it. A
 *   tier's position keys its random values, so the same system gives the same run whichever way it
 *   was made (the example drawn on the canvas compiles to exactly the preset).
 * - Calls: a part's calls are made in canvas order of their targets (top to bottom, then left to
 *   right; see `flowCalls`). The first becomes `downstream`, the rest `moreDownstream`. A load
 *   balancer with several calls splits ('split', with each arrow's share); an app server calls them
 *   one after another ('sequence', the default) or all at once ('parallel'), as set on the server.
 *   A chain gets neither `moreDownstream` nor `fanOut`, exactly as before branching.
 * - Layout: see `layoutGraph`. The canvas positions are the user's sketch; the diagram is laid out
 *   afresh, the way the presets are.
 */
export function compileGraph(graph: BuilderGraph, name = 'Your topology'): TopologyPreset {
  const client = graph.nodes.find((n) => n.settings.kind === 'client')!;
  const depth = longestDepths(graph, client.id);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const cacheOf = (id: string) => {
    const e = cacheCall(graph, id);
    return e && byId.get(e.to);
  };
  const flow = graph.nodes.filter((n) => n.id !== client.id && depth.has(n.id)).sort((a, b) => depth.get(a.id)! - depth.get(b.id)! || canvasOrder(a, b));
  /** The first part (in tier order) that looks things up in cache `id`: the cache is placed with it. */
  const firstUser = (id: string) => flow.find((m) => cacheOf(m.id)?.id === id);

  const ordered = flow.flatMap((n) => {
    const c = cacheOf(n.id);
    return c && firstUser(c.id) === n ? [n, c] : [n];
  });
  const tiers = ordered.map((n): TierConfig => {
    const calls = flowCalls(graph, n.id);
    const cache = cacheCall(graph, n.id);
    const split = n.settings.kind === 'loadBalancer' && calls.length > 1;
    const policies = calls.map((e) => policy(e.to, e.call, split));
    const fanOut: FanOut = split ? 'split' : n.settings.kind === 'server' && n.settings.fanOut === 'parallel' ? 'parallel' : 'sequence';
    return {
      ...tierSettings(n),
      downstream: policies[0] ?? null,
      ...(policies.length > 1 ? { moreDownstream: policies.slice(1), fanOut } : {}),
      ...(cache ? { cacheAside: policy(cache.to, cache.call, false) } : {}),
    };
  });
  const entry = flowCalls(graph, client.id)[0];
  return { id: CUSTOM_TOPOLOGY_ID, name, clientCall: policy(entry.to, entry.call, false), tiers, layout: layoutGraph(graph, client, depth, flow, cacheOf, firstUser) };
}

/**
 * Where the diagram draws each part: on a grid of boxes with a column (or row) for arrows between
 * them, boxes on odd columns and rows.
 *
 * - Columns: by how far a part is from the Client along its longest chain of calls (Client in
 *   column 1, then 3, 5, …), so every call goes left to right.
 * - Rows ("lanes"): a tidy tree. Each part sits in a band of lanes with everything it was the first
 *   to call (depth-first from the Client, calls in call order); the bands of its calls are stacked
 *   top to bottom, and the part itself sits level with the middle one (with two, the first): so a
 *   chain is one straight row, and a load balancer's servers fan out above and below it.
 * - A cache sits straight above the app server that uses it (its first user), in the lane above,
 *   which the server's band keeps free.
 * - A part called by several parts (a shared database) then moves, with what it calls, level with
 *   the middle of its callers when that spot is free, so the arrows meet it from both sides.
 * - A call that skips a column never runs under a box: when a box is in its way on both rows its
 *   line could run along (the caller's and the callee's), the callee moves, with what it calls, to
 *   free lanes below (see the loop's comment).
 * - Rows: lane l is grid row 1 + 2 × (l − top), with a cache row always kept above the top lane of
 *   boxes (as the presets have), so a chain sits on row 3 with its cache on row 1.
 */
function layoutGraph(
  graph: BuilderGraph,
  client: BuilderNode,
  depth: Map<string, number>,
  flow: BuilderNode[],
  cacheOf: (id: string) => BuilderNode | undefined,
  firstUser: (cacheId: string) => BuilderNode | undefined,
): TopologyPreset['layout'] {
  const col = (id: string) => 1 + 2 * depth.get(id)!;
  const ownsCache = (id: string) => {
    const c = cacheOf(id);
    return c !== undefined && firstUser(c.id)?.id === id;
  };

  // Depth-first from the Client: each part's tree parent is the first part found calling it.
  const children = new Map<string, string[]>();
  const seen = new Set([client.id]);
  const visit = (id: string) => {
    for (const e of flowCalls(graph, id)) {
      if (seen.has(e.to)) continue;
      seen.add(e.to);
      children.set(id, [...(children.get(id) ?? []), e.to]);
      visit(e.to);
    }
  };
  visit(client.id);

  /** A part's band: its height in lanes, its own lane and every lane in it, relative to the band's top. */
  const band = (id: string): { height: number; at: number; lanes: Map<string, number> } => {
    const lanes = new Map<string, number>();
    const anchors: number[] = [];
    let top = 0;
    for (const kid of children.get(id) ?? []) {
      const b = band(kid);
      for (const [n, l] of b.lanes) lanes.set(n, l + top);
      anchors.push(top + b.at);
      top += b.height;
    }
    let at = anchors.length > 0 ? anchors[Math.floor((anchors.length - 1) / 2)] : 0;
    let height = Math.max(1, top);
    if (ownsCache(id) && at === 0) {
      // Room for the cache above: everything in the band moves down one lane.
      for (const [n, l] of lanes) lanes.set(n, l + 1);
      at = 1;
      height += 1;
    }
    lanes.set(id, at);
    return { height, at, lanes };
  };
  const lane = band(client.id).lanes;

  // A part called by several: level with the middle of its callers, when there is room.
  const subtree = (id: string): string[] => [id, ...(children.get(id) ?? []).flatMap(subtree)];
  for (const n of flow) {
    const callers = flowCallers(graph, n.id).filter((c) => lane.has(c));
    if (callers.length < 2 || !lane.has(n.id)) continue;
    const lanes = callers.map((c) => lane.get(c)!).sort((a, b) => a - b);
    const lo = lanes[Math.floor((lanes.length - 1) / 2)];
    const hi = lanes[Math.floor(lanes.length / 2)];
    const now = lane.get(n.id)!;
    // The middle caller's lane; with two in the middle, the one nearer to where it is (it stays on a tie).
    const nearer = Math.abs(lo - now) - Math.abs(hi - now);
    const target = lo === hi ? lo : nearer < 0 ? lo : nearer > 0 ? hi : now;
    const delta = target - now;
    if (delta === 0) continue;
    const moving = new Set(subtree(n.id));
    const used = new Map<string, string>();
    for (const [id, l] of lane) {
      if (moving.has(id)) continue;
      used.set(`${col(id)}:${l}`, id);
      if (ownsCache(id)) used.set(`${col(id)}:${l - 1}`, cacheOf(id)!.id);
    }
    const free = [...moving].every((id) => !used.has(`${col(id)}:${lane.get(id)! + delta}`) && (!ownsCache(id) || !used.has(`${col(id)}:${lane.get(id)! + delta - 1}`)));
    if (free) for (const id of moving) lane.set(id, lane.get(id)! + delta);
  }

  // A call that skips columns is drawn straight along its row, or bent into the callee's row or out
  // of the caller's (ui/edgeRoutes.ts). When a box sits in the way on every row it could run along,
  // the callee moves, with everything it was the first to call, to fresh lanes below everything
  // else: its row is then empty left of it, so the call (and every other call into it) bends into
  // that row instead of running under a box. Each move empties a row; a handful of moves at most.
  const callers = [client, ...flow].filter((n) => lane.has(n.id));
  for (let moves = 0; moves <= flow.length; moves++) {
    const boxes = new Set<string>();
    for (const [id, l] of lane) {
      boxes.add(`${col(id)}:${l}`);
      if (ownsCache(id)) boxes.add(`${col(id)}:${l - 1}`);
    }
    /** No box on lane `l` strictly between columns `c1` and `c2`. */
    const clear = (l: number, c1: number, c2: number) => {
      for (let c = c1 + 1; c < c2; c++) if (boxes.has(`${c}:${l}`)) return false;
      return true;
    };
    const blocked = callers
      .flatMap((n) => flowCalls(graph, n.id).map((e) => [n.id, e.to] as const))
      .find(([a, b]) => lane.has(b) && !clear(lane.get(b)!, col(a), col(b)) && !clear(lane.get(a)!, col(a), col(b)));
    if (!blocked) break;
    const moving = new Set(subtree(blocked[1]));
    const top = Math.min(...[...moving].map((id) => lane.get(id)! - (ownsCache(id) ? 1 : 0)));
    const bottom = Math.max(...[...lane].filter(([id]) => !moving.has(id)).map(([, l]) => l));
    for (const id of moving) lane.set(id, lane.get(id)! + bottom + 1 - top);
  }

  const cacheLanes = [...lane].filter(([id]) => ownsCache(id)).map(([, l]) => l - 1);
  const base = Math.min(Math.min(...lane.values()) - 1, ...cacheLanes);
  const row = (l: number) => 1 + 2 * (l - base);
  const layout: TopologyPreset['layout'] = { client: { label: client.label, col: 1, row: row(lane.get(client.id)!) } };
  for (const n of flow) if (lane.has(n.id)) layout[n.id] = { label: n.label, col: col(n.id), row: row(lane.get(n.id)!) };
  for (const n of flow) {
    if (!ownsCache(n.id)) continue;
    const c = cacheOf(n.id)!;
    layout[c.id] = { label: c.label, col: col(n.id), row: row(lane.get(n.id)! - 1) };
  }
  return layout;
}

/** A call's policy; `split` keeps its share of traffic (only a splitting load balancer's calls have one). */
function policy(target: string, call: CallSettings, split: boolean): CallPolicy {
  return {
    target,
    timeoutMs: call.timeoutMs,
    retries: call.retries,
    backoffBaseMs: call.backoffBaseMs,
    jitter: call.jitter,
    ...(split && call.share !== undefined ? { share: call.share } : {}),
  };
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
