import { callsOf, shareWeight, type CallPolicy, type RunConfig, type TierConfig } from '../engine/config';
import type { RunResult, TierSeries } from '../engine/result';
import { serviceTimeMoments } from '../engine/distributions';
import { KIND_LABELS } from '../builder/graph';

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

/** The tier with this id, for ids taken from the config itself (it must exist). */
export const tierOf = (config: RunConfig, id: string): TierConfig => tierById(config, id)!;

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
  const total = calls.reduce((n, c) => n + shareWeight(c.share), 0);
  return shareWeight(edge.policy.share) / total;
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
 * Calls one user request makes in all, on average, before retries: the sum of every tier's
 * traffic share (see trafficShares). The presets make 4 (load balancer, app server, its cache
 * lookup, database). A diagram where every part calls every part of the next column multiplies
 * this from column to column, so the run-size guard counts it (data/limits.ts).
 */
export function callsPerRequest(config: RunConfig): number {
  return Object.values(trafficShares(config)).reduce((a, b) => a + b, 0);
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

/*
 * Ways through the call graph. A diagram can have very many ways from users to a part (a mesh
 * where every part calls every part of the next column has width^depth), so nothing here lists
 * them: each question is answered in one pass over the tiers in topological order (review 3, F8).
 */

/**
 * The tiers from which a request can reach `tierId` by calls (downstream calls and cache lookups),
 * `tierId` itself included, going only through tiers `through` allows (`tierId` need not). Empty
 * for an unknown id. One pass, callees first.
 */
export function tiersLeadingTo(config: RunConfig, tierId: string, through: (id: string) => boolean = () => true): Set<string> {
  const out = new Set<string>();
  if (!tierById(config, tierId)) return out;
  out.add(tierId);
  for (const id of topologicalOrder(config).reverse()) {
    if (id !== tierId && through(id) && callsFrom(config, id).some((e) => out.has(e.policy.target))) out.add(id);
  }
  return out;
}

/**
 * Every call that lies on some way a user request can reach `tierId`: its caller is reached by
 * users (or is the client) and its target is `tierId` or leads to it. Config order (see
 * allCallEdges). Empty if nothing reaches it (and for 'client'). Includes the cache lookup into
 * `tierId` when it is a cache.
 */
export function callsLeadingTo(config: RunConfig, tierId: string): CallEdge[] {
  const leading = tiersLeadingTo(config, tierId);
  const reached = new Set(['client', ...reachableFrom(config, 'client')]);
  return allCallEdges(config).filter((e) => reached.has(e.from) && leading.has(e.policy.target));
}

/**
 * The way from users to `tierId` whose calls give the largest product of `weight` (each weight at
 * least 1, e.g. how many times a call can be sent): that product and the calls along the way,
 * front to back. Null when nothing reaches it. On a tie, the way found first (callers in
 * topological order, each one's calls in order). One pass, callers first.
 * - `restartAt`: tiers where the product starts afresh (the calls listed then start there too),
 *   e.g. a message queue, which answers its senders before anything behind it is called.
 * - `via`: only ways through this call that still count it (no restart after it); null if none.
 */
export function heaviestPathTo(
  config: RunConfig,
  tierId: string,
  weight: (e: CallEdge) => number,
  restartAt: (id: string) => boolean = () => false,
  via?: CallEdge,
): { product: number; calls: CallEdge[] } | null {
  type Way = { product: number; calls: CallEdge[] };
  const isVia = (e: CallEdge) => via !== undefined && e.from === via.from && e.kind === via.kind && e.index === via.index;
  // Best way to each tier, keyed by tier and whether it went through `via` yet ('1') or not ('0').
  const best = new Map<string, Way>();
  const relax = (from: Way, passed: boolean, e: CallEdge) => {
    const key = `${e.policy.target}|${passed || isVia(e) ? 1 : 0}`;
    const product = from.product * weight(e);
    const known = best.get(key);
    if (known === undefined || product > known.product) best.set(key, { product, calls: [...from.calls, e] });
  };
  for (const e of callsFrom(config, 'client')) relax({ product: 1, calls: [] }, false, e);
  for (const id of topologicalOrder(config)) {
    if (id === tierId) break; // everything after it in the order is behind it or elsewhere
    const [before, after] = [best.get(`${id}|0`), best.get(`${id}|1`)];
    if (restartAt(id)) {
      // Whatever came before is answered here; a way through `via` no longer counts it.
      if (before || after) for (const e of callsFrom(config, id)) relax({ product: 1, calls: [] }, false, e);
      continue;
    }
    for (const e of callsFrom(config, id)) {
      if (before) relax(before, false, e);
      if (after) relax(after, true, e);
    }
  }
  return best.get(`${tierId}|${via ? 1 : 0}`) ?? null;
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
 * What one call sent per bucket in a run, `part` 'retries' or every try ('all'): read from the
 * caller's per-call counts (TierSeries.calls). Users' apps have none: their call is the target's
 * arrivals less what every other caller of it sent. Without per-call counts (hand-made results),
 * the target's arrivals when it has one caller, else the caller's own retries sent ('retries';
 * ASSUMPTION: then all of its calls' retries count for each) or arrivals split evenly ('all').
 */
export function sentAlong(config: RunConfig, run: RunResult, edge: CallEdge, part: 'retries' | 'all'): number[] {
  const target = edge.policy.target;
  const t = run.tiers[target];
  const arrived = part === 'retries' ? t.arrivalsRetry : t.arrivalsFirst.map((n, s) => n + t.arrivalsRetry[s]);
  const counted = (from: string) => {
    const call = run.tiers[from]?.calls?.find((c) => c.target === target);
    return call && (part === 'retries' ? call.retries : call.first.map((n, s) => n + call.retries[s]));
  };
  const callers = callersOf(config, target);
  if (edge.from !== 'client') {
    const own = counted(edge.from);
    if (own) return own;
    if (callers.length === 1) return arrived;
    const caller = run.tiers[edge.from];
    return part === 'retries' ? caller.retriesSent : arrived.map((n) => n / callers.length);
  }
  const others = callers.filter((c) => c.from !== 'client').map((c) => counted(c.from) ?? arrived.map(() => 0));
  return arrived.map((n, s) => Math.max(0, others.reduce((left, o) => left - o[s], n)));
}

/**
 * How many attempts each call into `tierId` carried, one entry per call in callersOf order: from a
 * run, every try the call sent (its first tries and retries, counted per call by the engine; see
 * sentAlong), and for the client the requests users sent; without a run, per user request
 * (trafficShares × callFraction, as if every cache lookup missed).
 * For hand-made results without per-call counts, an estimate: the caller's attempts (first tries
 * and repeats arriving at it) plus the retries it sent spread evenly over its calls,
 * × callFraction, × the share of its cache lookups that missed (for its downstream calls when it
 * looks things up in a cache: a hit makes none of them; a shared cache gives each caller its
 * overall miss rate).
 * Review 3, F5: counting every attempt of a well-cached caller picked it as the heaviest, and
 * every fix aimed at the bottleneck changed the wrong call. Exported for its tests; the fixes use
 * heaviestCallerInto.
 */
export function loadInto(config: RunConfig, tierId: string, run?: RunResult): Array<{ edge: CallEdge; load: number }> {
  const shares = run ? null : trafficShares(config);
  const total = (xs: number[]) => sumRange(xs, 0, xs.length);
  /** Share of a caller's cache lookups that missed: 1 without a cache, or with no lookups measured. */
  const missRate = (r: RunResult, edge: CallEdge) => {
    const cacheId = edge.kind === 'downstream' ? tierById(config, edge.from)?.cacheAside?.target : undefined;
    const cache = cacheId === undefined ? undefined : r.tiers[cacheId];
    const lookups = cache ? total(cache.arrivalsFirst) + total(cache.arrivalsRetry) : 0;
    return lookups > 0 ? 1 - total(cache!.hits) / lookups : 1;
  };
  return callersOf(config, tierId).map((edge) => {
    if (edge.from === 'client') return { edge, load: run ? total(run.client.sent) : 1 };
    const fraction = callFraction(config, edge);
    const t = run?.tiers[edge.from];
    if (!run) return { edge, load: shares![edge.from] * fraction };
    if (!t) return { edge, load: 0 };
    if (t.calls) return { edge, load: total(sentAlong(config, run, edge, 'all')) };
    const retries = total(t.retriesSent) / callsFrom(config, edge.from).length;
    return { edge, load: (total(t.arrivalsFirst) + total(t.arrivalsRetry) + retries) * fraction * missRate(run, edge) };
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

/**
 * Whether a tier does the work that requests pile up on: it calls nothing and is not a cache. A
 * cache calls nothing too (so it has a leafCapacityRps), but it only answers lookups for the tier
 * in front of it: when the database behind it fails, the story is about the database (review 3,
 * F2: a small cache was named as the overloaded part of a plain chain). Used wherever "the part
 * that struggled" is chosen (see strugglingPart).
 */
export function doesWork(tier: TierConfig): boolean {
  return !tier.cache && leafCapacityRps(tier) !== null;
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

/**
 * The most work a tier that calls nothing took on in one second over seconds [from, to), as a
 * multiple of what it can handle (admittedIn ÷ leafCapacityRps), leaving out the seconds `skip`
 * names. 0 for a tier that calls others or is not in the run. Shared by the story and the fix
 * explanations, which choose their seconds differently (see explain.ts pressureTier).
 */
export function peakLoad(config: RunConfig, run: RunResult, id: string, from: number, to: number, skip: (s: number) => boolean = () => false): number {
  const tier = tierById(config, id);
  const capacity = tier ? leafCapacityRps(tier) : null;
  const t = run.tiers[id];
  if (!capacity || !t) return 0;
  let peak = 0;
  for (let s = Math.max(0, from); s < Math.min(to, t.arrivalsFirst.length); s++) {
    if (!skip(s)) peak = Math.max(peak, Math.max(0, (admittedIn(t, s) * 1000) / run.bucketMs) / capacity);
  }
  return peak;
}

/** The seconds an incident is judged over: from the first failure's start, the end of the last failure, and the end of the judged range (all in ms). */
export interface IncidentWindow {
  fromMs: number;
  endMs: number;
  untilMs: number;
}

/** The incident window of a run with failures (see RecoveryResult's lastFaultEndMs and judgedUntilMs). */
export function incidentWindow(config: RunConfig, recovery: { lastFaultEndMs: number; judgedUntilMs: number }): IncidentWindow {
  const starts = (config.faults ?? []).map((f) => f.startMs);
  return { fromMs: starts.length ? Math.min(...starts) : 0, endMs: recovery.lastFaultEndMs, untilMs: recovery.judgedUntilMs };
}

/** Whether the whole tier `id` is down in second s (one of its instances down does not count). */
export function wholeTierDown(config: RunConfig, run: RunResult, id: string, s: number): boolean {
  const b = run.bucketMs;
  return (config.faults ?? []).some((f) => f.tier === id && f.kind === 'dead' && f.instance === undefined && f.startMs < (s + 1) * b && f.endMs > s * b);
}

/**
 * Whether a failure reaches tier `id` without anyone asking again: it failed itself, or it is
 * behind a failed part (called by it, directly or not, or read from when a failed cache misses).
 * Any other part gets more work from a failure only through repeats: callers asking again, which
 * a load balancer splits afresh and a server sends through the parts it calls first.
 */
export function failureReaches(config: RunConfig, id: string): boolean {
  return (config.faults ?? []).some((f) => {
    if (f.tier === id) return true;
    const users = tierById(config, f.tier)?.cache ? config.tiers.filter((t) => t.cacheAside?.target === f.tier).map((t) => t.id) : [];
    return [f.tier, ...users].some((from) => reachableFrom(config, from).includes(id));
  });
}

/** Repeats arriving at a tier in second s: retries sent to it, and first tries made there for a repeat further up. */
function repeatsIn(t: TierSeries, s: number): number {
  return t.arrivalsRetry[s] + t.arrivalsFromRepeats[s];
}

/**
 * Whether repeats pushed tier `id` (one that calls nothing) over what it can handle in second s:
 * over with them, but not on users' own first tries alone. A part running close to what it can
 * handle goes over now and then without any failure; that is not the failure's doing (review 3,
 * F4: a pool at 95% use was said to be overloaded by repeats that never reached it).
 */
export function overByRepeats(config: RunConfig, run: RunResult, id: string, s: number): boolean {
  const t = run.tiers[id];
  const capacity = leafCapacityRps(tierOf(config, id))!;
  const perSecond = (n: number) => (n * 1000) / run.bucketMs;
  return perSecond(admittedIn(t, s)) > capacity && perSecond(admittedIn(t, s) - repeatsIn(t, s)) <= capacity;
}

/** Within this factor of the most overloaded part, a part counts as just as overloaded (a tie). */
const TIE_MARGIN = 1.1;

/**
 * The part that struggled: one rule shared by the story, the fix explanations, the fixes' target
 * and the load chart's default (review 3: they used to choose differently, and could name a part
 * that sat idle while another was drowning).
 *
 * Among the parts users' requests reach that do the work themselves (doesWork), counting another
 * part than one the failure reaches directly (see failureReaches) only if repeats pushed it over
 * what it can handle in some second (overByRepeats):
 * 1. the one with the highest average load against what it can handle after the last failure
 *    ended, if that is over 1: what kept the system from recovering. Its own spike while failing
 *    can be higher, but a part still drowning afterwards explains more (a database still at 3.8×
 *    while the failed one, called after it, got nothing);
 * 2. failing that, the one with the highest peak during the incident (leaving out seconds the
 *    whole part was down: it refused those requests at once, so they were no work), if over 1;
 * 3. else null.
 * `sustained` says which: true for 1 (still over after the failure), false for 2.
 * Parts within 10% of the highest count as a tie, won by a part that failed, else by the first in
 * topological order, so every caller names the same part.
 */
export function strugglingPart(config: RunConfig, run: RunResult, w: IncidentWindow): { id: string; load: number; sustained: boolean } | null {
  const b = run.bucketMs;
  const [from, after, to] = [Math.floor(w.fromMs / b), Math.ceil(w.endMs / b), Math.floor(w.untilMs / b)];
  const reached = new Set(reachableFrom(config, 'client'));
  const failed = new Set((config.faults ?? []).map((f) => f.tier));
  const counts = (id: string) => {
    if (failureReaches(config, id)) return true;
    for (let s = Math.max(0, from); s < Math.min(to, run.tiers[id].arrivalsFirst.length); s++) if (overByRepeats(config, run, id, s)) return true;
    return false;
  };
  const candidates = topologicalOrder(config).filter((id) => reached.has(id) && run.tiers[id] && doesWork(tierOf(config, id)) && counts(id));
  const pick = (loads: Array<{ id: string; load: number }>) => {
    const over = loads.filter((l) => l.load > 1);
    if (over.length === 0) return null;
    const top = Math.max(...over.map((l) => l.load));
    const near = over.filter((l) => l.load * TIE_MARGIN >= top);
    return near.find((l) => failed.has(l.id)) ?? near[0];
  };
  const averageAfter = (id: string) => {
    const capacity = leafCapacityRps(tierOf(config, id))!;
    let sum = 0;
    for (let s = after; s < to; s++) sum += Math.max(0, (admittedIn(run.tiers[id], s) * 1000) / b);
    return sum / Math.max(1, to - after) / capacity;
  };
  const after_ = pick(candidates.map((id) => ({ id, load: averageAfter(id) })));
  if (after_) return { ...after_, sustained: true };
  const during = pick(candidates.map((id) => ({ id, load: peakLoad(config, run, id, from, to, (s) => wholeTierDown(config, run, id, s)) })));
  return during && { ...during, sustained: false };
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

export const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "a", "a and b", "a, b and c" (or "a or b"). */
export const listed = (items: string[], and = 'and') => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} ${and} ${items[items.length - 1]}`);

/** How often, in words: "once", "twice", "3 times". */
export const times = (n: number) => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`);

/** Display name for a tier id ("client" → "Client", otherwise the label or the id). */
export function nameOf(id: string, labels: Record<string, string>): string {
  return labels[id] ?? (id === 'client' ? 'Client' : id);
}

/** The builder's names for the kinds of part; only these are common nouns (see spokenName). */
const KIND_NAMES = new Set(Object.values(KIND_LABELS));

/**
 * How a newcomer would say a tier's name:
 * - "the database" for DB;
 * - a built-in kind name as a common noun, in lower case: "the load balancer", "the app server",
 *   "the cache" (the preset's names, and the builder's kind labels);
 * - a name ending in a number as it is, like a proper name: "Database 2", "App server 2" ("the
 *   database 2" read badly, review 3);
 * - any other name, which someone typed, with its own spelling: "the Ledger DB", "the API",
 *   "the redis" (review 3: lower-casing turned "Ledger DB" into "the ledger db").
 */
export function spokenName(id: string, labels: Record<string, string>): string {
  const label = nameOf(id, labels);
  if (id === 'client') return 'the client';
  if (label === 'DB') return 'the database';
  if (/\s\d+$/.test(label)) return label;
  return KIND_NAMES.has(label) ? `the ${label.toLowerCase()}` : `the ${label}`;
}
