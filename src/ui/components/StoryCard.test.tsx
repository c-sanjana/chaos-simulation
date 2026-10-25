import { render } from '@testing-library/react';
import { Cascade, Meter, stepTime } from './StoryCard';

describe('story pieces', () => {
  it('labels a "still stuck" verdict "at the end of the run", not with a time that looks like an event', () => {
    expect(stepTime({ tMs: 98_900, kind: 'stuck' })).toBe('at the end of the run');
    expect(stepTime({ tMs: 0, kind: 'stuck' })).toBe('0 s'); // "too much traffic anyway" is known from the start
    expect(stepTime({ tMs: 31_000, kind: 'giveup' })).toBe('31 s');
  });

  it('draws an overload as a meter against capacity, full beyond 5×', () => {
    const { rerender } = render(<Meter value={1.6} />);
    const fill = document.querySelector('.csl-meter__fill') as HTMLElement;
    expect(fill.style.width).toBe('32%');
    expect(fill.className).toContain('csl-meter__fill--over');
    rerender(<Meter value={9} />);
    expect((document.querySelector('.csl-meter__fill') as HTMLElement).style.width).toBe('100%');
    rerender(<Meter value={0.5} />);
    expect(document.querySelector('.csl-meter__fill')!.className).not.toContain('--over');
  });

  it('draws the cascade as one row of blocks per layer, capped, with the count beside it', () => {
    render(<Cascade layers={[{ who: "users' apps", retries: 5 }, { who: 'the API', retries: 12 }]} />);
    const layers = document.querySelectorAll('.csl-cascade__layer');
    expect(Array.from(layers, (l) => l.querySelector('.csl-cascade__who')!.textContent)).toEqual(["users' apps", 'the API']);
    expect(Array.from(layers, (l) => l.querySelectorAll('.csl-cascade__block').length)).toEqual([5, 8]);
    expect(layers[1].querySelector('.csl-cascade__n')!.textContent).toBe('12×');
  });
});
