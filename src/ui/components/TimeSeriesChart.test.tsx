import { render, screen } from '@testing-library/react';
import type uPlot from 'uplot';
import type { ChartSpec } from './types';

// jsdom has no canvas: replace uPlot with a fake that records how it was driven.
const instances: FakeUPlot[] = [];
class FakeUPlot {
  setDataCalls: unknown[] = [];
  redrawCalls: unknown[][] = [];
  sizes: Array<{ width: number; height: number }> = [];
  destroyed = false;
  constructor(
    public opts: uPlot.Options,
    public data: uPlot.AlignedData,
    public target: HTMLElement,
  ) {
    instances.push(this);
  }
  setData(d: unknown) { this.setDataCalls.push(d); }
  redraw(...args: unknown[]) { this.redrawCalls.push(args); }
  setSize(s: { width: number; height: number }) { this.sizes.push(s); }
  destroy() { this.destroyed = true; }
}
vi.mock('uplot', () => ({ default: FakeUPlot }));

const { TimeSeriesChart, toUplot, toUplotData, formatValue, drawFailureWindows, drawPlayhead, FALLBACK_WIDTH, CHART_HEIGHT } =
  await import('./TimeSeriesChart');

const xs = [0, 1, 2, 3];
function spec(over: Partial<ChartSpec> = {}): ChartSpec {
  return {
    xsSeconds: xs,
    series: [
      { label: 'Succeeded', values: [10, 20, 30, 40], color: '#1F6FEB' },
      { label: 'User traffic', values: [50, 50, 50, 50], color: '#8C939D', dashed: true },
    ],
    unit: 'rps',
    failureWindows: [[1, 2]],
    playheadS: 2,
    ariaLabel: 'Throughput over 120 seconds',
    ...over,
  };
}

/** Fake canvas context + uPlot geometry: plot area x 100..500, y 10..210; 1 s = 100 px. */
function fakeU() {
  const calls: Array<[string, ...unknown[]]> = [];
  const rec = (name: string) => (...args: unknown[]) => { calls.push([name, ...args]); };
  const ctx = {
    save: rec('save'), restore: rec('restore'), fillRect: rec('fillRect'), beginPath: rec('beginPath'),
    moveTo: rec('moveTo'), lineTo: rec('lineTo'), stroke: rec('stroke'), setLineDash: rec('setLineDash'),
    fillStyle: '', strokeStyle: '', lineWidth: 0,
  };
  const u = { ctx, bbox: { left: 100, top: 10, width: 400, height: 200 }, valToPos: (v: number) => 100 + v * 100 };
  return { u: u as unknown as uPlot, ctx, calls };
}

beforeEach(() => { instances.length = 0; });

describe('formatValue', () => {
  it('abbreviates thousands and attaches the unit', () => {
    expect(formatValue(1200, ' ms')).toBe('1.2k ms');
    expect(formatValue(1000, 'ms')).toBe('1k ms');
    expect(formatValue(50, 'rps')).toBe('50 rps');
    expect(formatValue(12.5, '%')).toBe('12.5%');
    expect(formatValue(3, '')).toBe('3');
  });
});

describe('toUplotData gaps', () => {
  it('turns NaN (no data) into null so uPlot draws a gap', () => {
    const s: ChartSpec = { xsSeconds: [0, 1, 2], series: [{ label: 'p99', values: [5, NaN, 7], color: '#000' }], unit: 'ms', failureWindows: [], ariaLabel: 'x' };
    expect(toUplotData(s)).toEqual([[0, 1, 2], [5, null, 7]]);
  });
});

describe('toUplotData', () => {
  it('stacks area series on the previous area series and leaves lines alone', () => {
    const s = spec({
      series: [
        { label: 'First attempts', values: [1, 2, 3, 4], color: '#1F6FEB', area: true },
        { label: 'DB capacity', values: [9, 9, 9, 9], color: '#8C939D', dashed: true },
        { label: 'Retries', values: [10, 10, 0, 1], color: '#E8590C', area: true },
      ],
    });
    expect(toUplotData(s)).toEqual([xs, [1, 2, 3, 4], [9, 9, 9, 9], [11, 12, 3, 5]]);
  });

  it('handles a chart with no series', () => {
    expect(toUplotData(spec({ series: [] }))).toEqual([xs]);
  });
});

