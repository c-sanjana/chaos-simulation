import type { TierConfig } from '../engine/config';
import { lognormalMoments } from '../engine/theory';
import { LIMITS } from '../data/limits';
import type { Axis, ScenarioPreset, TopologyPreset } from '../data/types';

const START_MS = 30_000;
const DURATION_MS = 120_000;

const meanMs = (t: TierConfig) => (t.service.kind === 'lognormal' ? lognormalMoments(t.service.medianMs, t.service.p99Ms).mean : t.service.kind === 'fixed' ? t.service.ms : t.service.meanMs);

/** Requests a second one tier can compute when busy: copies × usable concurrency ÷ mean compute time. */
export function tierCapacityRps(t: TierConfig): number {
  return (t.instances * Math.min(t.coresPerInstance, t.workersPerInstance) * 1000) / meanMs(t);
}

/**
 * Roughly how much user traffic the chain handles when its caches don't help: each tier's capacity
 * (a queue's consumers capped by how fast the next tier answers), the smallest wins.
 * Why ignore cache hits? During a failure caches drain (nothing refills expired entries), so the
 * traffic a system can survive a failure at is close to what it handles without them. On the
 * preset this gives the DB's ~160 req/s and the preset's own 60–240 map range.
 * ASSUMPTION: an estimate on a healthy system without retries, used only to pick the tipping-point
 * map's traffic range (the simulation itself decides what actually happens).
 */
export function estimateCapacityRps(topology: TopologyPreset): number {
  const byId = new Map(topology.tiers.map((t) => [t.id, t]));
  let best = Infinity;
  for (let t = byId.get(topology.clientCall.target); t; t = t.downstream ? byId.get(t.downstream.target) : undefined) {
    best = Math.min(best, tierCapacityRps(t));
    if (t.cacheAside) best = Math.min(best, tierCapacityRps(byId.get(t.cacheAside.target)!));
    if (t.queue && t.downstream) best = Math.min(best, (t.queue.consumers * 1000) / meanMs(byId.get(t.downstream.target)!));
  }
  return best;
}

/** Whole, round steps that read well on an axis. */
const NICE_STEPS = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500];

/**
 * The round step closest to `target` (by ratio) that is no bigger than the client's traffic,
 * preferring one that divides the client's traffic exactly (so it is a cell of its own) when such a
 * step is within a factor of 1.6 of the target.
 */
function pickStep(target: number, client: number): number {
  const off = (s: number) => Math.abs(Math.log(s / target));
  const usable = NICE_STEPS.filter((s) => s <= client);
  const exact = usable.filter((s) => client % s === 0 && off(s) <= Math.log(1.6));
  return (exact.length > 0 ? exact : usable).reduce((a, b) => (off(b) < off(a) ? b : a));
}

/**
 * The tipping-point map's traffic levels for a built system: 5 to 10 whole numbers in round steps,
 * from about a third of the users' own traffic to about twice it, never above LIMITS.maxRps.
 *
 * ASSUMPTION: the map answers "how close is *my* traffic to the edge?", so it is centred on the
 * client's traffic, which is always inside it (a cell of its own whenever a round step divides it).
 * When the capacity estimate (without cache help) is nearby (1/4x to 4x the traffic) the range
 * widens to take it in, since the tipping point is usually just below it. Without a cache that
 * estimate is close to the real limit, so the range stops at 1.25x it (or just past the traffic, if
 * that is higher): further right every cell is plain overload, failure or not (review: at 1.5x,
 * half the map was). With a cache the healthy system handles more than the estimate, so the full
 * 2x is kept. On the example system (200 req/s, DB ~160 req/s, cached) this gives 50-400.
 */
export function trafficAxis(clientRps: number, capacityRps: number, hasCache: boolean): Axis {
  const max = LIMITS.maxRps;
  const c = Math.min(max, Math.max(1, Math.round(clientRps)));
  const k = Number.isFinite(capacityRps) && capacityRps > 0 ? capacityRps : c;
  let lo = 0.3 * c;
  let hi = 2 * c;
  if (k >= c / 4 && k <= 4 * c) {
    lo = Math.min(lo, 0.5 * k);
    hi = Math.max(hi, 1.2 * k);
  }
  if (!hasCache) hi = Math.min(hi, Math.max(1.25 * k, 1.2 * c));
  hi = Math.min(hi, max);

  const step = pickStep((hi - lo) / 9, c);
  let first = Math.max(step, Math.round(lo / step) * step);
  if (first > c) first = Math.floor(c / step) * step; // >= step, as step <= c
  let count = Math.min(10, Math.max(5, Math.floor((hi - first) / step) + 1));
  // The client's traffic must be on the map: move the range right until it is.
  const last = () => first + (count - 1) * step;
  if (last() < c) first += Math.ceil((c - last()) / step) * step;
  // Never past the limit: drop levels above it, then add levels below while there is room.
  while (last() > max) count--;
  while (count < 5 && first - step >= step) (first -= step, count++);
  return { param: 'rps', label: 'traffic (requests/s)', values: Array.from({ length: count }, (_, i) => first + i * step) };
}

/** The traffic axis of a built topology at `rps` (shared by every scenario, recomputed when the traffic changes). */
export function builtTrafficAxis(topology: TopologyPreset, rps: number): Axis {
  return trafficAxis(rps, estimateCapacityRps(topology), topology.tiers.some((t) => t.cache));
}

