/**
 * Pure mappers from engine/analysis output to the presentational components' view models.
 * Nothing here simulates or decides anything; it only selects and formats.
 */
import type { Analysis } from '../analysis/analyze';
import { admittedIn, formatMs, leafCapacityRps, strictestCallerInto, trafficShares } from '../analysis/helpers';
import type { RecoveryResult } from '../analysis/recovery';
import { callsOf, type CallPolicy, type RunConfig, type TierConfig } from '../engine/config';
import { placeCalls, trunkSides } from './edgeRoutes';
import type { RunResult, TierSeries } from '../engine/result';
import type { Axis, TopologyPreset } from '../data/types';
import type { CellSummary } from '../worker/jobs';
import type { ChartSpec, MapCellView, MapView, TimelineEntryView, TimeSeries, TopologyEdgeView, TopologyNodeView } from './components/types';

export const COLORS = { primary: '#1F6FEB', secondary: '#8250DF', reference: '#8C939D', before: '#6E7781', bad: '#E8590C' };

export type MetricTab = 'throughput' | 'load' | 'latency' | 'errors' | 'workers';
export const METRIC_TABS: Array<{ id: MetricTab; label: string }> = [
  { id: 'throughput', label: 'Throughput' },
  { id: 'load', label: 'Load & retries' },
  { id: 'latency', label: 'Latency' },
  { id: 'errors', label: 'Errors' },
  { id: 'workers', label: 'Workers & CPU' },
];

export function labelsOf(topology: TopologyPreset): Record<string, string> {
  return Object.fromEntries(Object.entries(topology.layout).map(([id, l]) => [id, l.label]));
}

const pct = (x: number) => `${Math.round(Number.isFinite(x) ? x * 100 : 0)}%`;
const perSecond = (run: RunResult, count: number) => (count * 1000) / run.bucketMs;
const bucketAt = (run: RunResult, tMs: number) => Math.min(run.client.sent.length - 1, Math.max(0, Math.floor(tMs / run.bucketMs)));
const tierConfig = (config: RunConfig, id: string) => config.tiers.find((t) => t.id === id)!;
const responses = (t: TierSeries, b: number) => t.ok[b] + t.failed[b] + t.rejected[b] + t.dropped[b];
const errorShare = (t: TierSeries, b: number) => (t.failed[b] + t.rejected[b] + t.dropped[b]) / Math.max(1, responses(t, b));
const arrivals = (t: TierSeries, b: number) => t.arrivalsFirst[b] + t.arrivalsRetry[b];

/**
 * A tier's load per second for the Load chart: what it took on (admitted), split into users' own
 * first tries and repeats (retries here plus first tries made for a repeat further up, so the
 * cascade from several layers shows as repeats), and what it turned away at once.
 * ASSUMPTION: refusals are spread over new requests and repeats in proportion to their arrivals.
 */
export function loadSplit(run: RunResult, id: string): { fresh: number[]; repeats: number[]; admitted: number[]; turnedAway: number[] } {
  const t = run.tiers[id];
  const fresh: number[] = [];
  const repeats: number[] = [];
  const admitted: number[] = [];
  const turnedAway: number[] = [];
  t.arrivalsFirst.forEach((first, b) => {
    const total = first + t.arrivalsRetry[b];
    const kept = total > 0 ? admittedIn(t, b) / total : 0;
    const rep = t.arrivalsRetry[b] + (t.arrivalsFromRepeats?.[b] ?? 0);
    fresh.push(perSecond(run, (total - rep) * kept));
    repeats.push(perSecond(run, rep * kept));
    admitted.push(perSecond(run, admittedIn(t, b)));
    turnedAway.push(perSecond(run, t.rejected[b]));
  });
  return { fresh, repeats, admitted, turnedAway };
}

// Display heuristics for colouring the diagram (they do not feed any verdict):
// a tier is "bad" when its workers are saturated, more than 5% of its responses fail, a leaf's CPU
// is saturated, or its p99 exceeds its caller's timeout. The client is "bad" above 10% of requests not answered.
const BAD_ERROR_SHARE = 0.05;
const BAD_CLIENT_UNANSWERED = 0.1;

