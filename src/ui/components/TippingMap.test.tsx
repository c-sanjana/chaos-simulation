import { act, fireEvent, render, screen } from '@testing-library/react';
import { MapLegend, TippingMap, cellAriaLabel, cellColor, cellText, gridMove } from './TippingMap';
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
    expect(cellColor(cell({ recoverySeconds: 3.4 }))).toBe('var(--csl-map-fast)');
    expect(cellColor(cell({ recoverySeconds: 4 }))).toBe('var(--csl-map-slow)');
    expect(cellColor(cell({ recoverySeconds: 8 }))).toBe('var(--csl-map-slow)');
    expect(cellColor(cell({ recoverySeconds: 9 }))).toBe('var(--csl-map-barely)');
    expect(cellColor(cell({ status: 'stuck' }))).toBe('var(--csl-map-stuck)');
    expect(cellColor(cell({ status: 'overloaded' }))).toBe('var(--csl-map-overloaded)');
    expect(cellColor(cell({ status: 'pending' }))).toBe('var(--csl-map-pending)');
  });

  it('marks only the current settings, with ◆ (stuck cells are told by colour and their name)', () => {
    expect(cellText(cell({ recoverySeconds: 12.4 }))).toBe('');
    expect(cellText(cell({ status: 'stuck' }))).toBe('');
    expect(cellText(cell({ status: 'stuck', isCurrent: true }))).toBe('◆');
    expect(cellText(cell({ status: 'overloaded' }))).toBe(''); // hatched instead
    expect(cellText(cell({ status: 'pending' }))).toBe('');
  });

  it('builds a spoken label from both axes and the outcome', () => {
    expect(cellAriaLabel(cell({ status: 'stuck' }), map)).toBe('200 requests per second, 3 retries: stuck');
    expect(cellAriaLabel(cell({ status: 'stuck' }), map, true)).toBe('200 requests per second, 3 retries: stuck, the tipping point');
    expect(cellAriaLabel(cell({ status: 'overloaded' }), map)).toBe('200 requests per second, 3 retries: too much traffic even without the failure');
    expect(cellAriaLabel(cell({ recoverySeconds: 12 }), map)).toBe('200 requests per second, 3 retries: recovers in 12 s');
    expect(cellAriaLabel(cell({ status: 'pending', isCurrent: true }), map)).toBe(
      '200 requests per second, 3 retries: not run yet (current settings)',
    );
    const outage = { ...map, yLabel: 'outage length (s)', formatY: (y: number) => `${y}s` };
    expect(cellAriaLabel(cell({ y: 10, status: 'stuck' }), outage)).toBe('200 requests per second, 10s outage length: stuck');
  });
});

