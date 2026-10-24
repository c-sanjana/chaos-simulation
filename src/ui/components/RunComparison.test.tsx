import { fireEvent, render, screen, within } from '@testing-library/react';
import { RunComparison } from './RunComparison';

const comparison = {
  changes: ['API → DB retries 1 → 5', 'Traffic 200 → 150 req/s', 'Gateway servers 2 → 3'],
  rows: [
    { label: 'Failed requests', before: '12,561', now: '12,651', change: 'same', tone: 'same' as const },
    { label: 'Retries sent (all layers)', before: '110,742', now: '135,545', change: '+22%', tone: 'worse' as const },
    { label: 'API workers busy after the failure', before: '100%', now: '40%', change: '-60 pts', tone: 'better' as const },
  ],
  takeaway: 'A lot changed inside the system, but users see about the same: it was stuck either way.',
};

describe('RunComparison', () => {
  it('shows what changed (the first two, then a count), the results before and now, and the takeaway', () => {
    const onDismiss = vi.fn();
    render(<RunComparison comparison={comparison} onDismiss={onDismiss} />);
    const panel = screen.getByRole('region', { name: 'Compared with your last run' });
    expect(within(panel).getByText('You changed: API → DB retries 1 → 5; Traffic 200 → 150 req/s and 1 more')).toBeTruthy();
    const rows = within(panel).getAllByRole('row').slice(1);
    expect(rows.map((r) => r.textContent)).toEqual(['Failed requests12,56112,651same', 'Retries sent (all layers)110,742135,545+22%', 'API workers busy after the failure100%40%-60 pts']);
    expect(rows[1].lastElementChild!.className).toContain('--worse');
    expect(rows[2].lastElementChild!.className).toContain('--better');
    expect(within(panel).getByText(comparison.takeaway)).toBeTruthy();
    fireEvent.click(within(panel).getByRole('button', { name: 'Dismiss the comparison' }));
    expect(onDismiss).toHaveBeenCalled();
  });

  it('lists every change when there are only one or two', () => {
    render(<RunComparison comparison={{ ...comparison, changes: ['API → DB retries 1 → 5'] }} onDismiss={() => {}} />);
    expect(screen.getByText('You changed: API → DB retries 1 → 5')).toBeTruthy();
  });
});