/**
 * Share of the requests users sent around second b that were not answered successfully: 1 − ok ÷
 * sent over the 3 seconds ending at b (0 when nothing was sent).
 * Why not failed ÷ (ok + failed)? A request only "fails" when the user's last retry gives up, ~21 s
 * after it was sent, so during an outage nothing finishes and that reads 0% (review 2: "0% errors"
 * at 45 s with 203 requests a second sent and none answered). What users see at time t is whether
 * their requests are being answered now.
 * ASSUMPTION: 3 s smooths the per-second boundary noise (up to 5% at 60 req/s with one-second
 * buckets; under 2% with three) without hiding a real drop.
 */
export function unansweredShare(c: RunResult['client'], b: number): number {
  let sent = 0;
  let ok = 0;
  for (let i = Math.max(0, b - 2); i <= b; i++) (sent += c.sent[i] ?? 0), (ok += c.ok[i] ?? 0);
  return sent > 0 ? Math.min(1, Math.max(0, 1 - ok / sent)) : 0;
}

/** A setting a fix changed, as listed by fixes/changes.ts (a tier's own setting, or a call's). */
export interface ChangeLabel {
  tier?: string;
  call?: { from: string; to: string };
  text: string;
}

/** The injected failure on `tierId` at `tMs`, as a badge (e.g. "⚡ 8× slower"), or undefined. */
export function activeFault(config: RunConfig, tierId: string, tMs: number): string | undefined {
  const f = (config.faults ?? []).find((x) => x.tier === tierId && tMs >= x.startMs && tMs < x.endMs);
  if (!f) return undefined;
  return f.kind === 'slow' ? `⚡ ${f.factor}× slower` : '⚡ down';
}

/**
 * The topology diagram at time `tMs`: per-tier stats and per-call arrows. `changes` (compare mode,
 * "after" side) labels what the applied fix changed on each tier or call.
 */
export function topologyView(
  topology: TopologyPreset,
  config: RunConfig,
  run: RunResult,
  tMs: number,
  changes: ChangeLabel[] = [],
): { nodes: TopologyNodeView[]; edges: TopologyEdgeView[] } {
  const b = bucketAt(run, tMs);
  const c = run.client;
  const clientErrors = unansweredShare(c, b);
  const nodes: TopologyNodeView[] = [];
  const clientLayout = topology.layout.client;
  if (clientLayout) {
    nodes.push({
      id: 'client',
      label: clientLayout.label,
      col: clientLayout.col,
      row: clientLayout.row,
      instanceCountLabel: '',
      instanceBusy: [],
      lines: [`${Math.round(perSecond(run, c.sent[b]))} rps sent`, `${pct(clientErrors)} not answered`],
      health: clientErrors > BAD_CLIENT_UNANSWERED ? 'bad' : 'ok',
      errorShare: clientErrors,
      rps: perSecond(run, c.sent[b]),
    });
  }
  for (const tc of config.tiers) {
    const layout = topology.layout[tc.id];
    if (!layout) continue;
    const t = run.tiers[tc.id];
    const busy = t.busyWorkersAvg[b] / t.workers;
    const cpu = t.busyCoresAvg[b] / t.cores;
    const leaf = leafCapacityRps(tc) !== null;
    // With several callers (a shared database), the least patient one: it gives up first.
    const timeout = strictestCallerInto(config, tc.id)?.policy.timeoutMs ?? null;
    let lines: [string, string];
    // A queue: messages waiting, and how busy its consumers are (its workers only store messages).
    const consumersBusy = tc.queue ? t.busyConsumersAvg[b] / tc.queue.consumers : 0;
    if (tc.queue) lines = [`${Math.round(t.backlogAvg[b]).toLocaleString('en-US')} waiting`, `consumers ${pct(consumersBusy)}`];
    else if (tc.cache) lines = [`hit rate ${pct(t.hits[b] / Math.max(1, t.ok[b]))}`, `p99 ${Number.isNaN(t.latencyP99Ms[b]) ? '—' : formatMs(t.latencyP99Ms[b])}`];
    else if (leaf) lines = [`${Math.round(perSecond(run, arrivals(t, b)))} rps in`, `CPU ${pct(cpu)}`];
    else lines = [`workers ${pct(busy)}`, `CPU ${pct(cpu)}`];
    // Overloaded: all workers (or a leaf's cores) busy, or answers slower than the caller waits.
    // A queue is overloaded while more messages wait than its consumers can hold at once.
    const overloaded = tc.queue ? t.backlogAvg[b] > tc.queue.consumers : busy >= 0.99 || (leaf && cpu >= 0.99) || (timeout !== null && t.latencyP99Ms[b] > timeout);
    const bad = overloaded || errorShare(t, b) > BAD_ERROR_SHARE;
    const change = changes.filter((x) => x.tier === tc.id).map((x) => x.text).join(', ');
    nodes.push({
      id: tc.id,
      label: layout.label,
      col: layout.col,
      row: layout.row,
      instanceCountLabel: tc.queue ? `${tc.queue.consumers} consumers` : `${tc.instances} instance${tc.instances === 1 ? '' : 's'}`,
      // ASSUMPTION: metrics are per tier, so every instance is drawn at the tier's average busyness.
      instanceBusy: new Array<number>(tc.instances).fill(tc.queue ? consumersBusy : busy),
      lines,
      health: bad ? 'bad' : 'ok',
      errorShare: errorShare(t, b),
      rps: perSecond(run, arrivals(t, b)),
      busy,
      fault: activeFault(config, tc.id, tMs),
      overloaded,
      change: change || undefined,
    });
  }
  const edges = edgesAt(topology, config, run, b).map((e) => {
    const change = changes.filter((x) => x.call && e.id === `${x.call.from}-${x.call.to}`).map((x) => x.text).join(', ');
    return change ? { ...e, change } : e;
  });
  return { nodes, edges };
}

