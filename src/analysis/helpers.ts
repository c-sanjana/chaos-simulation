import { callsOf, type CallPolicy, type RunConfig, type TierConfig } from '../engine/config';
import type { RunResult, TierSeries } from '../engine/result';
import { serviceTimeMoments } from '../engine/distributions';

/**
 * One call in a config's call graph: who makes it and its policy.
 * - `kind` 'call': the client's call (`from` is 'client').
 * - `kind` 'downstream': one of a tier's downstream calls; `index` is its position in
 *   `callsOf(tier)` (0 = `downstream`, 1 = `moreDownstream[0]`, …).
 * - `kind` 'cacheAside': a tier's cache lookups.
 * `index` is 0 for the client's call and cache lookups.
 */
export interface CallEdge {
  /** 'client' or the calling tier's id. */
  from: string;
  kind: 'call' | 'downstream' | 'cacheAside';
  index: number;
  policy: CallPolicy;
}

const tierById = (config: RunConfig, id: string): TierConfig | undefined => config.tiers.find((t) => t.id === id);

/**
 * Every call a caller makes, in the order it makes them: the client's one call, or a tier's cache
 * lookup (made first, when it has one) followed by its downstream calls in `callsOf` order.
 * Empty for an unknown id or a tier that calls nothing.
 */
export function callsFrom(config: RunConfig, id: string): CallEdge[] {
  if (id === 'client') return [{ from: 'client', kind: 'call', index: 0, policy: config.client.call }];
  const tier = tierById(config, id);
  if (!tier) return [];
  const calls: CallEdge[] = tier.cacheAside ? [{ from: id, kind: 'cacheAside', index: 0, policy: tier.cacheAside }] : [];
  callsOf(tier).forEach((policy, index) => calls.push({ from: id, kind: 'downstream', index, policy }));
  return calls;
}

/** Every call in the config: the client's, then each tier's (config order; see callsFrom). */
export function allCallEdges(config: RunConfig): CallEdge[] {
  return [...callsFrom(config, 'client'), ...config.tiers.flatMap((t) => callsFrom(config, t.id))];
}

/**
 * Every call into `tierId`, with who makes it: the client first, then tiers in config order (a
 * tier's downstream calls before its cache lookup). Empty if nothing calls it. With fan-in (two
 * tiers calling the same database) there are several.
 */
export function callersOf(config: RunConfig, tierId: string): CallEdge[] {
  const into = (e: CallEdge) => e.policy.target === tierId;
  const tiers = config.tiers.flatMap((t) => {
    const calls = callsFrom(config, t.id).filter(into);
    return [...calls.filter((e) => e.kind === 'downstream'), ...calls.filter((e) => e.kind === 'cacheAside')];
  });
  return [...callsFrom(config, 'client').filter(into), ...tiers];
}

/**
 * The first call into `tierId` (see callersOf): who makes it ('client' or a tier id) and its
 * policy, or null if nothing calls it. With fan-in, see also strictestCallerInto and
 * heaviestCallerInto.
 */
export function callPolicyInto(config: RunConfig, tierId: string): { id: string; policy: CallPolicy } | null {
  const first = callersOf(config, tierId)[0];
  return first ? { id: first.from, policy: first.policy } : null;
}

/** Who calls `tierId` first (see callPolicyInto) and with what timeout. */
export function callerOf(config: RunConfig, tierId: string): { id: string; timeoutMs: number | null } | null {
  const call = callPolicyInto(config, tierId);
  return call && { id: call.id, timeoutMs: call.policy.timeoutMs };
}

/**
 * The least patient caller of `tierId`: the call into it with the shortest timeout (the first one
 * on a tie), or the first call if none has a timeout; null if nothing calls it. When answers slow
 * down, this caller is the first to give up, so "p99 exceeds the X's timeout" and "queued longer
 * than the X's timeout" name it. In a chain it is the only caller.
 */
export function strictestCallerInto(config: RunConfig, tierId: string): CallEdge | null {
  let best: CallEdge | null = null;
  for (const c of callersOf(config, tierId)) {
    if (best === null || (c.policy.timeoutMs !== null && (best.policy.timeoutMs === null || c.policy.timeoutMs < best.policy.timeoutMs))) best = c;
  }
  return best;
}

/**
 * The share of a caller's attempts that a call carries: its normalised share when the caller
 * splits (fanOut 'split' with several calls), else 1 (sequence and parallel make every call;
 * cache lookups are made for every attempt).
 * ASSUMPTION: a sequence's later calls are counted as made every time, although a failure earlier
 * in the sequence skips them; in a healthy run that is what happens.
 */
