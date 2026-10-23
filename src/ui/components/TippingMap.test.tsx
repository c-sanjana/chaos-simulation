import { fireEvent, render, screen } from '@testing-library/react';
import { MapLegend, TippingMap, cellAriaLabel, cellColor, cellText } from './TippingMap';
import type { MapCellView, MapView } from './types';

const cell = (over: Partial<MapCellView>): MapCellView => ({ x: 200, y: 3, status: 'recovered', isCurrent: false, ...over });

// 2 rows (3 retries on top, 0 below) × 3 traffic levels
const map: MapView = {
  title: 'Tipping-point map',
  xLabel: 'traffic (requests/s)',
  yLabel: 'retries',
  xValues: [100, 150, 200],
  yValues: [3, 0],
  cells: [
    cell({ x: 100, y: 3, recoverySeconds: 5 }),
    cell({ x: 150, y: 3, recoverySeconds: 12.4 }),
    cell({ x: 200, y: 3, status: 'stuck', isCurrent: true }),
    cell({ x: 100, y: 0, recoverySeconds: 20 }),
    cell({ x: 150, y: 0, status: 'pending' }),
    cell({ x: 200, y: 0, recoverySeconds: 7.6 }),
  ],
};

describe('cell helpers', () => {
  it('colours by status and recovery time band', () => {
    expect(cellColor(cell({ recoverySeconds: 7.4 }))).toBe('var(--csl-map-fast)');
    expect(cellColor(cell({ recoverySeconds: 8 }))).toBe('var(--csl-map-slow)');
    expect(cellColor(cell({ recoverySeconds: 17 }))).toBe('var(--csl-map-slow)');
    expect(cellColor(cell({ recoverySeconds: 18 }))).toBe('var(--csl-map-barely)');
    expect(cellColor(cell({ status: 'stuck' }))).toBe('var(--csl-map-stuck)');
    expect(cellColor(cell({ status: 'pending' }))).toBe('var(--csl-map-pending)');
  });

  it('labels cells "12s", "stuck" or "…", marking the current settings', () => {
    expect(cellText(cell({ recoverySeconds: 12.4 }))).toBe('12s');
    expect(cellText(cell({}))).toBe('0s');
    expect(cellText(cell({ status: 'stuck', isCurrent: true }))).toBe('◆ stuck');
    expect(cellText(cell({ status: 'pending' }))).toBe('…');
  });

  it('builds a spoken label from both axes and the outcome', () => {
    expect(cellAriaLabel(cell({ status: 'stuck' }), map)).toBe('200 requests per second, 3 retries: stuck');
    expect(cellAriaLabel(cell({ recoverySeconds: 12 }), map)).toBe('200 requests per second, 3 retries: recovers in 12 s');
    expect(cellAriaLabel(cell({ status: 'pending', isCurrent: true }), map)).toBe(
      '200 requests per second, 3 retries: not run yet (current settings)',
    );
    const outage = { ...map, yLabel: 'outage length (s)', formatY: (y: number) => `${y}s` };
    expect(cellAriaLabel(cell({ y: 10, status: 'stuck' }), outage)).toBe('200 requests per second, 10s outage length: stuck');
  });
});

describe('TippingMap', () => {
  it('renders a button per cell, top row first, with row labels, x labels and captions', () => {
    render(<TippingMap map={map} selected={null} onSelect={() => {}} />);
    const buttons = screen.getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual(['5s', '12s', '◆ stuck', '20s', '…', '8s']);
    expect(buttons[0].getAttribute('aria-label')).toBe('100 requests per second, 3 retries: recovers in 5 s');
    expect(buttons[4].className).toContain('csl-map__cell--pending');
    expect(buttons[2].style.background).toBe('var(--csl-map-stuck)');
    expect(screen.getByRole('group', { name: 'Tipping-point map' })).toBeTruthy();
    expect(screen.getByText('↑ retries')).toBeTruthy();
    expect(screen.getByText('traffic (requests/s) →')).toBeTruthy();
    expect(screen.getByText('150')).toBeTruthy();
    expect(screen.getAllByText('3')).toHaveLength(1);
  });

  it('marks the selected cell and reports clicks', () => {
    const onSelect = vi.fn();
    render(<TippingMap map={map} selected={{ x: 150, y: 3 }} onSelect={onSelect} />);
    const sel = screen.getByRole('button', { name: /^150 requests per second, 3 retries/ });
    expect(sel.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getAllByRole('button', { pressed: true })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: /^200 requests per second, 0 retries/ }));
    expect(onSelect).toHaveBeenCalledWith(map.cells[5]);
  });

  it('uses formatY for row labels and fills missing cells as not run yet', () => {
    const partial: MapView = { ...map, cells: map.cells.slice(0, 2), formatY: (y) => `${y}×` };
    render(<TippingMap map={partial} onSelect={() => {}} />);
    expect(screen.getByText('3×')).toBeTruthy();
    const missing = screen.getByRole('button', { name: /^100 requests per second, 0× retries/ });
    expect(missing.textContent).toBe('…');
    expect(missing.getAttribute('aria-pressed')).toBe('false');
  });

  it('renders a read-only map without buttons when onSelect is omitted', () => {
    render(<TippingMap map={map} />);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.getAllByRole('img')).toHaveLength(6);
    expect(screen.getByRole('img', { name: '200 requests per second, 3 retries: stuck (current settings)' }).textContent).toBe('◆ stuck');
  });
});

describe('MapLegend', () => {
  it('lists the four outcome colours and the current-settings marker', () => {
    render(<MapLegend />);
    const items = screen.getAllByRole('listitem');
    expect(items.map((i) => i.textContent)).toEqual(['Recovers fast', 'Recovers slowly', 'Barely recovers', 'Stuck', '◆ = current settings']);
    expect((items[3].querySelector('span') as HTMLElement).style.background).toBe('var(--csl-map-stuck)');
  });
});