/**
 * How much of a tier's arrivals in bucket b came along each call into it: by each caller's own
 * arrivals that second (the client: requests sent), times the part of them it sends this way (a
 * splitting load balancer's share; a cache-aside server only on misses).
 * ASSUMPTION: the engine counts arrivals per tier, not per call, so a part called by several (a
 * shared database) has its arrivals divided between its arrows this way. One caller (every preset,
 * every chain) gets them all, exactly as before. Retries and failures are shown at the callee's
 * rate on each of its arrows. When nothing arrived anywhere, the split follows the traffic shares.
 */
export function callWeights(config: RunConfig, run: RunResult, b: number, calls: Array<{ from: string; to: string; cache: boolean }>): number[] {
  const byId = new Map(config.tiers.map((t) => [t.id, t]));
  const shares = trafficShares(config);
  const part = (from: string, to: string, cache: boolean): number => {
    if (from === 'client') return 1;
    const t = byId.get(from)!;
    if (cache) return 1;
    const list = callsOf(t);
    let fraction = 1;
    if (t.fanOut === 'split' && list.length > 1) {
      const w = (c: CallPolicy) => (c.share !== undefined && Number.isFinite(c.share) && c.share >= 0 ? c.share : 1);
      const total = list.reduce((a, c) => a + w(c), 0);
      const mine = list.find((c) => c.target === to);
      fraction = mine && total > 0 ? w(mine) / total : 1 / list.length;
    }
    if (t.cacheAside && run.tiers[t.cacheAside.target]) {
      const c = run.tiers[t.cacheAside.target];
      fraction *= c.ok[b] > 0 ? 1 - c.hits[b] / c.ok[b] : 1;
    }
    return fraction;
  };
  const live = calls.map((c) => (c.from === 'client' ? run.client.sent[b] : run.tiers[c.from] ? arrivals(run.tiers[c.from], b) : 0) * part(c.from, c.to, c.cache));
  const stat = calls.map((c) => (c.from === 'client' ? 1 : shares[c.from] ?? 0) * part(c.from, c.to, c.cache));
  return calls.map((c, i) => {
    const same = calls.map((d, j) => (d.to === c.to ? j : -1)).filter((j) => j >= 0);
    if (same.length === 1) return 1;
    for (const w of [live, stat]) {
      const total = same.reduce((a, j) => a + w[j], 0);
      if (total > 0) return w[i] / total;
    }
    return 1 / same.length;
  });
}

