/**
 * "Compared with your last run": what the viewer changed, and how the results moved. Pure
 * functions over two drafts and two analysed runs; the panel only displays what these return.
 */
import { leafCapacityRps, admittedIn } from '../analysis/helpers';
import type { Verdict } from '../analysis/recovery';
import { callsOf, shareFractions, type CallPolicy, type RunConfig, type TierConfig } from '../engine/config';
import type { RunResult } from '../engine/result';
import type { AnalyzeResult } from '../worker/jobs';
import { callKey, countsText, describeFault, retriesByCaller, retryCalls, type Draft } from './draft';
import { formatCount, formatSharePercent, roundedPercents } from './format';
import { bottleneckTier, shortVerdict, waitingTier } from './viewModels';

/** A finished run with the settings that produced it. */
export interface RunSnapshot {
  draft: Draft;
  config: RunConfig;
  result: AnalyzeResult;
}

export interface ComparisonRow {
  label: string;
  before: string;
  now: string;
  /** e.g. "+115%", "+37 pts", "same". */
  change: string;
  tone: 'better' | 'worse' | 'same';
  /** The raw values, for drawing (absent for the outcome, which has no scale). */
  values?: { before: number; now: number; /** top of the scale: 1 for shares */ max: number };
}

export interface Comparison {
  /** What the viewer changed, e.g. "API → DB retries 1 → 5". */
  changes: string[];
  rows: ComparisonRow[];
  /** One plain sentence on what the change did. */
  takeaway: string;
}

/** Relative changes smaller than this read as "same" (runs are noisy at the level of a few %). */
const SAME_SHARE = 0.03;
/** An internal change at least this big, with users' outcome unchanged, gets called out. */
const BIG_SHARE = 0.2;

export function compareRuns(prev: RunSnapshot, next: RunSnapshot, labels: Record<string, string>): Comparison {
  const name = (id: string) => labels[id] ?? id;
  const rows: ComparisonRow[] = [];
  const pv = prev.result.analysis.recovery;
  const nv = next.result.analysis.recovery;
  if (pv.verdict !== nv.verdict || pv.recoveryMs !== nv.recoveryMs) {
    const order = VERDICT_ORDER[nv.verdict] - VERDICT_ORDER[pv.verdict] || (nv.recoveryMs ?? 0) - (pv.recoveryMs ?? 0);
    rows.push({ label: 'Outcome', before: cap(shortVerdict(pv)), now: cap(shortVerdict(nv)), change: order === 0 ? 'same' : order < 0 ? 'better' : 'worse', tone: toneOf(order) });
  }
  rows.push(countRow('Failed requests', pv.failedRequests, nv.failedRequests));
  rows.push(countRow('Retries sent (all layers)', retriesSent(prev.result.run), retriesSent(next.result.run)));

  // The same parts are measured in both runs, chosen from the new one.
  const bottleneck = bottleneckTier(next.config, next.result.run);
  const peakPrev = peakLoad(prev.config, prev.result.run, bottleneck);
  const peakNext = peakLoad(next.config, next.result.run, bottleneck);
  if (peakPrev !== null && peakNext !== null) {
    rows.push(ratioRow(`${name(bottleneck)} peak load over the whole run`, peakPrev, peakNext, (v) => `${v.toFixed(1)}× capacity`));
  }
  // Workers: the tier whose workers changed most (the setting's effect inside the system); when
  // none moved, the tier where workers wait rather than work.
  const busy = (s: RunSnapshot, id: string) => busyAfterFailure(s.config, s.result.run, id);
  const shared = Object.keys(next.result.run.tiers).filter((id) => prev.result.run.tiers[id]);
  const moved = shared.reduce<{ id: string; diff: number } | null>((best, id) => {
    const diff = Math.abs(busy(next, id) - busy(prev, id));
    return best === null || diff > best.diff ? { id, diff } : best;
  }, null);
  const workersTier = moved && moved.diff >= 0.03 ? moved.id : waitingTier(next.result.run);
  if (prev.result.run.tiers[workersTier]) rows.push(shareRow(`${name(workersTier)} workers busy after the failure`, busy(prev, workersTier), busy(next, workersTier)));
  // Behind a queue, messages that keep failing are dropped: users never see it, but it is work lost.
  const dropped = (r: RunResult) => Object.values(r.tiers).reduce((n, t) => n + t.deadLettered.reduce((a, b) => a + b, 0), 0);
  const queued = (r: RunResult) => Object.values(r.tiers).some((t) => t.consumers > 0);
  if ((queued(prev.result.run) || queued(next.result.run)) && dropped(prev.result.run) + dropped(next.result.run) > 0) {
    rows.push(countRow('Messages dropped behind the queue', dropped(prev.result.run), dropped(next.result.run)));
  }
  const changes = settingsChanges(prev.draft, next.draft);
  return { changes, rows, takeaway: retryTakeaway(prev.draft, next.draft, changes, pv.verdict, nv.verdict, rows) ?? takeaway(pv.verdict, nv.verdict, rows) };
}