describe('toUplot', () => {
  it('maps series to uPlot series: solid/dashed lines, no points, x series first', () => {
    const { options, data } = toUplot(spec());
    expect(options.width).toBe(FALLBACK_WIDTH);
    expect(options.height).toBe(CHART_HEIGHT);
    expect(options.series).toHaveLength(3);
    expect(options.series[1]).toMatchObject({ label: 'Succeeded', stroke: '#1F6FEB', width: 2, dash: undefined, fill: undefined });
    expect(options.series[2]).toMatchObject({ label: 'User traffic', dash: [5, 4] });
    expect(options.series[1].points).toEqual({ show: false });
    expect(options.bands).toEqual([]);
    expect(options.legend).toEqual({ show: false });
    expect(data).toEqual([xs, [10, 20, 30, 40], [50, 50, 50, 50]]);
  });

  it('fills the lowest area to zero and bands each further area to the one below it', () => {
    const { options } = toUplot(
      spec({
        series: [
          { label: 'First attempts', values: [1, 1, 1, 1], color: '#1F6FEB', area: true },
          { label: 'Retries', values: [1, 1, 1, 1], color: '#E8590C', area: true },
          { label: 'DB capacity', values: [3, 3, 3, 3], color: '#8C939D', dashed: true },
        ],
      }),
      { width: 300, height: 200 },
    );
    expect(options.width).toBe(300);
    expect(options.series[1]).toMatchObject({ fill: 'rgba(31,111,235,0.55)', width: 1 });
    expect(options.series[2]).toMatchObject({ fill: 'rgba(232,89,12,0.55)' });
    expect(options.bands).toEqual([{ series: [2, 1], fill: 'rgba(232,89,12,0.55)' }]);
  });

  it('formats axis ticks as seconds and value+unit', () => {
    const { options } = toUplot(spec({ unit: 'ms' }));
    const [x, y] = options.axes!;
    const u = {} as uPlot;
    expect(x.values).toBeTypeOf('function');
    expect((x.values as Function)(u, [0, 30, 60])).toEqual(['0s', '30s', '60s']);
    expect((y.values as Function)(u, [0, 500, 1000])).toEqual(['0 ms', '500 ms', '1k ms']);
  });

  it('uses yMax when given, else pads the data max, and never collapses an all-zero chart', () => {
    const range = (s: ChartSpec, max: number) => (toUplot(s).options.scales!.y.range as Function)({} as uPlot, 0, max);
    expect(range(spec({ yMax: 250 }), 40)).toEqual([0, 250]);
    expect(range(spec(), 100)[1]).toBeCloseTo(110);
    expect(range(spec(), 0)).toEqual([0, 1]);
  });

  it('draw hooks paint failure windows (under the series) and the playhead from the overlay', () => {
    const { options } = toUplot(spec());
    const { u, calls } = fakeU();
    options.hooks!.drawClear![0]!(u);
    expect(calls.filter((c) => c[0] === 'fillRect')).toEqual([['fillRect', 200, 10, 100, 200]]);
    options.hooks!.draw![0]!(u);
    expect(calls.filter((c) => c[0] === 'moveTo')).toEqual([['moveTo', 300, 10]]);
  });

  it('reads the overlay through getOverlay so the playhead can move without new options', () => {
    let overlay = { failureWindows: [] as Array<[number, number]>, playheadS: 1 };
    const { options } = toUplot(spec(), undefined, () => overlay);
    const { u, calls } = fakeU();
    overlay = { failureWindows: [], playheadS: 3 };
    options.hooks!.draw![0]!(u);
    expect(calls.filter((c) => c[0] === 'moveTo')).toEqual([['moveTo', 400, 10]]);
  });
});

describe('drawFailureWindows', () => {
  it('clamps windows to the plot area and skips ones outside it', () => {
    const { u, ctx, calls } = fakeU();
    drawFailureWindows(u, [[-1, 0.5], [3.5, 9], [6, 7]]);
    expect(calls.filter((c) => c[0] === 'fillRect')).toEqual([
      ['fillRect', 100, 10, 50, 200],
      ['fillRect', 450, 10, 50, 200],
    ]);
    expect(ctx.fillStyle).toBe('rgba(232,89,12,0.14)');
    expect(calls[0][0]).toBe('save');
    expect(calls[calls.length - 1][0]).toBe('restore');
  });

  it('draws nothing when there are no windows', () => {
    const { u, calls } = fakeU();
    drawFailureWindows(u, []);
    expect(calls.filter((c) => c[0] === 'fillRect')).toEqual([]);
  });
});

describe('drawPlayhead', () => {
  it('draws a dashed vertical line across the plot area', () => {
    const { u, ctx, calls } = fakeU();
    drawPlayhead(u, 1.5);
    expect(calls.map((c) => c[0])).toEqual(['save', 'setLineDash', 'beginPath', 'moveTo', 'lineTo', 'stroke', 'restore']);
    expect(calls.find((c) => c[0] === 'lineTo')).toEqual(['lineTo', 250, 210]);
    expect(ctx.strokeStyle).toBe('#1B1F24');
  });

  it('draws nothing when there is no playhead, it is off the plot, or the scale is not ready', () => {
    const { u, calls } = fakeU();
    drawPlayhead(u, undefined);
    drawPlayhead(u, -1);
    drawPlayhead(u, 99);
    drawPlayhead({ ...u, valToPos: () => NaN } as unknown as uPlot, 1);
    expect(calls).toEqual([]);
  });
});