export function callFraction(config: RunConfig, edge: CallEdge): number {
  if (edge.kind !== 'downstream') return 1;
  const tier = tierById(config, edge.from);
  const calls = tier ? callsOf(tier) : [];
  if (tier?.fanOut !== 'split' || calls.length < 2) return 1;
  const total = calls.reduce((n, c) => n + (c.share ?? 1), 0);
  return (edge.policy.share ?? 1) / total;
}

/**
 * Each tier's share of user requests: how many attempts reach it per request users send, before
 * retries. The entry tier gets 1; each call passes on its caller's share × callFraction (split
 * shares multiply; every call of a sequence or parallel fan-out, and every cache lookup, gets the
 * caller's full share); fan-in adds up. Cache hits are ignored: the calls behind a cache-aside
 * lookup get the full share, as if every lookup missed. A queue's consumers pass on the queue's
 * share. Tiers nothing reaches get 0.
 *
 * E.g. client → LB splitting 3:1 over A and B, both calling DB: LB 1, A 0.75, B 0.25, DB 1.
 * Meant for capacity estimates (the most traffic the system can take is about the smallest
 * capacity ÷ share over the tiers).
 */
export function trafficShares(config: RunConfig): Record<string, number> {
  const shares: Record<string, number> = Object.fromEntries(config.tiers.map((t) => [t.id, 0]));
  if (config.client.call.target in shares) shares[config.client.call.target] = 1;
  for (const id of topologicalOrder(config)) {
    for (const edge of callsFrom(config, id)) {
      if (edge.policy.target in shares) shares[edge.policy.target] += shares[id] * callFraction(config, edge);
    }
  }
  return shares;
}

/**
 * Tier ids front to back: every tier comes after all the tiers that call it (Kahn's algorithm over
 * downstream calls and cache lookups). Among tiers ready at the same time, the client's target
 * comes first, then config order. For a chain this is the chain's order, with a cache after the
 * tier that looks things up in it. Tiers on a cycle (which validation rejects) are left out.
 */
export function topologicalOrder(config: RunConfig): string[] {
  const ids = config.tiers.map((t) => t.id);
  const pending = new Map(ids.map((id) => [id, 0]));
  for (const e of allCallEdges(config)) {
    if (e.from !== 'client' && pending.has(e.policy.target)) pending.set(e.policy.target, pending.get(e.policy.target)! + 1);
  }
  const rank = (id: string) => (id === config.client.call.target ? -1 : ids.indexOf(id));
  const ready = ids.filter((id) => pending.get(id) === 0);
  const order: string[] = [];
  while (ready.length > 0) {
    ready.sort((a, b) => rank(a) - rank(b));
    const id = ready.shift()!;
    order.push(id);
    for (const e of callsFrom(config, id)) {
      const left = pending.get(e.policy.target);
      if (left === undefined) continue;
      pending.set(e.policy.target, left - 1);
      if (left === 1) ready.push(e.policy.target);
    }
  }
  return order;
}

/** At most this many paths are listed by pathsTo (a wide graph can have very many). */
export const MAX_PATHS = 64;

/**
 * Every way a user request can reach `tierId`: each path is the list of calls from the client's
 * call to the call into `tierId`, front to back. Empty if nothing reaches it (and for 'client').
 * A path can end with a cache lookup (caches call nothing, so only at the end).
 * ASSUMPTION: at most MAX_PATHS paths are listed, depth-first, following each caller's calls in
 * order; real diagrams have a handful.
 */
export function pathsTo(config: RunConfig, tierId: string): CallEdge[][] {
  const paths: CallEdge[][] = [];
  const walk = (path: CallEdge[], seen: Set<string>) => {
    if (paths.length >= MAX_PATHS) return;
    const next = path[path.length - 1].policy.target;
    if (next === tierId) {
      paths.push(path);
      return;
    }
    if (seen.has(next)) return; // a cycle (validation rejects these): stop rather than loop
    for (const e of callsFrom(config, next)) walk([...path, e], new Set(seen).add(next));
  };
  if (tierId !== 'client') walk(callsFrom(config, 'client'), new Set());
  return paths;
}

/** Every tier `id` calls, directly or through others (downstream calls and cache lookups), in the order first reached depth-first. */
export function reachableFrom(config: RunConfig, id: string): string[] {
  const seen = new Set<string>();
  const visit = (from: string) => {
    for (const e of callsFrom(config, from)) {
      if (!seen.has(e.policy.target)) {
        seen.add(e.policy.target);
        visit(e.policy.target);
      }
    }
  };
  visit(id);
  return [...seen];
}