function edgesAt(topology: TopologyPreset, config: RunConfig, run: RunResult, b: number): TopologyEdgeView[] {
  const calls: Array<{ from: string; to: string; cache: boolean }> = [{ from: 'client', to: config.client.call.target, cache: false }];
  for (const t of config.tiers) {
    if (t.cacheAside) calls.push({ from: t.id, to: t.cacheAside.target, cache: true });
    for (const c of callsOf(t)) calls.push({ from: t.id, to: c.target, cache: false });
  }
  const places = placeCalls(topology.layout, calls);
  const clear = trunkSides(calls, places);
  const weights = callWeights(config, run, b, calls);
  const edges: TopologyEdgeView[] = [];
  calls.forEach((call, i) => {
    const place = places[i];
    if (!place) return;
    const target = run.tiers[call.to];
    const total = arrivals(target, b) * weights[i];
    const retries = target.arrivalsRetry[b] * weights[i];
    const rps = perSecond(run, total);
    const where = {
      ...place,
      from: call.from,
      to: call.to,
      ...(clear[i].clearStart ? { clearStart: true } : {}),
      ...(clear[i].clearEnd ? { clearEnd: true } : {}),
    };
    if (call.cache) {
      edges.push({ id: `${call.from}-${call.to}`, ...where, label: `${Math.round(rps)} lookups/s`, detail: `${pct(target.hits[b] / Math.max(1, target.ok[b]))} hits`, rps, health: 'ok', retryShare: 0, errorShare: errorShare(target, b), cache: true });
    } else {
      const failing = errorShare(target, b) > BAD_ERROR_SHARE;
      const detail = retries > 0 ? `incl. ${Math.round(perSecond(run, retries))} retries` : failing ? `${pct(errorShare(target, b))} fail` : 'no retries';
      edges.push({
        id: `${call.from}-${call.to}`,
        ...where,
        label: `${Math.round(rps)} rps`,
        detail,
        rps,
        health: retries / Math.max(1, total) > 0.5 || failing ? 'bad' : 'ok',
        retryShare: retries / Math.max(1, total),
        errorShare: errorShare(target, b),
      });
    }
  });
  return edges;
}

/** Leaf tier that was pushed hardest relative to its capacity: the natural default for "Load & retries". */
export function bottleneckTier(config: RunConfig, run: RunResult): string {
  let best = config.tiers[config.tiers.length - 1].id;
  let bestRatio = -1;
  for (const tc of config.tiers) {
    const capacity = leafCapacityRps(tc);
    if (capacity === null) continue;
    const t = run.tiers[tc.id];
    const peak = Math.max(...t.arrivalsFirst.map((_, b) => perSecond(run, admittedIn(t, b)))) / capacity;
    if (peak > bestRatio) {
      bestRatio = peak;
      best = tc.id;
    }
  }
  return best;
}

/** Tier whose workers were busiest on average. */
export function busiestTier(run: RunResult): string {
  const mean = (t: TierSeries) => t.busyWorkersAvg.reduce((a, v) => a + v, 0) / t.busyWorkersAvg.length / t.workers;
  return Object.values(run.tiers).reduce((a, t) => (mean(t) > mean(a) ? t : a)).id;
}

/**
 * Tier whose workers spent the most time occupied but not computing (workers busy minus CPU busy,
 * averaged over the run): where "waiting, not working" shows. The default for "Workers & CPU".
 */
export function waitingTier(run: RunResult): string {
  const mean = (xs: number[]) => xs.reduce((a, v) => a + v, 0) / Math.max(1, xs.length);
  const gap = (t: TierSeries) => mean(t.busyWorkersAvg) / t.workers - mean(t.busyCoresAvg) / t.cores;
  return Object.values(run.tiers).reduce((a, t) => (gap(t) > gap(a) ? t : a)).id;
}

/**
 * How long users waited for an answer, success or error, per second of arrival: the slowest 1% (p99)
 * and the typical (median) request. Unlike the success-only latency, this rises when requests fail
 * by timing out, instead of looking fast because only a few quick requests got through.
 * NaN for seconds where no request finished.
 */
