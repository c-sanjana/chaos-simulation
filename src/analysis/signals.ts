import type { RunConfig } from '../engine/config';
import type { RunResult, TierSeries } from '../engine/result';
import { idleSaturated, incidentWindow, ownHitRate, ownLookups, queuedWaitMs, strictestCallerInto, strugglingPart, sumRange } from './helpers';
import type { RecoveryResult } from './recovery';

/** Something measured in the run that points at a particular kind of fix. */
export interface Signal<T = number> {
  tier: string;
  value: T;
}

/**
 * Aggregate symptoms over the incident window (first failure start to the end of the judged range),
 * used to decide which fixes are worth trying. Each is the worst tier for that symptom, or null.
 */
export interface Signals {
  /**
   * The part that struggled (see strugglingPart): the one the story, the fix explanations, the
   * fixes and the load chart are about. `value.load` is its load against what it can handle: the
   * average after the failure ended (`sustained`), or else the peak during it.
   */
  overloaded: Signal<{ load: number; sustained: boolean }> | null;
  /** Share of attempts arriving at a tier that were retries. */
  retryShare: Signal | null;
  /**
   * The same share for every tier with arrivals, so a fix can quote the part it is aimed at
   * (review 3: a fix on the database call quoted the load balancer's share). Absent in hand-made
   * signals.
   */
  retryShareOf?: Record<string, number>;
  /**
   * Share of a tier's compute spent on attempts the caller had already abandoned. The tier is the
   * one that wasted the most compute time, not the highest share: a part doing almost no work can
   * waste 100% of it (review 3: such a part was named, and "drop expired work" aimed at it).
   */
  wastedShare: Signal | null;
  /** Worst ratio of queued wait (queue ÷ throughput) to the caller's timeout. */
  queueWaitOverTimeout: Signal | null;
  /** Tier whose workers were saturated while its cores were mostly idle (waiting, not working). */
  idleSaturation: Signal | null;
  /**
   * Cache hit rate (on users' own lookups, see ownHitRate) during the incident vs before it, and the
   * first second the failure made it fall below half of normal (`dip`, absent in hand-made signals):
   * the second the story and the timeline tell it at.
   */
  cacheHitDrop: Signal<{ before: number; during: number; dip?: { atS: number; rate: number } }> | null;
  /**
   * The message queue whose backlog grew most during the incident: its peak (messages waiting),
   * what was still waiting at the end of the judged range, the busiest its consumers got (share
   * of the pool) and the messages it dead-lettered. Only when more messages waited than the
   * consumers can hold at once.
   */
  queueBacklog: Signal<{ peak: number; atEnd: number; consumersBusy: number; deadLettered: number }> | null;
}

/** Fewer lookups than this in a second say nothing about a cache's hit rate (see cacheHitDrop). */
const MIN_LOOKUPS = 10;

/** The symptoms a fix can be tried for (every signal but the per-tier retry shares). */
export type SignalName = Exclude<keyof Signals, 'retryShareOf'>;

/**
 * `control` (the same run without the failure), when given, keeps a cache-hit dip that happens
 * just as much without the failure from counting as one (see cacheHitDrop below).
 */