/**
 * The takeaway after changing only how many times layers retry, told as cause and effect from
 * the two runs (REVIEW2 3.4), e.g. "Users retried less, so more failures reached them directly. It
 * was still stuck because the load balancer (3×) and the App server (1×) still multiply the load." Null
 * when something else changed too, or when there is no clear story (then `takeaway` speaks).
 */
export function retryTakeaway(prev: Draft, next: Draft, changes: string[], before: Verdict, now: Verdict, rows: ComparisonRow[]): string | null {
  if (changes.length === 0 || !changes.every((c) => /retries \d+ → \d+$/.test(c))) return null;
  const label = (id: string) => next.topology.layout[id]?.label ?? id;
  const was = new Map(retryCalls(prev.topology).map((c) => [callKey(c), c.retries]));
  const calls = retryCalls(next.topology);
  const callers = (keep: (before: number, now: number) => boolean) => [...new Set(calls.filter((c) => keep(was.get(callKey(c)) ?? c.retries, c.retries)).map((c) => c.caller))];
  const fewer = callers((before, now) => before > now);
  const more = callers((before, now) => before < now);
  if (fewer.length > 0 && more.length > 0) return null;
  const users = (ids: string[]) => ids.length === 1 && ids[0] === 'client';
  const names = (ids: string[]) => listed(ids.map((id) => (id === 'client' ? "users' apps" : `the ${label(id)}`)));
  const who = (ids: string[]) => cap(names(ids));
  const still = retriesByCaller(calls.filter((c) => c.retries > 0)).map((g) => `${g.caller === 'client' ? "users' apps" : `the ${label(g.caller)}`} (${countsText(g.counts)})`);
  const multiply = still.length === 0 ? '' : ` because ${listed(still)} still ${still.length === 1 && !still[0].startsWith("users'") ? 'multiplies' : 'multiply'} the load`;
  const order = VERDICT_ORDER[now] - VERDICT_ORDER[before];
  const failed = rows.find((r) => r.label === 'Failed requests')!.tone;
  if (order < 0) return fewer.length > 0 ? `With fewer repeats from ${names(fewer)}, the load fell enough for the system to recover.` : null;
  if (order > 0) return more.length > 0 ? `${who(more)} retried more, and the extra repeats kept the system from recovering.` : null;
  const stuck = now === 'stuck' || now === 'overloaded';
  if (fewer.length > 0) {
    const first = users(fewer)
      ? failed === 'worse' ? 'Users retried less, so more failures reached them directly' : failed === 'better' ? 'Users retried less, so fewer repeats piled up and fewer requests failed' : 'Users retried less'
      : `${who(fewer)} retried less${failed === 'worse' ? ', so more failures reached users directly' : failed === 'better' ? ', so fewer repeats piled up and fewer requests failed' : ''}`;
    return stuck ? `${first}. It was still stuck${multiply}.` : `${first}. It recovered either way.`;
  }
  if (more.length > 0) {
    const first = `${users(more) ? 'Users' : who(more)} retried more, adding repeats${failed === 'worse' ? ', and more requests failed' : failed === 'better' ? ', yet fewer requests failed' : ''}`;
    return stuck ? `${first}. It was stuck either way${multiply.replace(' still ', ' ')}.` : `${first}. It recovered either way.`;
  }
  return null;
}

/** "a", "a and b", "a, b and c". */
const listed = (items: string[]) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

const VERDICT_ORDER: Record<Verdict, number> = { unaffected: 0, recovered: 1, stuck: 2, overloaded: 3 };

/** Lower is better for every measured row: fewer failures, fewer retries, less load, fewer stuck workers. */
const toneOf = (delta: number): ComparisonRow['tone'] => (delta === 0 ? 'same' : delta < 0 ? 'better' : 'worse');

function relative(before: number, now: number): number {
  if (before === now) return 0;
  return before === 0 ? 1 : (now - before) / before;
}

function countRow(label: string, before: number, now: number): ComparisonRow {
  const r = relative(before, now);
  const same = Math.abs(r) < SAME_SHARE;
  return { label, before: formatCount(before), now: formatCount(now), change: same ? 'same' : percent(r), tone: same ? 'same' : toneOf(r), values: { before, now, max: Math.max(before, now) } };
}

