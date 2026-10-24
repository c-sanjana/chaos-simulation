import type { TierConfig } from '../engine/config';
import { lognormalMoments } from '../engine/theory';
import { LIMITS } from '../data/limits';
import type { Axis, ScenarioPreset, TopologyPreset } from '../data/types';
import { trafficShares } from '../analysis/helpers';

const START_MS = 30_000;
const DURATION_MS = 120_000;

const meanMs = (t: TierConfig) => (t.service.kind === 'lognormal' ? lognormalMoments(t.service.medianMs, t.service.p99Ms).mean : t.service.kind === 'fixed' ? t.service.ms : t.service.meanMs);

/** Requests a second one tier can compute when busy: copies × usable concurrency ÷ mean compute time. */
export function tierCapacityRps(t: TierConfig): number {
  return (t.instances * Math.min(t.coresPerInstance, t.workersPerInstance) * 1000) / meanMs(t);
}

/**
 * Roughly how much user traffic the system handles when its caches don't help: each tier's capacity
 * (a queue's consumers capped by how fast the next tier answers) divided by its share of the users'
 * requests (`trafficShares`: a load balancer splitting over three servers sends each about a
 * third; a server calling two databases sends each all of its requests), the smallest wins.
 * Why ignore cache hits? During a failure caches drain (nothing refills expired entries), so the
 * traffic a system can survive a failure at is close to what it handles without them. On the
 * preset this gives the DB's ~160 req/s and the preset's own 60–240 map range.
 * ASSUMPTION: an estimate on a healthy system without retries, used only to pick the tipping-point
 * map's traffic range (the simulation itself decides what actually happens).
 */
export function estimateCapacityRps(topology: TopologyPreset): number {
  const byId = new Map(topology.tiers.map((t) => [t.id, t]));
  const shares = sharesOf(topology);
  let best = Infinity;
  for (const t of topology.tiers) {
    const share = shares[t.id] ?? 0;
    if (!(share > 0)) continue;
    best = Math.min(best, tierCapacityRps(t) / share);
    if (t.queue && t.downstream) best = Math.min(best, (t.queue.consumers * 1000) / meanMs(byId.get(t.downstream.target)!) / share);
  }
  return best;
}

