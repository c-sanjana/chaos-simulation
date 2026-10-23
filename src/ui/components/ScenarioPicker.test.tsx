import { fireEvent, render, screen } from '@testing-library/react';
import { ScenarioPicker } from './ScenarioPicker';

const scenarios = [
  { id: 'retry', title: 'Retry storm', blurb: 'A short DB slowdown; retries pile up at every layer.' },
  { id: 'db', title: 'Database slow or dead', blurb: 'Slow is often worse than down.' },
];

describe('ScenarioPicker', () => {
  it('renders a pressed card for the selected scenario and reports clicks', () => {
    const onSelect = vi.fn();
    render(<ScenarioPicker scenarios={scenarios} selected="retry" onSelect={onSelect} />);
    expect(screen.getByRole('group', { name: 'Scenario' })).toBeTruthy();
    const retry = screen.getByRole('button', { name: /Retry storm/ });
    expect(retry.getAttribute('aria-pressed')).toBe('true');
    expect(retry.textContent).toContain('retries pile up');
    const db = screen.getByRole('button', { name: /Database slow or dead/ });
    expect(db.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(db);
    expect(onSelect).toHaveBeenCalledWith('db');
  });
});