function ratioRow(label: string, before: number, now: number, fmt: (v: number) => string): ComparisonRow {
  const r = relative(before, now);
  const same = Math.abs(r) < SAME_SHARE;
  return { label, before: fmt(before), now: fmt(now), change: same ? 'same' : percent(r), tone: same ? 'same' : toneOf(r), values: { before, now, max: Math.max(before, now) } };
}

/** Shares (0..1) change by percentage points. */
function shareRow(label: string, before: number, now: number): ComparisonRow {
  const pts = Math.round(100 * now) - Math.round(100 * before);
  const same = Math.abs(pts) < 3;
  return {
    label,
    before: `${Math.round(100 * before)}%`,
    now: `${Math.round(100 * now)}%`,
    change: same ? 'same' : `${pts > 0 ? '+' : ''}${pts} pts`,
    tone: same ? 'same' : toneOf(pts),
    values: { before, now, max: 1 },
  };
}

const percent = (r: number) => `${r > 0 ? '+' : ''}${Math.round(100 * r)}%`;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Every retry any layer sent (each arrives at the next tier down as a retried attempt). */
export function retriesSent(run: RunResult): number {
  return Object.values(run.tiers).reduce((n, t) => n + t.arrivalsRetry.reduce((a, b) => a + b, 0), 0);
}

/** Highest per-second load a leaf tier took on (turned-away requests excluded), as a multiple of its normal capacity; null for a tier without one. */
export function peakLoad(config: RunConfig, run: RunResult, tierId: string): number | null {
  const tier = config.tiers.find((t) => t.id === tierId);
  const capacity = tier ? leafCapacityRps(tier) : null;
  const t = run.tiers[tierId];
  if (!capacity || !t) return null;
  const perSecond = 1000 / run.bucketMs;
  return t.arrivalsFirst.reduce((m, _, i) => Math.max(m, (admittedIn(t, i) * perSecond) / capacity), 0);
}

/** A tier's average share of busy workers from the end of the last failure to the end of the run. */
export function busyAfterFailure(config: RunConfig, run: RunResult, tierId: string): number {
  const t = run.tiers[tierId];
  const endMs = Math.max(0, ...(config.faults ?? []).map((f) => f.endMs));
  const from = Math.min(t.busyWorkersAvg.length - 1, Math.floor(endMs / run.bucketMs));
  const tail = t.busyWorkersAvg.slice(from);
  return tail.reduce((a, b) => a + b, 0) / Math.max(1, tail.length) / t.workers;
}

function takeaway(before: Verdict, now: Verdict, rows: ComparisonRow[]): string {
  const order = VERDICT_ORDER[now] - VERDICT_ORDER[before];
  if (order < 0) return 'This change made the system recover.';
  if (order > 0) return 'This change stopped the system from recovering.';
  const failed = rows.find((r) => r.label === 'Failed requests')!;
  const inside = rows.filter((r) => r.label !== 'Failed requests' && r.label !== 'Outcome');
  // "+115%" or "+37 pts": either way the number is in percent (points), compared with BIG_SHARE.
  const bigInside = inside.some((r) => r.tone !== 'same' && Math.abs(parseInt(r.change, 10)) >= 100 * BIG_SHARE);
  const either = now === 'stuck' || now === 'overloaded' ? 'it was stuck either way' : 'it recovered either way';
  if (failed.tone === 'same' && bigInside) return `A lot changed inside the system, but users see about the same: ${either}.`;
  if (failed.tone === 'same' && rows.every((r) => r.tone === 'same')) return 'Little changed: in this situation, this setting barely matters.';
  if (failed.tone === 'same') return `Users see about the same: ${either}.`;
  return failed.tone === 'better' ? 'Fewer requests failed for users.' : 'More requests failed for users.';
}

/** Tier settings the viewer can edit, in plain words, for listing what changed. */
const TIER_FIELDS: Array<[string, (t: TierConfig) => string | number | undefined]> = [
  ['copies', (t) => t.instances],
  ['workers per server', (t) => t.workersPerInstance],
  ['cores per server', (t) => t.coresPerInstance],
  ['queue limit', (t) => (t.queueLimit === null ? 'none' : t.queueLimit)],
  ['typical service time', (t) => (t.service.kind === 'lognormal' ? `${t.service.medianMs} ms` : undefined)],
  ['slowest 1% service time', (t) => (t.service.kind === 'lognormal' ? `${t.service.p99Ms} ms` : undefined)],
  ['skips abandoned work', (t) => (t.dropExpired ? 'on' : 'off')],
  ['size', (t) => t.cache?.capacity],
  ['entry lifetime', (t) => (t.cache?.ttlMs == null ? undefined : `${t.cache.ttlMs / 1000} s`)],
  ['distinct keys', (t) => t.cache?.keys],
  ['popularity skew', (t) => t.cache?.skew],
];

