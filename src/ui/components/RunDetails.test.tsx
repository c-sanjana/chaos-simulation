import { fireEvent, render, screen, within } from '@testing-library/react';
import { measuredBySteps, RunDetails } from './RunDetails';
import type { StoryStepView } from './StoryCard';
import type { TimelineEntryView } from './types';

const steps: StoryStepView[] = [
  { tMs: 30_000, text: 'At 30 s the database became 8× slower.', tone: 'fault', kind: 'fault', headline: 'Database 8× slower', figure: '5 s' },
  {
    tMs: 31_000,
    text: 'The app server gives up after 1 s and everyone asks again.',
    tone: 'info',
    kind: 'giveup',
    headline: 'The app server gives up, everyone asks again',
    figure: '1 s',
    cascade: [
      { who: "users' apps", retries: 5 },
      { who: 'the API', retries: 3 },
    ],
  },
  { tMs: 33_000, text: 'The database got 1.6× what it can handle.', tone: 'bad', kind: 'overload', headline: 'Database overloaded', figure: '1.6×', meter: 1.6 },
  { tMs: 117_000, text: 'It never recovered.', tone: 'bad', kind: 'stuck', headline: 'Still stuck', figure: '3.2× peak' },
];
const entries: TimelineEntryView[] = [
  { tMs: 30_000, text: 'DB slows 8× (injected failure)', kind: 'fault' },
  { tMs: 31_000, text: 'App server gives up on DB (1 s timeout)', kind: 'info' },
  { tMs: 32_000, text: 'Gateway gives up on App server', kind: 'info' },
  { tMs: 34_000, text: 'DB queue wait exceeds the App server timeout', kind: 'tip' },
  { tMs: 117_000, text: 'Still stuck: 100% of DB work was for requests already given up on', kind: 'bad', atEnd: true },
];
const props = { steps, entries, failureWindows: [[30_000, 35_000]] as Array<[number, number]> };

describe('RunDetails: one panel for what happened', () => {
  it('starts with a calm note before anything happens', () => {
    render(<RunDetails {...props} nowMs={5_000} />);
    expect(screen.getByRole('heading', { name: 'Details: what was measured' })).toBeTruthy();
    expect(screen.getByText(/All normal so far/)).toBeTruthy();
    expect(screen.getByText('0 of 4 events')).toBeTruthy();
  });

  it('shows the story steps as icons, and the newest spelled out with its sentence, picture and measurements', () => {
    render(<RunDetails {...props} nowMs={32_500} />);
    const marks = within(screen.getByRole('region', { name: 'Details: what was measured' })).getAllByRole('button', { name: /^\d+ s: / });
    expect(marks.map((m) => m.getAttribute('aria-label'))).toEqual(['30 s: Database 8× slower', '31 s: The app server gives up, everyone asks again']);
    expect(marks[1].getAttribute('aria-current')).toBe('true');
    const focus = screen.getByRole('list', { name: 'Selected event' });
    expect(within(focus).getByText('The app server gives up, everyone asks again')).toBeTruthy();
    expect(within(focus).getByText(steps[1].text)).toBeTruthy();
    expect(focus.querySelectorAll('.csl-cascade__layer')).toHaveLength(2);
    // Measured in its stretch of the run (31–33 s), reached so far; the injected failure is the first step itself.
    expect(Array.from(focus.querySelectorAll('.csl-details__entry'), (e) => e.textContent)).toEqual(['31 s App server gives up on DB (1 s timeout)', '32 s Gateway gives up on App server']);
    expect(screen.getByText('2 more as the replay continues…')).toBeTruthy();
    expect(screen.getByText('during the failure')).toBeTruthy();
  });

  it('spells out the step pointed at', () => {
    render(<RunDetails {...props} nowMs={120_000} />);
    fireEvent.click(screen.getByRole('button', { name: '30 s: Database 8× slower' }));
    const focus = screen.getByRole('list', { name: 'Selected event' });
    expect(within(focus).getByText(steps[0].text)).toBeTruthy();
    expect(within(focus).queryByText('Measured')).toBeNull();
    // The verdict is labelled "end", and "at the end of the run" when spelled out.
    fireEvent.click(screen.getByRole('button', { name: 'at the end of the run: Still stuck' }));
    expect(within(screen.getByRole('list', { name: 'Selected event' })).getByText('at the end of the run')).toBeTruthy();
  });

  it('lists every step reached, each with its sentence and measurements', () => {
    render(<RunDetails {...props} nowMs={120_000} />);
    fireEvent.click(screen.getByRole('button', { name: 'List' }));
    const items = document.querySelectorAll('.csl-details__list > .csl-flow__step');
    expect(items).toHaveLength(4);
    expect(items[2].textContent).toContain('DB queue wait exceeds the App server timeout');
    expect(items[2].querySelector('.csl-meter')).not.toBeNull();
    expect(items[3].textContent).toContain('100% of DB work');
  });

  it('attaches each measurement to the step whose stretch it falls in, leaving out failure starts and ends', () => {
    const byStep = measuredBySteps(steps, entries, 120_000);
    expect(byStep.get(steps[0])).toBeUndefined();
    expect(byStep.get(steps[1])!.map((e) => e.tMs)).toEqual([31_000, 32_000]);
    expect(byStep.get(steps[2])!.map((e) => e.tMs)).toEqual([34_000]);
    expect(byStep.get(steps[3])!.map((e) => e.tMs)).toEqual([117_000]);
    // Anything before the first step goes with it; nothing without steps.
    expect(measuredBySteps(steps, [{ tMs: 1_000, text: 'early', kind: 'info' }], 120_000).get(steps[0])!.length).toBe(1);
    expect(measuredBySteps([], entries, 120_000).size).toBe(0);
  });
});