/** e.g. 0.3 -> "0.3 ms", 134 -> "134 ms", 2500 -> "2.5 s": how long a request takes, for the failure blurbs. */
function formatTime(ms: number): string {
  if (ms >= 1000) return `${Math.round(ms / 100) / 10} s`;
  return `${ms < 10 ? Math.round(ms * 10) / 10 : Math.round(ms)} ms`;
}

/** The typical (median) time of a tier's work. */
const medianMs = (t: TierConfig) => (t.service.kind === 'lognormal' ? t.service.medianMs : meanMs(t));

const lengths = (seconds: number[]): Axis => ({ param: 'outageMs', label: 'failure length', values: seconds.map((s) => s * 1000) });

/**
 * The scenarios a built topology offers, each aimed at the part it names (by what the part is,
 * not its id): the database slows down; the cache restarts empty; the front door slows down; the
 * work behind a queue slows down. Only those that apply are offered.
 * `kinds` says what each tier is, by tier id ('loadBalancer', 'server', 'database', 'cache', 'queue').
 */
export function builtScenarios(topology: TopologyPreset, kinds: Record<string, string>, rps: number): ScenarioPreset[] {
  const byId = new Map(topology.tiers.map((t) => [t.id, t]));
  const chain: TierConfig[] = [];
  for (let t = byId.get(topology.clientCall.target); t; t = t.downstream ? byId.get(t.downstream.target) : undefined) chain.push(t);
  const label = (id: string) => topology.layout[id]?.label ?? id;
  const x = builtTrafficAxis(topology, rps);
  const base = { topology: topology.id, rps, durationMs: DURATION_MS };
  const out: ScenarioPreset[] = [];

  const db = [...chain].reverse().find((t) => kinds[t.id] === 'database');
  if (db) {
    out.push({
      ...base,
      id: 'custom-db-slow',
      title: `${label(db.id)} slows down`,
      blurb: `${label(db.id)} is 8× slower for 5 s; everything that retries piles on.`,
      faults: [{ tier: db.id, kind: 'slow', factor: 8, startMs: START_MS, endMs: START_MS + 5_000 }],
      map: { x, y: lengths([12, 8, 5, 3, 2, 1]) },
    });
  }
  const cache = topology.tiers.find((t) => t.cache);
  if (cache) {
    out.push({
      ...base,
      id: 'custom-cache-restart',
      title: `${label(cache.id)} restarts empty`,
      blurb: `${label(cache.id)} goes down for 5 s and comes back empty; every lookup falls through.`,
      faults: [{ tier: cache.id, kind: 'dead', startMs: START_MS, endMs: START_MS + 5_000, flushAtEnd: true }],
      map: { x, y: lengths([20, 10, 5, 3, 1]) },
    });
  }
  const front = chain[0];
  if (front && kinds[front.id] !== 'database' && kinds[front.id] !== 'queue') {
    // ASSUMPTION: slow it down enough that it can serve only about half of the users' traffic; a
    // front door usually has lots of spare capacity, so a fixed factor would often go unnoticed.
    // Sized for the client's traffic: on the map's other traffic levels the same slowdown is
    // relatively milder or harsher, which is part of what the map shows. It stays a slowdown, not
    // an outage: a typical request still finishes within half of the users' timeout.
    const median = medianMs(front);
    const byTimeout = topology.clientCall.timeoutMs === null ? 1000 : Math.max(2, Math.floor(topology.clientCall.timeoutMs / 2 / median));
    const factor = Math.min(1000, byTimeout, Math.max(2, Math.round((2 * tierCapacityRps(front)) / rps)));
    out.push({
      ...base,
      id: 'custom-front-slow',
      title: `${label(front.id)} slows down`,
      blurb: `${label(front.id)}, the first thing users reach, takes ~${formatTime(median * factor)} a request instead of ~${formatTime(median)} (${factor}× slower) for 20 s.`,
      faults: [{ tier: front.id, kind: 'slow', factor, startMs: START_MS, endMs: START_MS + 20_000 }],
      map: { x, y: lengths([30, 20, 10, 5, 2]) },
    });
  }
  const queue = chain.find((t) => t.queue && t.downstream);
  if (queue) {
    const worker = queue.downstream!.target;
    // ASSUMPTION: slow it until each piece of work takes long enough that the consumers get through
    // only about half the messages arriving (consumers ÷ time per message = rps ÷ 2). A part with
    // room to spare barely notices a fixed 8×, and the backlog never builds.
    const factor = Math.min(1000, Math.max(2, Math.round((2 * queue.queue!.consumers * 1000) / rps / meanMs(byId.get(worker)!))));
    out.push({
      ...base,
      id: 'custom-queue-backlog',
      title: `Work behind ${label(queue.id)} slows down`,
      blurb: `${label(worker)} takes ~${formatTime(medianMs(byId.get(worker)!) * factor)} a request instead of ~${formatTime(medianMs(byId.get(worker)!))} (${factor}× slower) for 20 s; messages pile up in ${label(queue.id)}. Does it catch up?`,
      faults: [{ tier: worker, kind: 'slow', factor, startMs: START_MS, endMs: START_MS + 20_000 }],
      map: { x, y: lengths([40, 20, 10, 5, 2]) },
    });
  }
  return out;
}