export function answerTimes(run: RunResult): { p50: number[]; p99: number[] } {
  const { arrivalMs, latencyMs } = run.client.requests;
  const buckets: number[][] = run.client.sent.map(() => []);
  for (let i = 0; i < arrivalMs.length; i++) {
    if (!Number.isNaN(latencyMs[i])) buckets[Math.min(buckets.length - 1, Math.floor(arrivalMs[i] / run.bucketMs))]?.push(latencyMs[i]);
  }
  const quantile = (sorted: number[], q: number) => (sorted.length === 0 ? NaN : sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]);
  const sorted = buckets.map((b) => b.sort((x, y) => x - y));
  return { p50: sorted.map((b) => quantile(b, 0.5)), p99: sorted.map((b) => quantile(b, 0.99)) };
}

export interface ChartView {
  spec: ChartSpec;
  /** What the chart shows, e.g. "DB" or "end to end, as users see it". */
  scopeLabel: string;
  /** Name for the default ("client") scope option: the tier it really shows on tabs that can't be end to end. */
  defaultScopeLabel: string;
  /** The tier the default scope shows (null when it is end to end), so a scope picker can leave it out of the tier list. */
  defaultScopeId: string | null;
  /** A plain sentence explaining what the chart shows, under its legend (e.g. why end-to-end waits are long). */
  note?: string;
}

/**
 * The chart for a metric tab. `scope` is the selected tier (null or 'client' = the tab's default:
 * end to end where that makes sense, otherwise the most telling tier).
 * With `after`, shows the primary series before (grey) and after (blue) a fix; "Load & retries"
 * instead keeps the first-attempts vs retries split of the run being shown (`shownAfter`), with the
 * other run's total as a dashed line, because that split is what the fix changes.
 */
