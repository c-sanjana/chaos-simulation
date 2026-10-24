import { useMemo } from 'react';
import { formatValue } from './TimeSeriesChart';
import type { ChartSpec, TimeSeries } from './types';

/** The table lists one row per this many seconds. */
export const TABLE_STEP_S = 5;
/** Phases in a summary at most; closer ones are merged until it fits. */
const MAX_PHASES = 4;

/** 47 → 47, 453 → 450, 1015 → 1000: "about" numbers in two significant digits. */
export function roughly(v: number): number {
  if (!Number.isFinite(v) || Math.abs(v) < 100) return Math.round(v);
  const p = 10 ** (Math.floor(Math.log10(Math.abs(v))) - 1);
  return Math.round(v / p) * p;
}

function amount(v: number, unit: string): string {
  return formatValue(roughly(v), unit);
}

/** A dashed line at one value the whole run (a capacity or a timeout): a threshold, not data. */
function isReference(s: TimeSeries): boolean {
  return !!s.dashed && s.values.length > 0 && s.values.every((v) => v === s.values[0]);
}

/** Indices of the samples the replay has revealed (all of them without `revealS`). */
function revealed(spec: ChartSpec): number {
  if (spec.revealS === undefined) return spec.xsSeconds.length;
  let n = 0;
  while (n < spec.xsSeconds.length && spec.xsSeconds[n] <= spec.revealS) n++;
  return n;
}

/** The series described in words: stacked areas as their total, then other non-reference lines. */
function described(spec: ChartSpec): TimeSeries[] {
  const areas = spec.series.filter((s) => s.area);
  const lines = spec.series.filter((s) => !s.area && !isReference(s));
  const total: TimeSeries[] =
    areas.length > 1
      ? [{ label: `${areas.map((s) => s.label).join(' + ')} (total)`, color: '', values: areas[0].values.map((_, i) => areas.reduce((a, s) => a + s.values[i], 0)) }]
      : areas;
  return [...total, ...lines];
}

interface Phase {
  from: number;
  to: number;
  /** Mean value over the phase, or null when there was no data. */
  mean: number | null;
  n: number;
}

/** Five-second averages, then neighbouring ones at a similar level joined into phases. */
export function phases(xs: number[], values: number[], count: number): Phase[] {
  const bins: Phase[] = [];
  for (let i = 0; i < count; i++) {
    const k = Math.floor(xs[i] / TABLE_STEP_S);
    let bin = bins[bins.length - 1];
    if (!bin || bin.from !== k * TABLE_STEP_S) {
      bin = { from: k * TABLE_STEP_S, to: xs[i], mean: null, n: 0 };
      bins.push(bin);
    }
    bin.to = xs[i];
    const v = values[i];
    if (!Number.isNaN(v)) {
      bin.mean = ((bin.mean ?? 0) * bin.n + v) / (bin.n + 1);
      bin.n++;
    }
  }
  const max = Math.max(0, ...bins.map((b) => b.mean ?? 0));
  const close = (a: number | null, b: number | null) => (a === null || b === null ? a === b : Math.abs(a - b) <= Math.max(0.25 * Math.max(a, b), 0.08 * max));
  const joined: Phase[] = [];
  for (const b of bins) {
    const last = joined[joined.length - 1];
    if (last && close(last.mean, b.mean)) merge(last, b);
    else joined.push({ ...b });
  }
  // Too many phases: merge the closest neighbours until it reads as a few sentences.
  while (joined.length > MAX_PHASES) {
    let best = 0;
    let bestGap = Infinity;
    for (let i = 0; i < joined.length - 1; i++) {
      const [a, b] = [joined[i].mean, joined[i + 1].mean];
      const gap = a === null || b === null ? (a === b ? 0 : Infinity) : Math.abs(a - b) / Math.max(1e-9, a, b);
      if (gap < bestGap) [best, bestGap] = [i, gap];
    }
    if (bestGap === Infinity) break;
    merge(joined[best], joined[best + 1]);
    joined.splice(best + 1, 1);
  }
  return joined;
}

function merge(into: Phase, b: Phase) {
  const n = into.n + b.n;
  into.mean = n === 0 ? null : ((into.mean ?? 0) * into.n + (b.mean ?? 0) * b.n) / n;
  into.n = n;
  into.to = b.to;
}

