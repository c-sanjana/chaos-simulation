import { fireEvent, render, screen, within } from '@testing-library/react';
import { RunComparison } from './RunComparison';

const comparison = {
  changes: ['App server → DB retries 1 → 5', 'Traffic 200 → 150 req/s', 'Gateway copies 2 → 3', 'Cache size 1000 → 2000'],
  rows: [
    { label: 'Failed requests', before: '12,561', now: '12,651', change: 'same', tone: 'same' as const, values: { before: 12_561, now: 12_651, max: 12_651 } },
    { label: 'Retries sent (all layers)', before: '110,742', now: '135,545', change: '+22%', tone: 'worse' as const, values: { before: 110_742, now: 135_545, max: 135_545 } },
    { label: 'App server workers busy after the failure', before: '100%', now: '40%', change: '-60 pts', tone: 'better' as const, values: { before: 1, now: 0.4, max: 1 } },
  ],
  takeaway: 'A lot changed inside the system, but users see about the same: it was stuck either way.',
};

describe('RunComparison', () => {
  it('shows what changed as chips, each result as a before → now dumbbell, and the takeaway', () => {
    const onDismiss = vi.fn();
    render(<RunComparison comparison={comparison} onDismiss={onDismiss} />);
    const panel = screen.getByRole('region', { name: 'Compared with your last run' });
    const chips = within(within(panel).getByRole('list', { name: 'What you changed' })).getAllByRole('listitem');
    expect(chips.map((c) => c.textContent)).toEqual(['App server → DB retries 1 → 5', 'Traffic 200 → 150 req/s', 'Gateway copies 2 → 3', '+1 more']);

    const bells = panel.querySelectorAll('.csl-dumbbell');
    expect(bells).toHaveLength(3);
    expect(bells[1].querySelector('.csl-dumbbell__change')!.textContent).toBe('▲ +22%');
    expect(bells[1].querySelector('.csl-dumbbell__change')!.className).toContain('--worse');
    expect(bells[2].querySelector('.csl-dumbbell__change')!.textContent).toBe('▼ -60 pts');
    expect(bells[2].querySelector('.csl-dumbbell__change')!.className).toContain('--better');
    const dots = bells[2].querySelectorAll<HTMLElement>('.csl-dumbbell__dot');
    expect([dots[0].style.left, dots[1].style.left]).toEqual(['100%', '40%']);
    const span = bells[2].querySelector<HTMLElement>('.csl-dumbbell__span')!;
    expect([span.style.left, span.style.width]).toEqual(['40%', '60%']);
    expect(bells[0].querySelector('.csl-dumbbell__values')!.textContent).toBe('12,561 → 12,651');

    // The exact numbers in a table for screen readers.
    const rows = within(panel).getAllByRole('row');
    expect(within(panel).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Measure', 'Before', 'Now', 'Change']);
    expect(rows.map((r) => r.textContent)).toEqual(['MeasureBeforeNowChange', 'Failed requests12,56112,651same', 'Retries sent (all layers)110,742135,545+22%', 'App server workers busy after the failure100%40%-60 pts']);
    expect(within(panel).getByText(comparison.takeaway)).toBeTruthy();
    expect(panel.querySelector('.csl-compare__takeaway-icon')!.textContent).toBe('ⓘ');
    fireEvent.click(within(panel).getByRole('button', { name: 'Dismiss the comparison' }));
    expect(onDismiss).toHaveBeenCalled();
  });

  it('shows a changed outcome first, with a ✓ when it now recovers', () => {
    const outcome = { label: 'Outcome', before: 'Stuck', now: 'Recovered in 4 s', change: 'recovers now', tone: 'better' as const };
    render(<RunComparison comparison={{ ...comparison, changes: ['App server → DB retries 5 → 1'], rows: [outcome, ...comparison.rows], takeaway: 'This change made the system recover.' }} onDismiss={() => {}} />);
    expect(screen.getAllByRole('listitem').map((c) => c.textContent)).toEqual(['App server → DB retries 5 → 1']);
    const line = document.querySelector('.csl-compare__outcome')!;
    expect(line.className).toContain('--better');
    expect(line.textContent).toBe('Stuck →to Recovered in 4 s');
    expect(document.querySelector('.csl-compare__takeaway-icon')!.textContent).toBe('✓');
    expect(document.querySelectorAll('.csl-dumbbell')).toHaveLength(3); // the outcome has no dumbbell
  });

  it('marks a worse outcome with ✕, and a zero scale stays at the start', () => {
    const outcome = { label: 'Outcome', before: 'Recovered in 4 s', now: 'Stuck', change: 'stuck now', tone: 'worse' as const };
    const zero = { label: 'Failed requests', before: '0', now: '0', change: 'same', tone: 'same' as const, values: { before: 0, now: 0, max: 0 } };
    render(<RunComparison comparison={{ ...comparison, rows: [outcome, zero] }} onDismiss={() => {}} />);
    expect(document.querySelector('.csl-compare__takeaway-icon')!.textContent).toBe('✕');
    expect(document.querySelector('.csl-dumbbell__change')!.textContent).toBe('= same');
    expect(document.querySelector<HTMLElement>('.csl-dumbbell__dot')!.style.left).toBe('0%');
  });
});
