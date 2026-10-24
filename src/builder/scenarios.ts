import type { TierConfig } from '../engine/config';
import { lognormalMoments } from '../engine/theory';
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

/** A "nice" number near x (1, 2, 2.5 or 5 × a power of ten). */
function nice(x: number): number {
  const p = 10 ** Math.floor(Math.log10(x));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).reduce((a, b) => (Math.abs(b - x) < Math.abs(a - x) ? b : a));
}

/**
 * Ten traffic levels from about a third of the estimated capacity to 1.5×, evenly stepped:
 * the tipping point usually falls inside, as on the presets' maps (DB at ~160 req/s → 60–240).
 */
export function trafficAxis(capacityRps: number): Axis {
  const step = nice(capacityRps * 0.13);
  const first = Math.max(step, Math.round((capacityRps * 0.35) / step) * step);
  return { param: 'rps', label: 'traffic (requests/s)', values: Array.from({ length: 10 }, (_, i) => first + i * step) };
}

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
  const x = trafficAxis(estimateCapacityRps(topology));
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
    // ASSUMPTION: slow it down enough that it can serve only about half the traffic; a front door
    // usually has lots of spare capacity, so a fixed factor would often go unnoticed.
    const factor = Math.min(1000, Math.max(2, Math.round((2 * tierCapacityRps(front)) / rps)));
    out.push({
      ...base,
      id: 'custom-front-slow',
      title: `${label(front.id)} slows down`,
      blurb: `${label(front.id)}, the first thing users reach, is ${factor}× slower for 20 s.`,
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
      blurb: `${label(worker)} is ${factor}× slower for 20 s; messages pile up in ${label(queue.id)}. Does it catch up?`,
      faults: [{ tier: worker, kind: 'slow', factor, startMs: START_MS, endMs: START_MS + 20_000 }],
      map: { x, y: lengths([40, 20, 10, 5, 2]) },
    });
  }
  return out;
}