/** The tier field its calls' changes are listed just before. */
const CALLS_BEFORE = 'skips abandoned work';

/** Settings of each call a tier makes (every one of them, `callsOf`), in plain words. */
const CALL_FIELDS: Array<[string, (c: CallPolicy, t: TierConfig) => string | undefined]> = [
  ['timeout', (c) => (c.timeoutMs == null ? undefined : `${c.timeoutMs} ms`)],
  ['retry wait', (c) => `${c.backoffBaseMs} ms`],
  ['random retry delays', (c) => (c.jitter ? 'on' : 'off')],
  ['share of traffic', (c, t) => (t.fanOut === 'split' && callsOf(t).length > 1 ? formatSharePercent(shareFractions(callsOf(t).map((x) => x.share))[callsOf(t).indexOf(c)], roundedPercents(shareFractions(callsOf(t).map((x) => x.share)))[callsOf(t).indexOf(c)]) : undefined)],
];

/** What differs between two drafts, in plain words: traffic, failures, retries, then other settings. */
export function settingsChanges(prev: Draft, next: Draft): string[] {
  const label = (id: string) => next.topology.layout[id]?.label ?? prev.topology.layout[id]?.label ?? id;
  const out: string[] = [];
  const a = prev.scenario;
  const b = next.scenario;
  if (a.rps !== b.rps) out.push(`Traffic ${a.rps} → ${b.rps} req/s`);
  if (a.durationMs !== b.durationMs) out.push(`Run length ${a.durationMs / 1000} → ${b.durationMs / 1000} s`);
  const faultText = (d: Draft, i: number) => {
    const f = d.scenario.faults[i];
    const instances = d.topology.tiers.find((t) => t.id === f.tier)?.instances ?? 1;
    return `${label(f.tier)} ${describeFault(f, instances)} for ${(f.endMs - f.startMs) / 1000} s at ${f.startMs / 1000} s`;
  };
  for (let i = 0; i < Math.max(a.faults.length, b.faults.length); i++) {
    if (i >= a.faults.length) out.push(`Added: ${faultText(next, i)}`);
    else if (i >= b.faults.length) out.push(`Removed: ${faultText(prev, i)}`);
    else if (JSON.stringify(a.faults[i]) !== JSON.stringify(b.faults[i])) out.push(`${faultText(prev, i)} → ${faultText(next, i).replace(`${label(b.faults[i].tier)} `, '')}`);
  }
  const before = new Map(retryCalls(prev.topology).map((c) => [callKey(c), c.retries]));
  for (const c of retryCalls(next.topology)) {
    const was = before.get(callKey(c));
    if (was !== undefined && was !== c.retries) out.push(`${label(c.caller)} → ${label(c.target)} retries ${was} → ${c.retries}`);
  }
  if (prev.topology.clientCall.timeoutMs !== next.topology.clientCall.timeoutMs) {
    out.push(`Users' timeout ${prev.topology.clientCall.timeoutMs} → ${next.topology.clientCall.timeoutMs} ms`);
  }
  for (const t of next.topology.tiers) {
    const old = prev.topology.tiers.find((x) => x.id === t.id);
    if (!old) continue;
    // Each call, matched by its target; "API timeout …" for a single call, "API → DB 2 timeout …" when it makes several.
    const calls = callsOf(t);
    const callChanges: string[] = [];
    for (const c of calls) {
      const was = callsOf(old).find((x) => x.target === c.target);
      if (!was) continue;
      const who = calls.length > 1 ? `${label(t.id)} → ${label(c.target)}` : label(t.id);
      for (const [field, get] of CALL_FIELDS) {
        const [x, y] = [get(was, old), get(c, t)];
        if (x !== y && y !== undefined) callChanges.push(`${who} ${field} ${x} → ${y}`);
      }
    }
    if (calls.length > 1 && t.fanOut !== old.fanOut && t.fanOut !== 'split' && old.fanOut !== 'split') {
      callChanges.push(`${label(t.id)} calls its parts ${t.fanOut === 'parallel' ? 'all at once' : 'one after another'}`);
    }
    // The tier's own settings, with its calls' listed where the timeout used to be (after the service times).
    for (const [field, get] of TIER_FIELDS) {
      if (field === CALLS_BEFORE) out.push(...callChanges.splice(0));
      const [x, y] = [get(old), get(t)];
      if (x !== y && y !== undefined) out.push(`${label(t.id)} ${field} ${x} → ${y}`);
    }
    out.push(...callChanges);
  }
  return out;
}