describe('TippingMap', () => {
  it('renders a button per cell, top row first, with row labels, x labels and named axes', () => {
    render(<TippingMap map={map} selected={null} onSelect={() => {}} />);
    const buttons = screen.getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual(['', '', '◆', '', '', '']); // the stuck cell is the current one
    expect(buttons[0].getAttribute('aria-label')).toBe('100 requests per second, 3 retries: recovers in 5 s');
    expect(buttons[0].getAttribute('title')).toBe('100 requests per second, 3 retries: recovers in 5 s'); // hover tooltip
    expect(buttons[4].className).toContain('csl-map__cell--pending');
    expect(buttons[2].style.backgroundColor).toBe('var(--csl-map-stuck)');
    expect(buttons[2].className).toContain('csl-map__cell--stuck');
    expect(screen.getByRole('grid', { name: 'Tipping-point map' })).toBeTruthy();
    expect(screen.getByText('retries →')).toBeTruthy(); // runs along the y axis
    expect(screen.getByText('traffic (requests/s) →')).toBeTruthy();
    expect(screen.getByText('150')).toBeTruthy();
    expect(screen.getAllByText('3')).toHaveLength(1);
  });

  it('is an ARIA grid with the axis values as column and row headers', () => {
    render(<TippingMap map={map} selected={null} onSelect={() => {}} />);
    const rows = screen.getAllByRole('row');
    expect(rows).toHaveLength(3); // the header row first, then the two map rows
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      'retries',
      '100 requests per second',
      '150 requests per second',
      '200 requests per second',
    ]);
    expect(screen.getAllByRole('rowheader').map((h) => h.textContent)).toEqual(['3 retries', '0 retries']);
    expect(screen.getAllByRole('gridcell')).toHaveLength(6);
    expect(screen.getAllByRole('gridcell')[2].getAttribute('aria-selected')).toBe('false');
  });

  it('is one tab stop: arrow keys, Home/End and Page Up/Down move between cells, Enter replays', () => {
    const onSelect = vi.fn();
    render(<TippingMap map={map} selected={{ x: 150, y: 3 }} onSelect={onSelect} />);
    const buttons = screen.getAllByRole('button');
    // Only the selected cell is in the tab order.
    expect(buttons.map((b) => b.tabIndex)).toEqual([-1, 0, -1, -1, -1, -1]);
    act(() => buttons[1].focus());
    fireEvent.keyDown(buttons[1], { key: 'ArrowRight' });
    expect(document.activeElement).toBe(buttons[2]);
    expect(buttons.map((b) => b.tabIndex)).toEqual([-1, -1, 0, -1, -1, -1]);
    fireEvent.keyDown(buttons[2], { key: 'ArrowRight' }); // stops at the edge
    expect(document.activeElement).toBe(buttons[2]);
    fireEvent.keyDown(buttons[2], { key: 'ArrowDown' });
    expect(document.activeElement).toBe(buttons[5]);
    fireEvent.keyDown(buttons[5], { key: 'Home' });
    expect(document.activeElement).toBe(buttons[3]);
    fireEvent.keyDown(buttons[3], { key: 'PageUp' });
    expect(document.activeElement).toBe(buttons[0]);
    fireEvent.keyDown(buttons[0], { key: 'End', ctrlKey: true });
    expect(document.activeElement).toBe(buttons[5]);
    fireEvent.keyDown(buttons[5], { key: 'a' }); // other keys are left alone
    expect(document.activeElement).toBe(buttons[5]);
    // Enter/Space activate the focused cell's button (native button behaviour).
    fireEvent.click(buttons[5]);
    expect(onSelect).toHaveBeenCalledWith(map.cells[5]);
    // Focusing a cell by pointer moves the tab stop there too.
    fireEvent.focus(buttons[3]);
    expect(buttons[3].tabIndex).toBe(0);
  });

  it('starts the tab stop on the marked cell when nothing is selected', () => {
    render(<TippingMap map={map} selected={null} onSelect={() => {}} />);
    expect(screen.getAllByRole('button').map((b) => b.tabIndex)).toEqual([-1, -1, 0, -1, -1, -1]);
  });

  it('moves within the grid and stops at its edges', () => {
    // 2 rows × 3 columns, row-major.
    expect(gridMove('ArrowLeft', 0, 2, 3)).toBe(0);
    expect(gridMove('ArrowUp', 1, 2, 3)).toBe(1);
    expect(gridMove('ArrowDown', 1, 2, 3)).toBe(4);
    expect(gridMove('ArrowDown', 4, 2, 3)).toBe(4);
    expect(gridMove('End', 3, 2, 3)).toBe(5);
    expect(gridMove('Home', 5, 2, 3, true)).toBe(0);
    expect(gridMove('PageDown', 1, 2, 3)).toBe(4);
    expect(gridMove('Enter', 1, 2, 3)).toBeNull();
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
    expect(missing.textContent).toBe('');
    expect(missing.className).toContain('csl-map__cell--pending');
    expect(missing.getAttribute('aria-pressed')).toBe('false');
  });

  it('renders a read-only map without buttons when onSelect is omitted', () => {
    render(<TippingMap map={map} />);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.getAllByRole('img')).toHaveLength(6);
    expect(screen.getByRole('img', { name: '200 requests per second, 3 retries: stuck (current settings)' }).textContent).toBe('◆');
    // Still one tab stop that arrow keys move, on the cells themselves.
    const grid = screen.getByRole('grid');
    expect(grid.getAttribute('aria-readonly')).toBe('true');
    const cells = screen.getAllByRole('gridcell');
    expect(cells.map((c) => c.tabIndex)).toEqual([-1, -1, 0, -1, -1, -1]);
    fireEvent.keyDown(cells[2], { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(cells[1]);
  });

  it('draws each row’s tipping point as a line on that cell, and hatches overloaded cells', () => {
    const withOverload: MapView = { ...map, cells: map.cells.map((c, i) => (i === 5 ? { ...c, status: 'overloaded' as const } : c)) };
    render(<TippingMap map={withOverload} onSelect={() => {}} tips={[{ y: 3, tipsAtX: 200 }, { y: 0, tipsAtX: null }]} />);
    const tip = screen.getByRole('button', { name: /^200 requests per second, 3 retries: stuck, the tipping point/ });
    expect(tip.className).toContain('csl-map__cell--tip');
    expect(document.querySelectorAll('.csl-map__cell--tip')).toHaveLength(1);
    const over = screen.getByRole('button', { name: /^200 requests per second, 0 retries: too much traffic/ });
    expect(over.className).toContain('csl-map__cell--overloaded');
    expect(over.style.backgroundColor).toBe('var(--csl-map-overloaded)');
  });
});

describe('MapLegend', () => {
  it('explains every outcome with its mark, the tipping line, the current marker and the replay ring', () => {
    render(<MapLegend />);
    const items = screen.getAllByRole('listitem');
    expect(items.map((i) => i.textContent)).toEqual([
      'Recovers in< 4 s4–9 s9 s+',
      'Stuck',
      'Too much traffic even without the failure',
      'Not run yet',
      'tipping point',
      '◆ your settings',
      'replaying',
    ]);
    expect((items[1].querySelector('span') as HTMLElement).style.backgroundColor).toBe('var(--csl-map-stuck)');
    expect((items[2].querySelector('span') as HTMLElement).className).toContain('csl-map__cell--overloaded');
  });

  it('can leave out the replay ring and the tipping line, and rename the marker', () => {
    render(<MapLegend showSelected={false} showTip={false} markLabel="shown in the replay" />);
    expect(screen.queryByText('replaying')).toBeNull();
    expect(screen.queryByText('tipping point')).toBeNull();
    expect(screen.getByText('◆ shown in the replay')).toBeTruthy();
  });

  it('compact (step 3): one line with the shorter overload words', () => {
    render(<MapLegend showSelected={false} showMark={false} showPending={false} compact />);
    expect(screen.getByRole('list', { name: 'Map legend' }).className).toContain('csl-map-legend--compact');
    expect(screen.getAllByRole('listitem').map((i) => i.textContent)).toEqual(['Recovers in< 4 s4–9 s9 s+', 'Stuck', 'Too much traffic anyway', 'tipping point']);
  });
});