export function chartView(
  tab: MetricTab,
  config: RunConfig,
  run: RunResult,
  labels: Record<string, string>,
  scope: string | null,
  after?: RunResult,
  playheadS?: number,
  shownAfter = true,
): ChartView {
  const xsSeconds = run.client.sent.map((_, i) => (i * run.bucketMs) / 1000);
  const failureWindows = (config.faults ?? []).map((f) => [f.startMs / 1000, f.endMs / 1000] as [number, number]);
  const tierScope = scope && scope !== 'client' ? scope : null;
  let yMax: number | undefined;
  const name = (id: string) => labels[id] ?? id;
  const ref = (label: string, values: number[]): TimeSeries => ({ label, values, color: COLORS.reference, dashed: true });
  const flat = (v: number) => xsSeconds.map(() => v);
  const pair = (label: string, of: (r: RunResult) => number[]): TimeSeries[] =>
    after
      ? [{ label: `${label} before`, values: of(run), color: COLORS.before }, { label: `${label} after`, values: of(after), color: COLORS.primary }]
      : [{ label, values: of(run), color: COLORS.primary }];
  const rate = (xs: number[]) => xs.map((x) => perSecond(run, x));
  let series: TimeSeries[];
  let unit: string;
  let scopeLabel: string;
  let defaultScopeLabel = 'End to end (users)';
  let defaultScopeId: string | null = null;
  /** A sentence under the legend where the chart needs explaining (see ChartView.note). */
  let note: string | undefined;

  switch (tab) {
    case 'throughput':
      unit = 'rps';
      scopeLabel = 'end to end, as users see it';
      series = [...pair('Succeeded', (r) => rate(r.client.ok)), ref('User traffic (sent)', rate(run.client.sent))];
      break;
    case 'load': {
      const bottleneck = bottleneckTier(config, run);
      const id = tierScope ?? bottleneck;
      unit = 'rps';
      scopeLabel = name(id);
      defaultScopeLabel = `${name(bottleneck)} (most overloaded)`;
      defaultScopeId = bottleneck;
      const capacity = leafCapacityRps(tierConfig(config, id));
      const load = loadSplit(after && shownAfter ? after : run, id);
      const other = after ? (shownAfter ? run : after) : null;
      series = [
        { label: "Users' new requests", values: load.fresh, color: COLORS.primary, area: true },
        { label: 'Repeats (from any layer)', values: load.repeats, color: COLORS.bad, area: true },
      ];
      if (other) series.push({ label: shownAfter ? 'Total before the fix' : 'Total after the fix', values: loadSplit(other, id).admitted, color: COLORS.before, dashed: true });
      if (capacity !== null) series.push(ref(`${name(id)} capacity`, flat(capacity)));
      // Requests turned away at once (a full queue) are drawn apart, and clipped so a burst of cheap
      // refusals doesn't flatten the work actually done (review 2: a 2,000/s spike of refusals made
      // the recommended fix look like a 5× overload).
      if (load.turnedAway.some((v) => v > 0)) {
        const top = Math.max(capacity ?? 0, ...load.admitted, ...(other ? loadSplit(other, id).admitted : [])) * 1.3;
        const clipped = load.turnedAway.some((v) => v > top);
        series.push({ label: clipped ? 'Turned away (clipped at the top)' : 'Turned away', values: load.turnedAway.map((v) => Math.min(v, top)), color: COLORS.before, dashed: true });
        if (clipped) yMax = top;
      }
      break;
    }
    case 'latency': {
      unit = 'ms';
      if (tierScope) {
        // A tier's own response times (of the requests it completed).
        const p = (r: RunResult, q: 'latencyP99Ms' | 'latencyP50Ms') => r.tiers[tierScope][q];
        scopeLabel = name(tierScope);
        series = after
          ? pair('Slowest 1% (p99)', (r) => p(r, 'latencyP99Ms'))
          : [{ label: 'Slowest 1% (p99)', values: p(run, 'latencyP99Ms'), color: COLORS.primary }, { label: 'Typical (median)', values: p(run, 'latencyP50Ms'), color: COLORS.secondary }];
      } else {
        scopeLabel = 'end to end: time until users got an answer, errors included';
        series = after
          ? pair('Slowest 1% wait', (r) => answerTimes(r).p99)
          : [
              { label: 'Slowest 1% wait (p99)', values: answerTimes(run).p99, color: COLORS.primary },
              { label: 'Typical wait (median)', values: answerTimes(run).p50, color: COLORS.secondary },
            ];
      }
      // With several callers (a shared database), the least patient one: the first to give up.
      const strictest = tierScope ? strictestCallerInto(config, tierScope) : null;
      const caller = tierScope ? strictest?.policy : config.client.call;
      if (caller && caller.timeoutMs !== null) {
        // End to end, the wait spans every try, so the user's timeout applies to each try, not to the whole wait.
        const label = tierScope ? `${name(strictest!.from)} gives up after ${formatMs(caller.timeoutMs)}` : `Users' apps give up on one try after ${formatMs(caller.timeoutMs)}`;
        series.push(ref(label, flat(caller.timeoutMs)));
      }
      if (!tierScope) {
        note = 'The wait includes every retry until the final answer or error. Lines stop where requests had not finished when the run ended.';
      }
      break;
    }
    case 'errors': {
      unit = '%';
      scopeLabel = tierScope ? name(tierScope) : 'end to end';
      const errors = (r: RunResult) =>
        tierScope ? r.tiers[tierScope].ok.map((_, b) => 100 * errorShare(r.tiers[tierScope], b)) : r.client.sent.map((_, b) => 100 * unansweredShare(r.client, b));
      // End to end: what users see now (see unansweredShare); a tier: its responses that failed.
      series = pair(tierScope ? 'Error rate' : 'Not answered (% of requests sent)', errors);
      break;
    }
    case 'workers': {
      const waiting = waitingTier(run);
      const id = tierScope ?? waiting;
      unit = '%';
      scopeLabel = name(id);
      defaultScopeLabel = `${name(waiting)} (most workers waiting)`;
      defaultScopeId = waiting;
      const share = (r: RunResult, key: 'busyWorkersAvg' | 'busyCoresAvg', of: number) => r.tiers[id][key].map((v) => (100 * v) / of);
      const t = run.tiers[id];
      series = after
        ? pair('Workers occupied', (r) => share(r, 'busyWorkersAvg', t.workers))
        : [
            { label: 'Workers occupied', values: share(run, 'busyWorkersAvg', t.workers), color: COLORS.primary },
            { label: 'CPU busy', values: share(run, 'busyCoresAvg', t.cores), color: COLORS.secondary },
          ];
      break;
    }
  }
  if (unit === '%') yMax = 100;
  const label = METRIC_TABS.find((m) => m.id === tab)!.label;
  return {
    spec: { xsSeconds, series, unit, yMax, failureWindows, playheadS, ariaLabel: `${label} (${scopeLabel}) over ${Math.round(run.durationMs / 1000)} seconds${after ? ', before and after the fix' : ''}` },
    scopeLabel,
    defaultScopeLabel,
    defaultScopeId,
    ...(note ? { note } : {}),
  };
}

