import { fireEvent, render, screen } from '@testing-library/react';
import { EventTrack } from './EventTrack';
import type { TimelineEntryView } from './types';

const entries: TimelineEntryView[] = [
  { tMs: 50_000, kind: 'tip', text: 'Point of no return' },
  { tMs: 30_000, kind: 'fault', text: 'DB slows 8× (injected failure)' },
  { tMs: 31_000, endMs: 40_000, kind: 'bad', text: 'Requests fail' },
];
const track = (nowMs: number, failureWindows: Array<[number, number]> = [[30_000, 35_000]]) => <EventTrack entries={entries} nowMs={nowMs} failureWindows={failureWindows} />;
const detail = () => document.querySelector('.csl-track__detail')!;

describe('EventTrack', () => {
  it('starts empty', () => {
    render(track(10_000));
    expect(screen.getByText('Events appear here as the replay reaches them.')).toBeTruthy();
    expect(screen.getByText('0 of 3 events')).toBeTruthy();
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('adds an icon per event reached (a range once it ends), in order, tinting those during the failure, and spells out the newest', () => {
    const { rerender } = render(track(35_000));
    expect(screen.getByText('1 of 3 events')).toBeTruthy();
    const mark = screen.getByRole('button', { name: /DB slows 8×/ });
    expect(mark.className).toContain('csl-track__mark--fault');
    expect(mark.getAttribute('aria-pressed')).toBe('true');
    expect(mark.textContent).toBe('⚡');
    expect(detail().textContent).toMatch(/DB slows 8× \(injected failure\)$/);
    expect(screen.getByText('during the failure')).toBeTruthy();

    rerender(track(60_000));
    const steps = screen.getAllByRole('listitem');
    expect(steps.map((s) => s.textContent)).toEqual(['⚡30 s', '✕31 s', '◆50 s']); // by start time
    expect(steps.map((s) => s.className.includes('--during'))).toEqual([true, true, false]);
    expect(detail().textContent).toMatch(/Point of no return$/); // the newest to be reached
    expect(detail().className).toContain('--tip');
  });

  it('the newest is the one reached last: a range counts from when it ends', () => {
    render(<EventTrack entries={[entries[2], { tMs: 35_000, kind: 'info', text: 'Queue grows' }]} nowMs={45_000} failureWindows={[]} />);
    expect(detail().textContent).toMatch(/Requests fail$/);
    expect(screen.queryByText('during the failure')).toBeNull();
  });

  it('spells out the event pointed at, until it is ahead of the replay again', () => {
    const { rerender } = render(track(60_000));
    fireEvent.mouseEnter(screen.getByRole('button', { name: /DB slows/ }));
    expect(detail().textContent).toMatch(/DB slows/);
    expect(screen.getByRole('button', { name: /DB slows/ }).className).toContain('--focus');
    fireEvent.focus(screen.getByRole('button', { name: /Requests fail/ }));
    expect(detail().textContent).toMatch(/Requests fail$/);
    fireEvent.click(screen.getByRole('button', { name: /Point of no return/ }));
    expect(detail().textContent).toMatch(/Point of no return$/);
    fireEvent.click(screen.getByRole('button', { name: /Requests fail/ }));
    rerender(track(35_000));
    expect(screen.queryByRole('button', { name: /Requests fail/ })).toBeNull();
    expect(detail().textContent).toMatch(/DB slows/);
  });

  it('switches to the full list of events as text', () => {
    render(track(60_000));
    fireEvent.click(screen.getByRole('button', { name: 'List' }));
    expect(screen.getByRole('button', { name: 'List' }).getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('.csl-track__steps')).toBeNull();
    expect(screen.getByText('Point of no return')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Icons' }));
    expect(document.querySelector('.csl-track__steps')).not.toBeNull();
  });

  it('labels a verdict known only at the end of the run "end", in the same words as the story', () => {
    render(<EventTrack entries={[{ tMs: 98_900, atEnd: true, kind: 'bad', text: 'Still stuck: never returned to normal after the failure ended' }]} nowMs={120_000} failureWindows={[]} />);
    expect(screen.getByText('end')).toBeTruthy();
    expect(detail().textContent).toBe('end of run Still stuck: never returned to normal after the failure ended');
  });
});