export function computeSignals(run: RunResult, config: RunConfig, recovery: RecoveryResult, control?: RunResult): Signals {
  const faults = config.faults ?? [];
  const from = Math.floor((faults.length ? Math.min(...faults.map((f) => f.startMs)) : 0) / run.bucketMs);
  const to = Math.floor(recovery.judgedUntilMs / run.bucketMs);
  const tiers = Object.values(run.tiers);

  const worst = <T>(candidates: Array<Signal<T> & { score: number }>): Signal<T> | null => {
    const best = candidates.filter((c) => c.score > 0).sort((x, y) => y.score - x.score)[0];
    return best ? { tier: best.tier, value: best.value } : null;
  };

  const retryShares = tiers.map((t) => {
    const retries = sumRange(t.arrivalsRetry, from, to);
    const total = retries + sumRange(t.arrivalsFirst, from, to);
    const share = total > 0 ? retries / total : 0;
    return { tier: t.id, value: share, score: share };
  });
  const retryShare = worst(retryShares);
  const retryShareOf = Object.fromEntries(retryShares.map((r) => [r.tier, r.value]));

  const wastedShare = worst(
    tiers.map((t) => {
      const busy = sumRange(t.busyCoresAvg, from, to) * run.bucketMs;
      const wasted = sumRange(t.wastedMs, from, to);
      const share = busy > 0 ? Math.min(1, wasted / busy) : 0;
      return { tier: t.id, value: share, score: share > 0 ? wasted : 0 };
    }),
  );

  const queueWaits = tiers.map((t) => {
    // With several callers, the least patient one: it is the first to give up on the queue.
    const timeoutMs = strictestCallerInto(config, t.id)?.policy.timeoutMs ?? null;
    let ratio = 0;
    if (timeoutMs !== null) {
      for (let s = from; s < to; s++) ratio = Math.max(ratio, queuedWaitMs(run, t.id, s) / timeoutMs);
    }
      return { tier: t.id, value: ratio, score: ratio };
  });

  const idleSaturation = worst(
    tiers.map((t) => {
      let seconds = 0;
      for (let s = from; s < to; s++) {
        if (idleSaturated(t, s)) seconds++;
      }
      return { tier: t.id, value: seconds, score: seconds };
    }),
  );

  const cacheHitDrop = worst(
    tiers
      .filter((t) => (config.tiers.find((c) => c.id === t.id)?.cache ?? null) !== null)
      .map((t) => {
        // ASSUMPTION: the 20 seconds before the failure are "normal" for the cache (every preset and
        // built scenario starts its failure at 30 s, after the cache has warmed up).
        const before = ownHitRate(t, from - 20, from);
        const during = ownHitRate(t, from, to);
        // ASSUMPTION: a drop counts only if the failure caused it: in some second the hit rate fell
        // below half of normal (the rule the story and the timeline tell it by) with at least
        // MIN_LOOKUPS lookups, while the run without the failure, when known, did not dip in that
        // second. A cache with a few lookups a second dips now and then on its own (review 3: a dip
        // identical to the no-failure run was told as a consequence of a failure elsewhere).
        const normal = control?.tiers[t.id];
        const dips = (x: TierSeries, s: number, min: number) => ownLookups(x, s) >= min && ownHitRate(x, s, s + 1) < before / 2;
        let dip: { atS: number; rate: number } | undefined;
        for (let s = from; s < to && !dip; s++) if (dips(t, s, MIN_LOOKUPS) && !(normal && dips(normal, s, 1))) dip = { atS: s, rate: ownHitRate(t, s, s + 1) };
        return { tier: t.id, value: dip ? { before, during, dip } : { before, during }, score: dip ? before - during : 0 };
      }),
  );

  const queueBacklog = worst(
    tiers
      .filter((t) => t.consumers > 0)
      .map((t) => {
        let peak = 0;
        let busy = 0;
        for (let s = from; s < to; s++) (peak = Math.max(peak, t.backlogAvg[s])), (busy = Math.max(busy, t.busyConsumersAvg[s] / t.consumers));
        const value = { peak, atEnd: t.backlogAvg[Math.max(from, to - 1)] ?? 0, consumersBusy: busy, deadLettered: sumRange(t.deadLettered, from, to) };
        return { tier: t.id, value, score: peak > t.consumers ? peak : 0 };
      }),
  );

  const struggling = strugglingPart(config, run, incidentWindow(config, recovery));
  const overloaded = struggling && { tier: struggling.id, value: { load: struggling.load, sustained: struggling.sustained } };
  // Queued work outlasting its caller's patience, at the part still overloaded after the failure
  // when its queue did so too: a short timeout on another part's call inflates that part's ratio
  // (review 3: "bound the queue" went to a part that sat idle while the database before it drowned).
  const atOverloaded = overloaded?.value.sustained ? queueWaits.find((q) => q.tier === overloaded.tier && q.value > 1) : undefined;
  const queueWaitOverTimeout = atOverloaded ? { tier: atOverloaded.tier, value: atOverloaded.value } : worst(queueWaits);

  return { overloaded, retryShare, retryShareOf, wastedShare, queueWaitOverTimeout, idleSaturation, cacheHitDrop, queueBacklog };
}