describe('TimeSeriesChart', () => {
  it('creates one chart on mount in an accessible container', () => {
    render(<TimeSeriesChart {...spec()} />);
    expect(instances).toHaveLength(1);
    const chart = instances[0];
    const box = screen.getByRole('img', { name: 'Throughput over 120 seconds' });
    expect(chart.target).toBe(box);
    expect(chart.opts.width).toBe(FALLBACK_WIDTH); // jsdom reports clientWidth 0
    expect(chart.data).toEqual([xs, [10, 20, 30, 40], [50, 50, 50, 50]]);
  });

  it('only redraws (no new data) when just the playhead moves, and does nothing on an identical render', () => {
    const s = spec();
    const { rerender } = render(<TimeSeriesChart {...s} />);
    const chart = instances[0];
    rerender(<TimeSeriesChart {...s} />);
    expect(chart.redrawCalls).toEqual([]);
    rerender(<TimeSeriesChart {...s} playheadS={3} />);
    expect(chart.redrawCalls).toEqual([[false]]);
    expect(chart.setDataCalls).toEqual([]);
    rerender(<TimeSeriesChart {...s} playheadS={3} failureWindows={[[0, 1]]} />);
    expect(chart.redrawCalls).toHaveLength(2);
    expect(instances).toHaveLength(1);
  });

  it('calls setData when value arrays change, without rebuilding the chart', () => {
    const s = spec();
    const { rerender } = render(<TimeSeriesChart {...s} />);
    const chart = instances[0];
    const series = [{ ...s.series[0], values: [1, 2, 3, 4] }, s.series[1]];
    rerender(<TimeSeriesChart {...s} series={series} />);
    expect(chart.setDataCalls).toEqual([[xs, [1, 2, 3, 4], [50, 50, 50, 50]]]);
    expect(chart.redrawCalls).toEqual([]);
    expect(instances).toHaveLength(1);
    const xs2 = [0, 2, 4, 6];
    rerender(<TimeSeriesChart {...s} series={series} xsSeconds={xs2} />);
    expect(chart.setDataCalls).toHaveLength(2);
  });

  it('rebuilds the chart when the series layout changes, destroying the old one', () => {
    const s = spec();
    const { rerender } = render(<TimeSeriesChart {...s} />);
    rerender(<TimeSeriesChart {...s} series={[{ ...s.series[0], color: '#8250DF' }]} />);
    expect(instances).toHaveLength(2);
    expect(instances[0].destroyed).toBe(true);
    expect(instances[1].destroyed).toBe(false);
    expect(instances[1].opts.series[1].stroke).toBe('#8250DF');
    rerender(<TimeSeriesChart {...s} series={[{ ...s.series[0], color: '#8250DF' }]} unit="ms" />);
    expect(instances).toHaveLength(3);
  });

  it('works with an empty chart (no series, no failure windows, no playhead)', () => {
    render(<TimeSeriesChart xsSeconds={[]} series={[]} unit="%" failureWindows={[]} ariaLabel="Errors" />);
    expect(instances[0].data).toEqual([[]]);
    expect(instances[0].opts.series).toHaveLength(1);
  });

  it('destroys the chart on unmount', () => {
    const { unmount } = render(<TimeSeriesChart {...spec()} />);
    unmount();
    expect(instances[0].destroyed).toBe(true);
  });

  it('resizes with its container when ResizeObserver exists', () => {
    const observers: Array<{ cb: () => void; observed: Element[]; disconnected: boolean }> = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        rec: { cb: () => void; observed: Element[]; disconnected: boolean };
        constructor(cb: () => void) {
          this.rec = { cb, observed: [], disconnected: false };
          observers.push(this.rec);
        }
        observe(el: Element) { this.rec.observed.push(el); }
        disconnect() { this.rec.disconnected = true; }
      },
    );
    try {
      const { unmount } = render(<TimeSeriesChart {...spec()} />);
      const box = screen.getByRole('img');
      expect(observers[0].observed).toEqual([box]);
      Object.defineProperty(box, 'clientWidth', { configurable: true, value: 345 });
      observers[0].cb();
      expect(instances[0].sizes).toEqual([{ width: 345, height: CHART_HEIGHT }]);
      unmount();
      expect(observers[0].disconnected).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
