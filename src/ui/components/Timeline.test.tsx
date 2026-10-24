import { render, screen } from '@testing-library/react';
import { Timeline, formatSeconds, timeLabel } from './Timeline';
import type { TimelineEntryView } from './types';

const entries: TimelineEntryView[] = [
  { tMs: 30_000, text: 'DB slows 8× (injected failure)', kind: 'fault' },
  { tMs: 31_000, text: 'DB p99 1.9 s exceeds the app server timeout of 1 s', kind: 'info' },
  { tMs: 34_000, text: 'Tipping point: API queue holds 2.4 s of work', kind: 'tip' },
  { tMs: 36_000, endMs: 120_000, text: 'Still stuck', kind: 'info' },
  { tMs: 120_000, text: 'Never matched the no-failure run: stuck', kind: 'bad' },
  { tMs: 47_000, text: 'Recovered in 12 s', kind: 'good' },
];

describe('time labels', () => {
  it('formats whole and fractional seconds and ranges', () => {
    expect(formatSeconds(30_000)).toBe('30');
    expect(formatSeconds(30_500)).toBe('30.5');
    expect(formatSeconds(30_449)).toBe('30.4');
    expect(timeLabel({ tMs: 30_000 })).toBe('30 s');
    expect(timeLabel({ tMs: 36_000, endMs: 120_000 })).toBe('36–120 s');
  });
});

describe('Timeline', () => {
  it('renders an ordered list in the given order with times', () => {
    render(<Timeline entries={entries} />);
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(6);
    expect(screen.getByRole('list').tagName).toBe('OL');
    expect(items[0].textContent).toBe('30 sDB slows 8× (injected failure)');
    expect(items[3].textContent).toContain('36–120 s');
  });

  it('colours the dot by kind and emphasises tip, bad and good entries', () => {
    render(<Timeline entries={entries} />);
    const items = screen.getAllByRole('listitem');
    const dot = (i: number) => (items[i].querySelector('.csl-timeline__dot') as HTMLElement).style.background;
    const text = (i: number) => items[i].querySelector('.csl-timeline__text') as HTMLElement;
    expect(dot(0)).toBe('var(--csl-bad)');
    expect(dot(1)).toBe('var(--csl-info-dot)');
    expect(dot(5)).toBe('var(--csl-good)');
    expect(text(0).className).toBe('csl-timeline__text');
    expect(text(2).className).toBe('csl-timeline__text csl-timeline__text--strong csl-timeline__text--tip');
    expect(text(4).className).toBe('csl-timeline__text csl-timeline__text--strong');
    expect(text(5).className).toBe('csl-timeline__text csl-timeline__text--strong');
  });

  it('says so when there is nothing to show', () => {
    render(<Timeline entries={[]} />);
    expect(screen.queryByRole('list')).toBeNull();
    expect(screen.getByText('Nothing notable detected.')).toBeTruthy();
  });

  it('plays along newest first, highlighting failures and the latest event', () => {
    const { rerender } = render(<Timeline entries={entries} nowMs={40_000} />);
    let items = screen.getAllByRole('listitem');
    // "36–120 s Still stuck" spans a range, so it waits until the replay reaches its end.
    expect(items.map((i) => i.querySelector('.csl-timeline__time')!.textContent)).toEqual(['34 s', '31 s', '30 s']);
    expect(items[0].className).toContain('csl-timeline__item--latest');
    expect(items[0].className).toContain('csl-timeline__item--alert'); // the point of no return
    expect(items[2].className).toContain('csl-timeline__item--alert'); // the injected failure
    expect(items[1].className).not.toContain('--alert');
    expect(screen.getByText('3 more events ahead')).toBeTruthy();
    rerender(<Timeline entries={entries} nowMs={60_000} />);
    expect(screen.getByText('2 more events ahead')).toBeTruthy();
    items = screen.getAllByRole('listitem');
    expect(items[0].textContent).toContain('Recovered in 12 s');
    rerender(<Timeline entries={entries} nowMs={120_000} />);
    expect(screen.queryByText(/more events? ahead/)).toBeNull();
    items = screen.getAllByRole('listitem');
    // Both entries revealed at 120 s come first, in their given order.
    expect(items.slice(0, 2).map((i) => i.querySelector('.csl-timeline__time')!.textContent)).toEqual(['36–120 s', '120 s']);
  });
});