/** Each tier's share of the users' requests (`trafficShares`), for a topology without a scenario. */
export function sharesOf(topology: TopologyPreset): Record<string, number> {
  return trafficShares({ seed: 0, durationMs: 0, client: { rps: 0, call: topology.clientCall }, tiers: topology.tiers });
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

/** At most this many scenarios of one kind (databases, caches, queues), the busiest first, so the list stays short. */
export const MAX_PER_KIND = 3;

/**
 * The scenarios a built topology offers, each aimed at the part it names (by what the part is,
 * not its id): each database slows down; each cache restarts empty; the front door slows down; the
 * work behind each queue slows down. Only those that apply are offered. With several parts of a
 * kind, the busiest (largest share of the users' requests) come first, up to `MAX_PER_KIND`; the
 * first of each kind keeps the plain id ('custom-db-slow'), the others add the part's id.
 * `kinds` says what each tier is, by tier id ('loadBalancer', 'server', 'database', 'cache', 'queue').
 */
export function builtScenarios(topology: TopologyPreset, kinds: Record<string, string>, rps: number): ScenarioPreset[] {
  const byId = new Map(topology.tiers.map((t) => [t.id, t]));
  const shares = sharesOf(topology);
  const share = (t: TierConfig) => shares[t.id] ?? 0;
  const position = (t: TierConfig) => topology.tiers.indexOf(t);
  /** Busiest first; among equally busy, front to back (databases back to front: the last one first, as in a chain). */
  const busiest = (list: TierConfig[], lastFirst = false) =>
    list
      .filter((t) => share(t) > 0)
      .sort((a, b) => share(b) - share(a) || (lastFirst ? position(b) - position(a) : position(a) - position(b)))
      .slice(0, MAX_PER_KIND);
  const idFor = (base: string, i: number, t: TierConfig) => (i === 0 ? base : `${base}-${t.id}`);
  const label = (id: string) => topology.layout[id]?.label ?? id;
  const x = builtTrafficAxis(topology, rps);
  const base = { topology: topology.id, rps, durationMs: DURATION_MS };
  const out: ScenarioPreset[] = [];

  busiest(topology.tiers.filter((t) => kinds[t.id] === 'database'), true).forEach((db, i) => {
    out.push({
      ...base,
      id: idFor('custom-db-slow', i, db),
      title: `${label(db.id)} slows down`,
      blurb: `${label(db.id)} is 8× slower for 5 s; everything that retries piles on.`,
      faults: [{ tier: db.id, kind: 'slow', factor: 8, startMs: START_MS, endMs: START_MS + 5_000 }],
      map: { x, y: lengths([12, 8, 5, 3, 2, 1]) },
    });
  });
  busiest(topology.tiers.filter((t) => t.cache)).forEach((cache, i) => {
    out.push({
      ...base,
      id: idFor('custom-cache-restart', i, cache),
      title: `${label(cache.id)} restarts empty`,
      blurb: `${label(cache.id)} goes down for 5 s and comes back empty; every lookup falls through.`,
      faults: [{ tier: cache.id, kind: 'dead', startMs: START_MS, endMs: START_MS + 5_000, flushAtEnd: true }],
      map: { x, y: lengths([20, 10, 5, 3, 1]) },
    });
  });
  const front = byId.get(topology.clientCall.target);
  if (front && kinds[front.id] !== 'database' && kinds[front.id] !== 'queue') {
    // ASSUMPTION: slow it down enough that it can serve only about half of the users' traffic; a
    // front door usually has lots of spare capacity, so a fixed factor would often go unnoticed.
    // Sized for the traffic reaching it at the client's traffic (all of it: the front door's share
    // is 1): on the map's other traffic levels the same slowdown is relatively milder or harsher,
    // which is part of what the map shows. It stays a slowdown, not an outage: a typical request
    // still finishes within half of the users' timeout.
    const median = medianMs(front);
    const byTimeout = topology.clientCall.timeoutMs === null ? 1000 : Math.max(2, Math.floor(topology.clientCall.timeoutMs / 2 / median));
    const factor = Math.min(1000, byTimeout, Math.max(2, Math.round((2 * tierCapacityRps(front)) / (rps * (share(front) || 1)))));
    out.push({
      ...base,
      id: 'custom-front-slow',
      title: `${label(front.id)} slows down`,
      blurb: `${label(front.id)}, the first thing users reach, takes ~${formatTime(median * factor)} a request instead of ~${formatTime(median)} (${factor}× slower) for 20 s.`,
      faults: [{ tier: front.id, kind: 'slow', factor, startMs: START_MS, endMs: START_MS + 20_000 }],
      map: { x, y: lengths([30, 20, 10, 5, 2]) },
    });
  }
  busiest(topology.tiers.filter((t) => t.queue && t.downstream && byId.has(t.downstream.target))).forEach((queue, i) => {
    const worker = byId.get(queue.downstream!.target)!;
    // ASSUMPTION: slow it until each piece of work takes long enough that the consumers get through
    // only about half the messages arriving (consumers ÷ time per message = the queue's traffic ÷ 2).
    // A part with room to spare barely notices a fixed 8×, and the backlog never builds. The queue's
    // traffic is its share of the users' requests (all of them in a chain).
    const factor = Math.min(1000, Math.max(2, Math.round((2 * queue.queue!.consumers * 1000) / (rps * share(queue)) / meanMs(worker))));
    out.push({
      ...base,
      id: idFor('custom-queue-backlog', i, queue),
      title: `Work behind ${label(queue.id)} slows down`,
      blurb: `${label(worker.id)} takes ~${formatTime(medianMs(worker) * factor)} a request instead of ~${formatTime(medianMs(worker))} (${factor}× slower) for 20 s; messages pile up in ${label(queue.id)}. Does it catch up?`,
      faults: [{ tier: worker.id, kind: 'slow', factor, startMs: START_MS, endMs: START_MS + 20_000 }],
      map: { x, y: lengths([40, 20, 10, 5, 2]) },
    });
  });
  return out;
}
