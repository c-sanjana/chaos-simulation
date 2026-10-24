import { render, screen } from '@testing-library/react';
import { StoryCard, type StoryStepView } from './StoryCard';

const steps: StoryStepView[] = [
  { tMs: 30_000, text: 'At 30 s the database became 8× slower.', tone: 'fault', kind: 'fault', headline: 'Database 8× slower', figure: '5 s' },
  {
    tMs: 31_000,
    text: 'The API gives up after 1 s and everyone asks again.',
    tone: 'info',
    kind: 'giveup',
    headline: 'The API gives up, everyone asks again',
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
