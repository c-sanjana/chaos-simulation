import { useEffect, useRef } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { AREA_ALPHA, withAlpha } from './color';
import { mergeWindows } from './windows';
import { cssVar, useThemeValue } from '../themeMode';
import type { ChartSpec } from './types';

// Canvas can't use CSS variables, so colours are read from the theme tokens when the chart is
// built or drawn; these light-theme values are the fallbacks (and what tests see).
const INK = '#1B1F24';
const AXIS_TEXT = '#555C66';
const GRID = '#ECEEF1';
const FAILURE_TINT = 'rgba(232,89,12,0.14)';
const FONT = '11px "IBM Plex Mono", monospace';

export const CHART_HEIGHT = 240;
/** ASSUMPTION: used when the container has no measurable width yet (hidden, or jsdom). */
export const FALLBACK_WIDTH = 600;

export interface Overlay {
  failureWindows: Array<[number, number]>;
  playheadS?: number;
  /** Top of the y axis when the spec has no yMax (the full run's max, so it doesn't jump during a reveal). */
  autoMax?: number;
}

/** Axis tick label: 1200 → "1.2k", 50 → "50"; '%' is attached directly, other units after a space. */
export function formatValue(v: number, unit: string): string {
  const n = Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(1).replace(/\.0$/, '')}k` : `${Math.round(v * 100) / 100}`;
  if (!unit) return n;
  return unit === '%' ? `${n}%` : `${n} ${unit.trim()}`;
}

/**
 * Data in uPlot's aligned format: [xs, ...series]. 'area' series are replaced by running totals
 * (each area series stacked on the area series before it), so the band between two consecutive
 * area series has the height of the upper one's own values.
 */
export function toUplotData(spec: ChartSpec): uPlot.AlignedData {
  let stack: number[] | null = null;
  // NaN means "no data this second" (e.g. no successful requests): uPlot draws a gap for null.
  // Seconds after `revealS` are not drawn yet, so lines grow as the replay plays.
  const hidden = (i: number) => spec.revealS !== undefined && spec.xsSeconds[i] > spec.revealS;
  const gaps = (values: number[]) => values.map((v, i) => (Number.isNaN(v) || hidden(i) ? null : v));
  const ys = spec.series.map((s) => {
    if (!s.area) return gaps(s.values);
    const below = stack;
    stack = s.values.map((v, i) => v + (below ? below[i] : 0));
    return gaps(stack);
  });
  return [spec.xsSeconds, ...ys];
}

/** Largest value the chart will ever show (stacked areas included), so the y axis stays put while data is revealed. */
export function fullMax(spec: ChartSpec): number {
  let max = 0;
  let stack: number[] | null = null;
  for (const s of spec.series) {
    let values = s.values;
    if (s.area) {
      const below: number[] | null = stack;
      stack = values.map((v, i) => v + (below ? below[i] : 0));
      values = stack;
    }
    for (const v of values) if (v > max) max = v;
  }
  return max;
}

export function drawFailureWindows(u: Pick<uPlot, 'ctx' | 'bbox' | 'valToPos'>, windows: Array<[number, number]>): void {
  const { ctx, bbox } = u;
  ctx.save();
  ctx.fillStyle = cssVar('--csl-failure-tint', FAILURE_TINT);
  for (const [from, to] of mergeWindows(windows)) {
    const x0 = Math.max(bbox.left, u.valToPos(from, 'x', true));
    const x1 = Math.min(bbox.left + bbox.width, u.valToPos(to, 'x', true));
    if (x1 > x0) ctx.fillRect(x0, bbox.top, x1 - x0, bbox.height);
  }
  ctx.restore();
}

export function drawPlayhead(u: Pick<uPlot, 'ctx' | 'bbox' | 'valToPos'>, playheadS: number | undefined): void {
  if (playheadS === undefined) return;
  const { ctx, bbox } = u;
  const x = u.valToPos(playheadS, 'x', true);
  if (!Number.isFinite(x) || x < bbox.left || x > bbox.left + bbox.width) return;
  const px = window.devicePixelRatio || 1;
  ctx.save();
  ctx.strokeStyle = cssVar('--csl-ink', INK);
  ctx.lineWidth = px;
  ctx.setLineDash([2 * px, 3 * px]);
  ctx.beginPath();
  ctx.moveTo(x, bbox.top);
  ctx.lineTo(x, bbox.top + bbox.height);
  ctx.stroke();
  ctx.restore();
}

/**
 * Pure conversion of a ChartSpec into uPlot options and data.
 * `getOverlay` lets the live chart redraw the playhead without rebuilding options;
 * by default the overlay comes from the spec itself.
 */
export function toUplot(
  spec: ChartSpec,
  size: { width: number; height: number } = { width: FALLBACK_WIDTH, height: CHART_HEIGHT },
  getOverlay: () => Overlay = () => spec,
): { options: uPlot.Options; data: uPlot.AlignedData } {
  const series: uPlot.Series[] = [{ label: 'Time (s)' }];
  const bands: uPlot.Band[] = [];
  let prevAreaIdx: number | null = null;

  spec.series.forEach((s, i) => {
    const idx = i + 1; // uPlot index 0 is the x series
    const fill = s.area ? withAlpha(s.color, AREA_ALPHA) : undefined;
    series.push({
      label: s.label,
      stroke: s.color,
      width: s.area ? 1 : 2,
      dash: s.dashed ? [5, 4] : undefined,
      fill,
      points: { show: false },
    });
    if (s.area) {
      // Fill only between this area and the one below it; the lowest area fills down to zero.
      if (prevAreaIdx !== null) bands.push({ series: [idx, prevAreaIdx], fill });
      prevAreaIdx = idx;
    }
  });

  const [axisText, grid] = [cssVar('--csl-muted', AXIS_TEXT), cssVar('--csl-grid', GRID)];
  const axis = (format: (v: number) => string): uPlot.Axis => ({
    stroke: axisText,
    font: FONT,
    grid: { stroke: grid, width: 1 },
    ticks: { show: false },
    values: (_u, splits) => splits.map(format),
  });

  const options: uPlot.Options = {
    width: size.width,
    height: size.height,
    series,
    bands,
    legend: { show: false }, // ChartLegend renders the legend in HTML
    cursor: { show: false, drag: { x: false, y: false } },
    scales: {
      x: { time: false },
      y: {
        range: (_u, _min, max) => {
          const top = getOverlay().autoMax ?? max;
          return [0, spec.yMax ?? (top > 0 ? top * 1.1 : 1)];
        },
      },
    },
    axes: [axis((v) => `${v}s`), { ...axis((v) => formatValue(v, spec.unit)), size: 64 }],
    hooks: {
      drawClear: [(u) => drawFailureWindows(u, getOverlay().failureWindows)],
      draw: [(u) => drawPlayhead(u, getOverlay().playheadS)],
    },
  };
  return { options, data: toUplotData(spec) };
}

/** Changes to these fields need new uPlot options, so the chart is rebuilt. */
function structureKey(spec: ChartSpec): string {
  return JSON.stringify([spec.unit, spec.yMax, spec.series.map((s) => [s.label, s.color, !!s.dashed, !!s.area])]);
}

function overlayKey(o: Overlay): string {
  return JSON.stringify([o.failureWindows, o.playheadS]);
}

function dataRefs(spec: ChartSpec): unknown[] {
  return [spec.xsSeconds, ...spec.series.map((s) => s.values)];
}

function sameRefs(a: unknown[], b: unknown[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function widthOf(el: HTMLElement): number {
  return el.clientWidth || FALLBACK_WIDTH;
}

/**
 * Thin React wrapper around uPlot. The chart is created on mount (and rebuilt when the series
 * layout changes), gets new data via setData when value arrays change identity, and only
 * redraws when the playhead or failure windows move.
 */
export function TimeSeriesChart(spec: ChartSpec) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<uPlot | null>(null);
  const overlayRef = useRef<Overlay>(spec);
  const appliedRef = useRef({ data: [] as unknown[], overlay: '', reveal: -1 });
  overlayRef.current = { failureWindows: spec.failureWindows, playheadS: spec.playheadS, autoMax: fullMax(spec) };
  // Data is re-sent once per revealed second, not every animation frame.
  const reveal = spec.revealS === undefined ? Infinity : Math.floor(spec.revealS);
  const key = structureKey(spec);
  const theme = useThemeValue(); // axis and grid colours are baked into the options

  useEffect(() => {
    const el = containerRef.current!;
    const { options, data } = toUplot(spec, { width: widthOf(el), height: spec.height ?? CHART_HEIGHT }, () => overlayRef.current);
    const chart = new uPlot(options, data, el);
    chartRef.current = chart;
    appliedRef.current = { data: dataRefs(spec), overlay: overlayKey(overlayRef.current), reveal };

    let observer: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => chart.setSize({ width: widthOf(el), height: spec.height ?? CHART_HEIGHT }));
      observer.observe(el);
    }
    return () => {
      observer?.disconnect();
      chart.destroy();
      chartRef.current = null;
    };
    // Rebuild only when the structure or theme changes; data and overlay updates are handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, theme]);

  useEffect(() => {
    const chart = chartRef.current!;
    const refs = dataRefs(spec);
    const overlay = overlayKey(overlayRef.current);
    if (!sameRefs(refs, appliedRef.current.data) || reveal !== appliedRef.current.reveal) {
      chart.setData(toUplotData(spec)); // also redraws the overlay
    } else if (overlay !== appliedRef.current.overlay) {
      chart.redraw(false);
    }
    appliedRef.current = { data: refs, overlay, reveal };
  });

  return <div ref={containerRef} className="csl-chart" role="img" aria-label={spec.ariaLabel} />;
}
