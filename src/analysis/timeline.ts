import type { Fault, RunConfig } from '../engine/config';
import type { RunResult } from '../engine/result';
import { admittedIn, callerOf, formatMs, formatSeconds, leafCapacityRps, nameOf, percent } from './helpers';
import type { RecoveryResult } from './recovery';
import type { Signals } from './signals';

export interface TimelineEntry {
  tMs: number;
  /** For entries describing a period ("36–120 s"). */
  endMs?: number;
  text: string;
  kind: 'fault' | 'tip' | 'bad' | 'good' | 'info';
}

const MAX_ENTRIES = 10;

/**
 * A short, readable account of the run: what was injected, what broke and when, and the verdict.
 * Every entry is detected from the run's metrics and quotes the number it is based on.
 */
export function buildTimeline(
  run: RunResult,
  config: RunConfig,
  recovery: RecoveryResult,
  signals: Signals,
  labels: Record<string, string> = {},
): TimelineEntry[] {
  const name = (id: string) => nameOf(id, labels);
  const faults = config.faults ?? [];
  const startSecond = Math.floor((faults.length ? Math.min(...faults.map((f) => f.startMs)) : 0) / run.bucketMs);
  const endSecond = Math.floor(recovery.judgedUntilMs / run.bucketMs);
  const entries: TimelineEntry[] = [];
  const at = (s: number) => s * run.bucketMs;

  // A failure starting or ending at or after the end of the run has no place on its timeline.
  for (const f of faults) {
    if (f.startMs < run.durationMs) entries.push({ tMs: f.startMs, text: `${describeFault(f, name)} (injected failure)`, kind: 'fault' });
    if (f.endMs < run.durationMs) entries.push({ tMs: f.endMs, text: describeFaultEnd(f, name), kind: 'fault' });
  }

  // A tier's slowest responses outgrow its caller's patience: the caller starts timing out.
  for (let s = startSecond; s < endSecond; s++) {
    const hit = Object.values(run.tiers).find((t) => {
      const timeout = callerOf(config, t.id)?.timeoutMs ?? null;
      return timeout !== null && t.latencyP99Ms[s] > timeout;
    });
    if (hit) {
      const caller = callerOf(config, hit.id)!;
      entries.push({ tMs: at(s), text: `${name(hit.id)} p99 ${formatMs(hit.latencyP99Ms[s])} exceeds the ${name(caller.id)}'s ${formatMs(caller.timeoutMs!)} timeout`, kind: 'info' });
      break;
    }
  }

  // Retries push a leaf tier past what it can serve; if that outlasts the failure, the backlog can
  // never drain: the point of no return into a stuck state. (Not called a "tipping point": step 2
  // uses that for the traffic level at which runs start getting stuck.)
  for (const t of Object.values(run.tiers)) {
    const capacity = leafCapacityRps(config.tiers.find((c) => c.id === t.id)!);
    if (capacity === null) continue;
    const load = (s: number) => (admittedIn(t, s) * 1000) / run.bucketMs;
    let first = -1;
    let peak = 0;
    for (let s = startSecond; s < endSecond; s++) {
      if (t.arrivalsRetry[s] > 0 && load(s) > capacity && first < 0) first = s;
      if (first >= 0) peak = Math.max(peak, load(s) / capacity);
    }
    if (first < 0) continue;
    entries.push({ tMs: at(first), text: `Retries push ${name(t.id)} load past its capacity (peak ${peak.toFixed(1)}×)`, kind: 'info' });
    const afterFault = Math.ceil(recovery.lastFaultEndMs / run.bucketMs);
    let afterLoad = 0;
    for (let s = afterFault; s < endSecond; s++) afterLoad += load(s);
    afterLoad /= Math.max(1, endSecond - afterFault);
    if (recovery.verdict === 'stuck' && afterLoad > capacity) {
      entries.push({
        // Not before the load first went over (a failure in front of this tier, such as a slow
        // Gateway, can pass the pile on only once it ends).
        tMs: Math.max(recovery.lastFaultEndMs, at(first)),
        text: `Point of no return: the failure is over, but retries keep ${name(t.id)} load at ${(afterLoad / capacity).toFixed(1)}× its capacity, so the backlog can never drain`,
        kind: 'tip',
      });
    }
  }

  // Queued work takes longer to reach than the caller will wait: everything newly queued expires
  // before it is served, so the tier's work is wasted until the queue drains.
  for (let s = startSecond; s < endSecond; s++) {
    const hit = Object.values(run.tiers).find((t) => {
      const timeout = callerOf(config, t.id)?.timeoutMs ?? null;
      return timeout !== null && queuedWaitMs(run, t.id, s) > timeout;
    });
    if (hit) {
      const caller = callerOf(config, hit.id)!;
      entries.push({
        tMs: at(s),
        text: `${name(hit.id)} queue holds ${formatMs(queuedWaitMs(run, hit.id, s))} of work against the ${name(caller.id)}'s ${formatMs(caller.timeoutMs!)} timeout: new requests expire before they are served`,
        kind: 'info',
      });
      break;
    }
  }

  // Threads exhausted while CPU looks idle.
  for (let s = startSecond; s < endSecond; s++) {
    const hit = Object.values(run.tiers).find((t) => t.busyWorkersAvg[s] >= 0.99 * t.workers && t.busyCoresAvg[s] < 0.5 * t.cores);
    if (hit) {
      entries.push({ tMs: at(s), text: `${name(hit.id)} workers ${percent(hit.busyWorkersAvg[s] / hit.workers)} occupied, CPU ${percent(hit.busyCoresAvg[s] / hit.cores)}: waiting, not working`, kind: 'info' });
      break;
    }
  }

  // The cache stops helping: first second its hit rate is below half the pre-failure rate.
  // Lookups refused while the cache is down count as misses.
  if (signals.cacheHitDrop) {
    const t = run.tiers[signals.cacheHitDrop.tier];
    const { before } = signals.cacheHitDrop.value;
    for (let s = startSecond; s < endSecond; s++) {
      const rate = t.hits[s] / Math.max(1, t.arrivalsFirst[s] + t.arrivalsRetry[s]);
      if (rate < before / 2) {
        entries.push({ tMs: at(s), text: `${name(t.id)} hit rate falls to ${percent(rate)} (normally ${percent(before)})`, kind: 'info' });
        break;
      }
    }
  }

  // Messages pile up behind a queue. Its senders are answered as soon as a message is stored, so
  // users see nothing; the backlog and how late the work gets are the only signs.
  if (signals.queueBacklog) {
    const { tier, value } = signals.queueBacklog;
    const t = run.tiers[tier];
    const first = range(startSecond, endSecond).find((s) => t.backlogAvg[s] > t.consumers);
    if (first !== undefined) {
      const late = Math.max(0, ...range(startSecond, endSecond).map((s) => t.messageAgeP99Ms[s]).filter((x) => !Number.isNaN(x)));
      const lateText = late >= 1000 ? `, some delivered ${formatSeconds(late)} late` : '';
      entries.push({ tMs: at(first), text: `Messages pile up in ${name(tier)}: up to ${count(value.peak)} waiting${lateText}`, kind: 'bad' });
    }
    const dropped = range(startSecond, endSecond).find((s) => t.deadLettered[s] > 0);
    if (dropped !== undefined) {
      const n = value.deadLettered === 1 ? '1 message that' : `${count(value.deadLettered)} messages that`;
      entries.push({ tMs: at(dropped), text: `${name(tier)} drops ${n} still failed after retries (dead-lettered)`, kind: 'bad' });
    }
  }

  entries.push(verdictEntry(recovery, signals, name, run.durationMs));
  return entries.sort((x, y) => x.tMs - y.tMs).slice(0, MAX_ENTRIES);
}

