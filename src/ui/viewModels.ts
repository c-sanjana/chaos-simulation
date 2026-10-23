/**
 * Pure mappers from engine/analysis output to the presentational components' view models.
 * Nothing here simulates or decides anything; it only selects and formats.
 */
import type { Analysis } from '../analysis/analyze';
import { callerOf, formatMs, leafCapacityRps } from '../analysis/helpers';
import type { RecoveryResult } from '../analysis/recovery';
import type { RunConfig, TierConfig } from '../engine/config';
import type { RunResult, TierSeries } from '../engine/result';
import type { Axis, TopologyPreset } from '../data/types';
import type { CellSummary } from '../worker/jobs';
import type { ChartSpec, MapCellView, MapView, TimelineEntryView, TimeSeries, TopologyEdgeView, TopologyNodeView } from './components/types';

export const COLORS = { primary: '#1F6FEB', secondary: '#8250DF', reference: '#8C939D', before: '#9AA1AB', bad: '#E8590C' };

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

// Display heuristics for colouring the diagram (they do not feed any verdict):
// a tier is "bad" when its workers are saturated, more than 5% of its responses fail, a leaf's CPU
// is saturated, or its p99 exceeds its caller's timeout. The client is "bad" above 1% errors.
const BAD_ERROR_SHARE = 0.05;
const BAD_CLIENT_ERRORS = 0.01;

/** The topology diagram at time `tMs`: per-tier stats and per-call arrows. */
export function topologyView(topology: TopologyPreset, config: RunConfig, run: RunResult, tMs: number): { nodes: TopologyNodeView[]; edges: TopologyEdgeView[] } {
  const b = bucketAt(run, tMs);
  const c = run.client;
  const clientErrors = c.failed[b] / Math.max(1, c.ok[b] + c.failed[b]);
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
      lines: [`${Math.round(perSecond(run, c.sent[b]))} rps sent`, `${pct(clientErrors)} errors`],
      health: clientErrors > BAD_CLIENT_ERRORS ? 'bad' : 'ok',
    });
  }
  for (const tc of config.tiers) {
    const layout = topology.layout[tc.id];
    if (!layout) continue;
    const t = run.tiers[tc.id];
    const busy = t.busyWorkersAvg[b] / t.workers;
    const cpu = t.busyCoresAvg[b] / t.cores;
    const leaf = leafCapacityRps(tc) !== null;
    const timeout = callerOf(config, tc.id)?.timeoutMs ?? null;
    let lines: [string, string];
    if (tc.cache) lines = [`hit rate ${pct(t.hits[b] / Math.max(1, t.ok[b]))}`, `p99 ${Number.isNaN(t.latencyP99Ms[b]) ? '—' : formatMs(t.latencyP99Ms[b])}`];
    else if (leaf) lines = [`${Math.round(perSecond(run, arrivals(t, b)))} rps in`, `CPU ${pct(cpu)}`];
    else lines = [`workers ${pct(busy)}`, `CPU ${pct(cpu)}`];
    const bad = busy >= 0.99 || errorShare(t, b) > BAD_ERROR_SHARE || (leaf && cpu >= 0.99) || (timeout !== null && t.latencyP99Ms[b] > timeout);
    nodes.push({
      id: tc.id,
      label: layout.label,
      col: layout.col,
      row: layout.row,
      instanceCountLabel: `${tc.instances} instance${tc.instances === 1 ? '' : 's'}`,
      // ASSUMPTION: metrics are per tier, so every instance is drawn at the tier's average busyness.
      instanceBusy: new Array<number>(tc.instances).fill(busy),
      lines,
      health: bad ? 'bad' : 'ok',
    });
  }
  return { nodes, edges: edgesAt(topology, config, run, b) };
}

function edgesAt(topology: TopologyPreset, config: RunConfig, run: RunResult, b: number): TopologyEdgeView[] {
  const calls: Array<{ from: string; to: string; cache: boolean }> = [{ from: 'client', to: config.client.call.target, cache: false }];
  for (const t of config.tiers) {
    if (t.cacheAside) calls.push({ from: t.id, to: t.cacheAside.target, cache: true });
    if (t.downstream) calls.push({ from: t.id, to: t.downstream.target, cache: false });
  }
  const edges: TopologyEdgeView[] = [];
  for (const call of calls) {
    const from = topology.layout[call.from];
    const to = topology.layout[call.to];
    if (!from || !to) continue;
    const place =
      from.row === to.row
        ? { orientation: 'horizontal' as const, col: Math.min(from.col, to.col) + 1, row: from.row }
        : from.col === to.col
          ? { orientation: 'vertical' as const, col: from.col, row: Math.min(from.row, to.row) + 1 }
          : null;
    if (!place) continue; // ASSUMPTION: presets lay calls out in straight lines
    const target = run.tiers[call.to];
    const total = arrivals(target, b);
    const retries = target.arrivalsRetry[b];
    const rps = perSecond(run, total);
    if (call.cache) {
      edges.push({ id: `${call.from}-${call.to}`, ...place, label: `${Math.round(rps)} lookups/s`, detail: `${pct(target.hits[b] / Math.max(1, target.ok[b]))} hits`, rps, health: 'ok' });
    } else {
      const failing = errorShare(target, b) > BAD_ERROR_SHARE;
      const detail = retries > 0 ? `incl. ${Math.round(perSecond(run, retries))} retries` : failing ? `${pct(errorShare(target, b))} fail` : 'no retries';
      edges.push({ id: `${call.from}-${call.to}`, ...place, label: `${Math.round(rps)} rps`, detail, rps, health: retries / Math.max(1, total) > 0.5 || failing ? 'bad' : 'ok' });
    }
  }
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
    const peak = Math.max(...t.arrivalsFirst.map((_, b) => perSecond(run, arrivals(t, b)))) / capacity;
    if (peak > bestRatio) {
      bestRatio = peak;
      best = tc.id;
    }
  }
  return best;
}

