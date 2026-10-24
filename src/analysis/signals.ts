import type { RunConfig } from '../engine/config';
import type { RunResult } from '../engine/result';
import { callerOf, sumRange } from './helpers';
import { queuedWaitMs } from './timeline';
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
  /** Share of attempts arriving at a tier that were retries. */
  retryShare: Signal | null;
  /** Share of a tier's compute spent on attempts the caller had already abandoned. */
  wastedShare: Signal | null;
  /** Worst ratio of queued wait (queue ÷ throughput) to the caller's timeout. */
  queueWaitOverTimeout: Signal | null;
  /** Tier whose workers were saturated while its cores were mostly idle (waiting, not working). */
  idleSaturation: Signal | null;
  /** Cache hit rate during the incident vs before it. */
  cacheHitDrop: Signal<{ before: number; during: number }> | null;
  /**
   * The message queue whose backlog grew most during the incident: its peak (messages waiting),
   * what was still waiting at the end of the judged range, the busiest its consumers got (share
   * of the pool) and the messages it dead-lettered. Only when more messages waited than the
   * consumers can hold at once.
   */
  queueBacklog: Signal<{ peak: number; atEnd: number; consumersBusy: number; deadLettered: number }> | null;
}

export function computeSignals(run: RunResult, config: RunConfig, recovery: RecoveryResult): Signals {
  const faults = config.faults ?? [];
  const from = Math.floor((faults.length ? Math.min(...faults.map((f) => f.startMs)) : 0) / run.bucketMs);
  const to = Math.floor(recovery.judgedUntilMs / run.bucketMs);
  const tiers = Object.values(run.tiers);

  const worst = <T>(candidates: Array<Signal<T> & { score: number }>): Signal<T> | null => {
    const best = candidates.filter((c) => c.score > 0).sort((x, y) => y.score - x.score)[0];
    return best ? { tier: best.tier, value: best.value } : null;
  };

  const retryShare = worst(
    tiers.map((t) => {
      const retries = sumRange(t.arrivalsRetry, from, to);
      const total = retries + sumRange(t.arrivalsFirst, from, to);
      const share = total > 0 ? retries / total : 0;
      return { tier: t.id, value: share, score: share };
    }),
  );

  const wastedShare = worst(
    tiers.map((t) => {
      const busy = sumRange(t.busyCoresAvg, from, to) * run.bucketMs;
      const share = busy > 0 ? Math.min(1, sumRange(t.wastedMs, from, to) / busy) : 0;
      return { tier: t.id, value: share, score: share };
    }),
  );

  const queueWaitOverTimeout = worst(
    tiers.map((t) => {
      const timeoutMs = callerOf(config, t.id)?.timeoutMs ?? null;
      let ratio = 0;
      if (timeoutMs !== null) {
        for (let s = from; s < to; s++) ratio = Math.max(ratio, queuedWaitMs(run, t.id, s) / timeoutMs);
      }
      return { tier: t.id, value: ratio, score: ratio };
    }),
  );

  const idleSaturation = worst(
    tiers.map((t) => {
      let seconds = 0;
      for (let s = from; s < to; s++) {
        if (t.busyWorkersAvg[s] >= 0.99 * t.workers && t.busyCoresAvg[s] < 0.5 * t.cores) seconds++;
      }
      return { tier: t.id, value: seconds, score: seconds };
    }),
  );

  const cacheHitDrop = worst(
    tiers
      .filter((t) => (config.tiers.find((c) => c.id === t.id)?.cache ?? null) !== null)
      .map((t) => {
        const rate = (a: number, b: number) => sumRange(t.hits, a, b) / Math.max(1, sumRange(t.ok, a, b));
        const before = rate(Math.max(0, from - 20), from);
        // Lookups that never reached the cache (refused while down) count as misses.
        const during = sumRange(t.hits, from, to) / Math.max(1, sumRange(t.arrivalsFirst, from, to) + sumRange(t.arrivalsRetry, from, to));
        return { tier: t.id, value: { before, during }, score: before - during };
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

  return { retryShare, wastedShare, queueWaitOverTimeout, idleSaturation, cacheHitDrop, queueBacklog };
}