const range = (from: number, to: number) => Array.from({ length: Math.max(0, to - from) }, (_, i) => from + i);
const count = (x: number) => Math.round(x).toLocaleString('en-US');

/**
 * Estimated wait for a newly queued attempt at a tier in second s (Little's law: queue ÷ throughput),
 * capped at the run's length when throughput has collapsed.
 */
export function queuedWaitMs(run: RunResult, tierId: string, s: number): number {
  const t = run.tiers[tierId];
  return Math.min(run.durationMs, (t.queueAvg[s] / Math.max(1, t.ok[s] + t.failed[s])) * run.bucketMs);
}

function describeFault(f: Fault, name: (id: string) => string): string {
  const who = f.instance === undefined ? name(f.tier) : `${name(f.tier)} instance ${f.instance + 1}`;
  return f.kind === 'slow' ? `${who} slows ${f.factor}×` : `${who} goes down`;
}

function describeFaultEnd(f: Fault, name: (id: string) => string): string {
  if (f.flushAtEnd) return `Failure ends; ${name(f.tier)} restarts empty`;
  return f.kind === 'slow' ? `Failure ends; ${name(f.tier)} back to normal speed` : `Failure ends; ${name(f.tier)} back up`;
}

function verdictEntry(r: RecoveryResult, signals: Signals, name: (id: string) => string, durationMs: number): TimelineEntry {
  const failureEndMs = Math.min(r.lastFaultEndMs, durationMs);
  switch (r.verdict) {
    case 'recovered':
      return { tMs: r.recoveredAtMs!, text: `Back to normal: recovered ${formatSeconds(r.recoveryMs!)} after the failure ended`, kind: 'good' };
    case 'unaffected':
      return { tMs: failureEndMs, text: 'Stayed within the normal range throughout', kind: 'good' };
    case 'overloaded':
      return { tMs: 0, text: 'Too much traffic for this system even without the failure', kind: 'bad' };
    case 'stuck': {
      if (r.lastFaultEndMs >= r.judgedUntilMs) {
        return { tMs: r.judgedUntilMs, text: 'The failure was still going on when the run ended, so there was no time to recover', kind: 'bad' };
      }
      const wasted = signals.wastedShare;
      const backlog = signals.queueBacklog;
      const detail =
        wasted && wasted.value >= 0.5
          ? `: ${percent(wasted.value)} of ${name(wasted.tier)} work is for requests already given up on`
          : backlog && backlog.value.atEnd >= 1
            ? `: ${count(backlog.value.atEnd)} messages still waiting in ${name(backlog.tier)}`
            : '';
      return { tMs: failureEndMs, endMs: r.judgedUntilMs, text: `Never returned to normal after the failure ended${detail}`, kind: 'bad' };
    }
  }
}