/** Time ranges (s) where the values are above `level`, as [from, to] pairs of sample times. */
function rangesAbove(xs: number[], values: number[], count: number, level: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < count; i++) {
    if (!(values[i] > level)) continue;
    const last = out[out.length - 1];
    if (last && i > 0 && last[1] === xs[i - 1]) last[1] = xs[i];
    else out.push([xs[i], xs[i]]);
  }
  return out;
}

/**
 * The chart in a few words, for screen readers and the table's caption, e.g. "First attempts +
 * Retries (total): about 50 rps until 30 s, then about 450 rps until the end. Above DB capacity
 * (160 rps) from 32 s to the end." Only what the replay has revealed is described.
 */
export function chartSummary(spec: ChartSpec): string {
  const count = revealed(spec);
  if (count === 0) return 'Nothing shown yet: the chart fills in as the replay plays.';
  const xs = spec.xsSeconds;
  const whole = count === xs.length;
  const end = xs[count - 1];
  const until = (t: number) => (t >= end ? (whole ? 'until the end' : `until ${Math.round(t)} s (so far)`) : `until ${Math.round(t) + 1} s`);
  const sentences: string[] = [];
  const series = described(spec);
  series.slice(0, 3).forEach((s) => {
    const parts = phases(xs, s.values, count).map((p, i) => {
      const level = p.mean === null ? 'no data' : `about ${amount(p.mean, spec.unit)}`;
      return `${i === 0 ? '' : 'then '}${level} ${until(p.to)}`;
    });
    let peakNote = '';
    const shown = s.values.slice(0, count);
    const peak = Math.max(...shown.filter((v) => !Number.isNaN(v)));
    const top = Math.max(0, ...phases(xs, s.values, count).map((p) => p.mean ?? 0));
    if (Number.isFinite(peak) && peak > 1.3 * top && peak > 0) peakNote = `, peaking at ${amount(peak, spec.unit)} at ${Math.round(xs[shown.indexOf(peak)])} s`;
    sentences.push(`${s.label}: ${parts.join(', ')}${peakNote}.`);
  });
  const main = series[0];
  if (main) {
    for (const ref of spec.series.filter(isReference)) {
      const level = ref.values[0];
      const above = rangesAbove(xs, main.values, count, level);
      const name = `${ref.label} (${amount(level, spec.unit)})`;
      if (above.length === 0) sentences.push(`Never above ${name}.`);
      else
        sentences.push(
          `Above ${name} ${above
            .slice(0, 3)
            .map(([a, b]) => (b >= end && whole ? `from ${Math.round(a)} s to the end` : a === b ? `at ${Math.round(a)} s` : `from ${Math.round(a)} to ${Math.round(b)} s`))
            .join(', ')}${above.length > 3 ? ', and more' : ''}.`,
        );
    }
  }
  return sentences.join(' ');
}

/** Rows every TABLE_STEP_S seconds of what the replay has revealed: [time, value per series]. */
export function chartRows(spec: ChartSpec): Array<{ t: number; values: number[] }> {
  const count = revealed(spec);
  const rows: Array<{ t: number; values: number[] }> = [];
  for (let i = 0; i < count; i++) {
    const t = spec.xsSeconds[i];
    if (t % TABLE_STEP_S === 0) rows.push({ t, values: spec.series.map((s) => s.values[i]) });
  }
  return rows;
}

function cell(v: number, unit: string): string {
  return Number.isNaN(v) ? '–' : formatValue(Math.round(v * 10) / 10, unit);
}

/** The chart's data as a table (values every 5 s), captioned with its summary; scrolls inside its box. */
export function ChartTable({ spec, height }: { spec: ChartSpec; height: number }) {
  const rows = chartRows(spec);
  const summary = useMemo(() => chartSummary(spec), [spec]);
  return (
    <div className="csl-chart-table" style={{ height }} tabIndex={0} role="region" aria-label={`${spec.ariaLabel}, as a table`}>
      <table>
        <caption>{summary}</caption>
        <thead>
          <tr>
            <th scope="col">Time</th>
            {spec.series.map((s) => (
              <th key={s.label} scope="col">
                {s.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.t}>
              <th scope="row">{r.t} s</th>
              {r.values.map((v, i) => (
                <td key={spec.series[i].label}>{cell(v, spec.unit)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