export function timelineView(analysis: Analysis): TimelineEntryView[] {
  return analysis.timeline.map((e) => ({ ...e }));
}

export interface VerdictView {
  text: string;
  tone: 'good' | 'bad';
}

export function verdictView(r: RecoveryResult): VerdictView {
  switch (r.verdict) {
    case 'recovered':
      return { text: `Recovered ${Math.round(r.recoveryMs! / 1000)} s after the failure ended`, tone: 'good' };
    case 'unaffected':
      return { text: 'Unaffected: stayed within the normal range', tone: 'good' };
    case 'stuck':
      return { text: 'Stuck: did not recover after the failure ended', tone: 'bad' };
    case 'overloaded':
      return { text: 'Overloaded even without the failure', tone: 'bad' };
  }
}

/** Short form for cells and comparisons: "stuck", "recovers in 12 s", … */
export function shortVerdict(s: Pick<CellSummary, 'verdict' | 'recoveryMs'>): string {
  switch (s.verdict) {
    case 'recovered':
      return `recovers in ${Math.round(s.recoveryMs! / 1000)} s`;
    case 'unaffected':
      return 'unaffected';
    case 'stuck':
      return 'stuck';
    case 'overloaded':
      return 'overloaded';
  }
}

export function formatAxisValue(axis: Axis, v: number): string {
  return axis.param === 'outageMs' ? `${v / 1000}s` : String(v);
}

/** A map value in words: "a 5 s failure", "3 DB retries", "200 req/s". */
export function axisPhrase(axis: Axis, v: number): string {
  if (axis.param === 'outageMs') {
    const s = v / 1000;
    return `${/^(8|11|18)/.test(String(s)) ? 'an' : 'a'} ${s} s failure`; // "an 8 s failure"
  }
  if (axis.param === 'rps') return `${v} req/s`;
  return `${v} ${axis.label}`;
}

/**
 * The retry cascade in words, front to back, e.g. "Client 5×, Load balancer 3×, API 1×"; null when no
 * call retries.
 */
export function retriesPhrase(calls: Array<{ caller: string; retries: number }>, labels: Record<string, string>): string | null {
  const retrying = calls.filter((c) => c.retries > 0);
  if (retrying.length === 0) return null;
  return retrying.map((c) => `${labels[c.caller] ?? c.caller} ${c.retries}×`).join(', ');
}

/**
 * Map cells. Overloaded (too much traffic even without the failure) has its own status, distinct
 * from stuck (PLAN.md, 2026-10-24); unaffected is drawn as an instant recovery.
 */
export function mapView(title: string, xAxis: Axis, yAxis: Axis, get: (x: number, y: number) => CellSummary | undefined, current: { x: number; y: number } | null): MapView {
  const cells: MapCellView[] = [];
  for (const y of yAxis.values) {
    for (const x of xAxis.values) {
      const s = get(x, y);
      const isCurrent = current !== null && current.x === x && current.y === y;
      if (!s) cells.push({ x, y, status: 'pending', isCurrent });
      else if (s.verdict === 'stuck' || s.verdict === 'overloaded') cells.push({ x, y, status: s.verdict, isCurrent });
      else cells.push({ x, y, status: 'recovered', recoverySeconds: Math.round((s.recoveryMs ?? 0) / 1000), isCurrent });
    }
  }
  return { title, xLabel: xAxis.label, yLabel: yAxis.label, xValues: xAxis.values, yValues: yAxis.values, cells, formatY: (v) => formatAxisValue(yAxis, v) };
}

/** The tier config for an id (exported for the settings drawer). */
export function findTier(config: { tiers: TierConfig[] }, id: string): TierConfig {
  return tierConfig(config as RunConfig, id);
}