/** Tier whose workers were busiest on average: the natural default for "Workers & CPU". */
export function busiestTier(run: RunResult): string {
  const mean = (t: TierSeries) => t.busyWorkersAvg.reduce((a, v) => a + v, 0) / t.busyWorkersAvg.length / t.workers;
  return Object.values(run.tiers).reduce((a, t) => (mean(t) > mean(a) ? t : a)).id;
}

export interface ChartView {
  spec: ChartSpec;
  scopeLabel: string;
}

/**
 * The chart for a metric tab. `scope` is the selected tier (null or 'client' = end to end).
 * With `after`, shows the primary series before (grey) and after (blue) a fix.
 */
export function chartView(tab: MetricTab, config: RunConfig, run: RunResult, labels: Record<string, string>, scope: string | null, after?: RunResult, playheadS?: number): ChartView {
  const xsSeconds = run.client.sent.map((_, i) => (i * run.bucketMs) / 1000);
  const failureWindows = (config.faults ?? []).map((f) => [f.startMs / 1000, f.endMs / 1000] as [number, number]);
  const tierScope = scope && scope !== 'client' ? scope : null;
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

  switch (tab) {
    case 'throughput':
      unit = 'rps';
      scopeLabel = 'end to end, as users see it';
      series = [...pair('Succeeded', (r) => rate(r.client.ok)), ref('User traffic (sent)', rate(run.client.sent))];
      break;
    case 'load': {
      const id = tierScope ?? bottleneckTier(config, run);
      unit = 'rps';
      scopeLabel = name(id);
      const capacity = leafCapacityRps(tierConfig(config, id));
      const total = (r: RunResult) => r.tiers[id].arrivalsFirst.map((f, b) => perSecond(r, f + r.tiers[id].arrivalsRetry[b]));
      series = after
        ? pair(`${name(id)} load`, total)
        : [
            { label: 'First attempts', values: rate(run.tiers[id].arrivalsFirst), color: COLORS.primary, area: true },
            { label: 'Retries', values: rate(run.tiers[id].arrivalsRetry), color: COLORS.bad, area: true },
          ];
      if (capacity !== null) series.push(ref(`${name(id)} capacity`, flat(capacity)));
      break;
    }
    case 'latency': {
      unit = 'ms';
      const p = (r: RunResult, q: 'latencyP99Ms' | 'latencyP50Ms') => (tierScope ? r.tiers[tierScope][q] : r.client[q]);
      scopeLabel = tierScope ? name(tierScope) : 'end to end';
      series = after ? pair('p99', (r) => p(r, 'latencyP99Ms')) : [{ label: 'p99', values: p(run, 'latencyP99Ms'), color: COLORS.primary }, { label: 'p50', values: p(run, 'latencyP50Ms'), color: COLORS.secondary }];
      const timeout = tierScope ? (callerOf(config, tierScope)?.timeoutMs ?? null) : config.client.call.timeoutMs;
      if (timeout !== null) series.push(ref(`Timeout (${formatMs(timeout)})`, flat(timeout)));
      break;
    }
    case 'errors': {
      unit = '%';
      scopeLabel = tierScope ? name(tierScope) : 'end to end';
      const errors = (r: RunResult) =>
        tierScope
          ? r.tiers[tierScope].ok.map((_, b) => 100 * errorShare(r.tiers[tierScope], b))
          : r.client.ok.map((ok, b) => (100 * r.client.failed[b]) / Math.max(1, ok + r.client.failed[b]));
      series = pair('Error rate', errors);
      break;
    }
    case 'workers': {
      const id = tierScope ?? busiestTier(run);
      unit = '%';
      scopeLabel = name(id);
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
  const yMax = unit === '%' ? 100 : undefined;
  const label = METRIC_TABS.find((m) => m.id === tab)!.label;
  return {
    spec: { xsSeconds, series, unit, yMax, failureWindows, playheadS, ariaLabel: `${label} (${scopeLabel}) over ${Math.round(run.durationMs / 1000)} seconds${after ? ', before and after the fix' : ''}` },
    scopeLabel,
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

/** Map cells: stuck/overloaded are drawn as stuck; unaffected as an instant recovery. */
export function mapView(title: string, xAxis: Axis, yAxis: Axis, get: (x: number, y: number) => CellSummary | undefined, current: { x: number; y: number } | null): MapView {
  const cells: MapCellView[] = [];
  for (const y of yAxis.values) {
    for (const x of xAxis.values) {
      const s = get(x, y);
      const isCurrent = current !== null && current.x === x && current.y === y;
      if (!s) cells.push({ x, y, status: 'pending', isCurrent });
      else if (s.verdict === 'stuck' || s.verdict === 'overloaded') cells.push({ x, y, status: 'stuck', isCurrent });
      else cells.push({ x, y, status: 'recovered', recoverySeconds: Math.round((s.recoveryMs ?? 0) / 1000), isCurrent });
    }
  }
  return { title, xLabel: xAxis.label, yLabel: yAxis.label, xValues: xAxis.values, yValues: yAxis.values, cells, formatY: (v) => formatAxisValue(yAxis, v) };
}

/** The tier config for an id (exported for the settings drawer). */
export function findTier(config: { tiers: TierConfig[] }, id: string): TierConfig {
  return tierConfig(config as RunConfig, id);
}
