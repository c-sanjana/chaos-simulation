import { fireEvent, render, screen } from '@testing-library/react';
import { StoryCard, stepTime, type StoryStepView } from './StoryCard';

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
      { who: 'the API', retries: 12 },
    ],
  },
  { tMs: 33_000, text: 'The database got 1.6× what it can handle.', tone: 'bad', kind: 'overload', headline: 'Database swamped', figure: '1.6×', meter: 1.6 },
  { tMs: 117_000, text: 'It never recovered.', tone: 'bad' },
];

describe('StoryCard', () => {
  it('starts with a calm note before anything happens', () => {
    render(<StoryCard steps={steps} nowMs={5_000} />);
    expect(screen.getByRole('heading', { name: "What's happening" })).toBeTruthy();
    expect(screen.getByText(/All normal so far/)).toBeTruthy();
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('reveals steps oldest first as a flow of icons, a few words and the key number, highlighting the latest', () => {
    const { rerender } = render(<StoryCard steps={steps} nowMs={31_500} />);
    let items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0].title).toBe(steps[0].text); // the full sentence is the tooltip…
    expect(items[0].querySelector('.csl-sr-only')!.textContent).toBe(steps[0].text); // …and what screen readers read
    expect(items[0].querySelector('.csl-flow__icon')!.textContent).toBe('⚡');
    expect(items[0].querySelector('.csl-flow__headline')!.textContent).toBe('Database 8× slower');
    expect(items[0].querySelector('.csl-flow__figure')!.textContent).toBe('5 s');
    expect(items[0].querySelector('.csl-flow__time')!.textContent).toBe('30 s');
    expect(items[0].className).toContain('csl-flow__step--fault');
    expect(items[1].className).toContain('csl-flow__step--latest');
    expect(screen.getByText('2 more as the replay continues…')).toBeTruthy();

    // The cascade: one row of blocks per layer, capped, with the count beside it.
    const layers = items[1].querySelectorAll('.csl-cascade__layer');
    expect(Array.from(layers, (l) => l.querySelector('.csl-cascade__who')!.textContent)).toEqual(["users' apps", 'the API']);
    expect(Array.from(layers, (l) => l.querySelectorAll('.csl-cascade__block').length)).toEqual([5, 8]);
    expect(layers[1].querySelector('.csl-cascade__n')!.textContent).toBe('12×');

    rerender(<StoryCard steps={steps} nowMs={120_000} />);
    items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(4);
    expect(screen.queryByText(/more as the replay/)).toBeNull();
    // A step without a headline shows its sentence, with the plain icon.
    expect(items[3].querySelector('.csl-flow__headline')!.textContent).toBe('It never recovered.');
    expect(items[3].querySelector('.csl-flow__icon')!.textContent).toBe('•');
  });

  it('shows the newest step’s explanation, and older ones on a visible "Why?"', () => {
    render(<StoryCard steps={steps} nowMs={33_500} />);
    const items = screen.getAllByRole('listitem');
    // The newest row spells out its sentence (not only in a tooltip).
    expect(items[2].querySelector('.csl-flow__text')!.textContent).toBe(steps[2].text);
    expect(items[0].querySelector('.csl-flow__text')).toBeNull();
    const why = screen.getByRole('button', { name: 'Why: Database 8× slower' });
    expect(why.textContent).toBe('Why?');
    expect(why.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(why);
    expect(items[0].querySelector('.csl-flow__text')!.textContent).toBe(steps[0].text);
    expect(why.textContent).toBe('Hide');
    fireEvent.click(why);
    expect(items[0].querySelector('.csl-flow__text')).toBeNull();
  });

  it('labels a "still stuck" verdict "at the end of the run", not with a time that looks like an event', () => {
    expect(stepTime({ tMs: 98_900, kind: 'stuck' })).toBe('at the end of the run');
    expect(stepTime({ tMs: 0, kind: 'stuck' })).toBe('0 s'); // "too much traffic anyway" is known from the start
    expect(stepTime({ tMs: 31_000, kind: 'giveup' })).toBe('31 s');
  });

  it('compact: only the newest step, spelled out, with a way to see the earlier ones', () => {
    render(<StoryCard steps={steps} nowMs={40_000} compact />);
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByText(steps[2].text, { selector: '.csl-flow__text' })).toBeTruthy();
    const more = screen.getByRole('button', { name: 'Show the 2 earlier steps' });
    fireEvent.click(more);
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: 'Show only the newest step' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
  });

  it('draws an overload as a meter against capacity, full beyond 5×', () => {
    const { rerender } = render(<StoryCard steps={[steps[2]]} nowMs={40_000} />);
    const fill = document.querySelector('.csl-meter__fill') as HTMLElement;
    expect(fill.style.width).toBe('32%');
    expect(fill.className).toContain('csl-meter__fill--over');
    expect(screen.getByText('capacity')).toBeTruthy();
    rerender(<StoryCard steps={[{ ...steps[2], meter: 9 }]} nowMs={40_000} />);
    expect((document.querySelector('.csl-meter__fill') as HTMLElement).style.width).toBe('100%');
    rerender(<StoryCard steps={[{ ...steps[2], meter: 0.5 }]} nowMs={40_000} />);
    expect(document.querySelector('.csl-meter__fill')!.className).not.toContain('--over');
  });
});