/** Every caller in front of `id`, directly or not ('client' included), nearest first (breadth-first). */
export function callersInFront(config: RunConfig, id: string): string[] {
  const out: string[] = [];
  const queue = [id];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === 'client') continue;
    for (const c of callersOf(config, current)) {
      if (c.from !== id && !out.includes(c.from)) {
        out.push(c.from);
        queue.push(c.from);
      }
    }
  }
  return out;
}

/**
 * Roughly how many attempts each call into `tierId` carried, one entry per call in callersOf
 * order: from a run, the caller's attempts (first tries and repeats arriving at it) plus the
 * retries it sent spread evenly over its calls, × callFraction, and for the client the requests
 * users sent; without a run, per user request (trafficShares × callFraction).
 * ASSUMPTION: an estimate (a run counts arrivals per tier, not per call); it only has to tell
 * which caller sends the most.
 */
export function loadInto(config: RunConfig, tierId: string, run?: RunResult): Array<{ edge: CallEdge; load: number }> {
  const shares = run ? null : trafficShares(config);
  const total = (xs: number[]) => sumRange(xs, 0, xs.length);
  return callersOf(config, tierId).map((edge) => {
    if (edge.from === 'client') return { edge, load: run ? total(run.client.sent) : 1 };
    const fraction = callFraction(config, edge);
    const t = run?.tiers[edge.from];
    if (!run) return { edge, load: shares![edge.from] * fraction };
    if (!t) return { edge, load: 0 };
    const retries = total(t.retriesSent) / callsFrom(config, edge.from).length;
    return { edge, load: (total(t.arrivalsFirst) + total(t.arrivalsRetry) + retries) * fraction };
  });
}

/**
 * The call sending the most load into `tierId` (see loadInto; the first on a tie), or null if
 * nothing calls it. With one caller (a chain), that caller.
 */
export function heaviestCallerInto(config: RunConfig, tierId: string, run?: RunResult): CallEdge | null {
  let best: { edge: CallEdge; load: number } | null = null;
  for (const c of loadInto(config, tierId, run)) if (best === null || c.load > best.load) best = c;
  return best?.edge ?? null;
}

/** Tiers that do the work themselves (they call nothing) and that `id` calls, directly or not. */
export function reachableLeaves(config: RunConfig, id: string): string[] {
  return reachableFrom(config, id).filter((t) => {
    const tier = tierById(config, t);
    return tier !== undefined && leafCapacityRps(tier) !== null;
  });
}

/**
 * Requests per second a leaf tier (no downstream) can complete when busy: instances × the usable
 * concurrency (cores or workers, whichever is fewer) ÷ mean compute time. Null for tiers that call
 * others, whose throughput also depends on downstream latency.
 */
export function leafCapacityRps(tier: TierConfig): number | null {
  if (tier.downstream || tier.cacheAside) return null;
  const concurrency = Math.min(tier.coresPerInstance, tier.workersPerInstance);
  return (tier.instances * concurrency * 1000) / serviceTimeMoments(tier.service).mean;
}

/**
 * Attempts a tier took on in bucket s: arrivals minus those turned away at once because its queue
 * was full. Load against capacity uses this: a request refused on arrival costs (almost) no work,
 * and counting it made a bounded queue look like it multiplied the load 5× (review 2).
 */
export function admittedIn(t: TierSeries, s: number): number {
  return t.arrivalsFirst[s] + t.arrivalsRetry[s] - t.rejected[s];
}

export function sumRange(xs: number[], from: number, to: number): number {
  let s = 0;
  for (let i = Math.max(0, from); i < Math.min(xs.length, to); i++) s += xs[i];
  return s;
}

export function formatMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1).replace(/\.0$/, '')} s`;
  return `${Math.round(ms)} ms`;
}

export function formatSeconds(ms: number): string {
  return `${Math.round(ms / 1000)} s`;
}

export const percent = (x: number) => `${Math.round(x * 100)}%`;

/** Display name for a tier id ("client" → "Client", otherwise the label or the id). */
export function nameOf(id: string, labels: Record<string, string>): string {
  return labels[id] ?? (id === 'client' ? 'Client' : id);
}

/**
 * How a newcomer would say a tier's name: "the database" for DB, acronyms as they are ("the
 * API"), anything else in lower case ("the cache", "the gateway").
 */
export function spokenName(id: string, labels: Record<string, string>): string {
  const label = nameOf(id, labels);
  if (id === 'client') return 'the client';
  if (label === 'DB') return 'the database';
  return /^[A-Z0-9]{2,4}$/.test(label) ? `the ${label}` : `the ${label.toLowerCase()}`;
}
