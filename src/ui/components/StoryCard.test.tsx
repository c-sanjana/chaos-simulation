import { render, screen } from '@testing-library/react';
import { StoryCard, type StoryStepView } from './StoryCard';

const steps: StoryStepView[] = [
  { tMs: 30_000, text: 'At 30 s the database became 8× slower.', tone: 'fault' },
  { tMs: 31_000, text: 'The API gives up after 1 s and asks again.', tone: 'info' },
  { tMs: 117_000, text: 'It never recovered.', tone: 'bad' },
];

describe('StoryCard', () => {
  it('starts with a calm note before anything happens', () => {
    render(<StoryCard steps={steps} nowMs={5_000} />);
    expect(screen.getByText(/Everything is normal so far/)).toBeTruthy();
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('reveals numbered steps oldest first as the replay reaches them, highlighting the latest', () => {
    const { rerender } = render(<StoryCard steps={steps} nowMs={31_500} />);
    let items = screen.getAllByRole('listitem');
    expect(items.map((li) => li.textContent)).toEqual([steps[0].text, steps[1].text]);
    expect(items[1].className).toContain('csl-story__step--latest');
    expect(items[0].className).toContain('csl-story__step--fault');
    expect(screen.getByText('More as the replay continues…')).toBeTruthy();
    rerender(<StoryCard steps={steps} nowMs={120_000} />);
    items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(screen.queryByText(/More as the replay/)).toBeNull();
  });
});
