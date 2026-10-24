import { render, screen, within } from '@testing-library/react';
import { chartRows, chartSummary, ChartTable, phases, roughly } from './ChartText';
import type { ChartSpec } from './types';

vi.mock('uplot', () => import('../testing/fakeUplot'));

const xs = Array.from({ length: 60 }, (_, i) => i);
/** 50 rps until 30 s, then 450 rps (a retry storm that never drains), against a 160 rps capacity. */
const load: ChartSpec = {
  xsSeconds: xs,
  unit: 'rps',
  failureWindows: [[30, 35]],
  ariaLabel: 'Load & retries (DB) over 60 seconds',
  series: [
    { label: 'First attempts', values: xs.map((t) => (t < 30 ? 50 : 150)), color: '#1F6FEB', area: true },
    { label: 'Retries (repeats)', values: xs.map((t) => (t < 30 ? 0 : 300)), color: '#E8590C', area: true },
    { label: 'DB capacity', values: xs.map(() => 160), color: '#8C939D', dashed: true },
  ],
};

describe('roughly', () => {
  it('keeps small numbers and rounds larger ones to two significant digits', () => {
    expect(roughly(47.4)).toBe(47);
    expect(roughly(453)).toBe(450);
    expect(roughly(1015)).toBe(1000);
    expect(roughly(-1234)).toBe(-1200);
    expect(roughly(NaN)).toBeNaN();
  });
});

describe('phases', () => {
  it('joins five-second averages at a similar level and marks gaps without data', () => {
    const values = xs.map((t) => (t < 20 ? 10 : t < 30 ? NaN : 100));
    const p = phases(xs, values, xs.length);
    expect(p.map((x) => [x.from, x.to, x.mean === null ? null : Math.round(x.mean)])).toEqual([
      [0, 19, 10],
      [20, 29, null],
      [30, 59, 100],
    ]);
  });

  it('merges the closest neighbours until at most four phases remain', () => {
    const values = xs.map((t) => [10, 40, 90, 200, 420, 900][Math.floor(t / 10)]);
    expect(phases(xs, values, xs.length).length).toBeLessThanOrEqual(4);
  });
});

describe('chartSummary', () => {
  it('describes the stacked total in phases and when it is above the capacity line', () => {
    expect(chartSummary(load)).toBe(
      'First attempts + Retries (repeats) (total): about 50 rps until 30 s, then about 450 rps until the end. Above DB capacity (160 rps) from 30 s to the end.',
    );
  });

  it('only describes what the replay has revealed', () => {
    expect(chartSummary({ ...load, revealS: 20 })).toBe('First attempts + Retries (repeats) (total): about 50 rps until 20 s (so far). Never above DB capacity (160 rps).');
    expect(chartSummary({ ...load, revealS: -1 })).toMatch(/^Nothing shown yet/);
  });

  it('notes a short peak and up to three stretches above a line', () => {
    const spiky: ChartSpec = {
      ...load,
      unit: 'ms',
      series: [
        { label: 'Slowest 1% wait (p99)', values: xs.map((t) => (t === 31 ? 3000 : t % 10 === 0 ? 1200 : 200)), color: '#1F6FEB' },
        { label: 'User gives up after 1 s', values: xs.map(() => 1000), color: '#8C939D', dashed: true },
      ],
    };
    const text = chartSummary(spiky);
    expect(text).toMatch(/peaking at 3k ms at 31 s/);
    expect(text).toMatch(/Above User gives up after 1 s \(1k ms\) at 0 s, at 10 s, at 20 s, and more\./);
  });

  it('describes plain lines one by one and says when there was no data', () => {
    const lines: ChartSpec = {
      ...load,
      unit: '%',
      series: [
        { label: 'Workers occupied', values: xs.map(() => 100), color: '#1F6FEB' },
        { label: 'CPU busy', values: xs.map((t) => (t < 30 ? NaN : 5)), color: '#8250DF' },
      ],
    };
    expect(chartSummary(lines)).toBe('Workers occupied: about 100% until the end. CPU busy: no data until 30 s, then about 5% until the end.');
  });
});

describe('chartRows and ChartTable', () => {
  it('lists every series every five seconds of what has been revealed', () => {
    const rows = chartRows({ ...load, revealS: 12 });
    expect(rows.map((r) => r.t)).toEqual([0, 5, 10]);
    expect(rows[0].values).toEqual([50, 0, 160]);
  });

  it('renders a captioned table with column and row headers', () => {
    const spec = { ...load, series: [...load.series, { label: 'Gaps', values: xs.map(() => NaN), color: '#000' }] };
    render(<ChartTable spec={spec} height={200} />);
    const region = screen.getByRole('region', { name: 'Load & retries (DB) over 60 seconds, as a table' });
    expect(region.style.height).toBe('200px');
    expect(within(region).getByText(/^First attempts \+ Retries/).tagName).toBe('CAPTION');
    expect(within(region).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Time', 'First attempts', 'Retries (repeats)', 'DB capacity', 'Gaps']);
    const rows = within(region).getAllByRole('row');
    expect(rows).toHaveLength(13); // header + 0, 5, …, 55 s
    expect(rows[7].textContent).toBe('30 s150 rps300 rps160 rps–');
  });
});
