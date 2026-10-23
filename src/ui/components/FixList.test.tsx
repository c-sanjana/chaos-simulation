import { fireEvent, render, screen, within } from '@testing-library/react';
import { FixList, failedToggleLabel } from './FixList';
import type { FixView } from './types';

const fixes: FixView[] = [
  {
    id: 'budget',
    title: 'Cap retries with a budget (10% of traffic)',
    why: 'retries were 76% of DB load',
    result: 'Stuck → recovers in 12 s',
    seeds: '5 of 5 seeds',
    affected: '1,140 requests affected (was 21,400)',
    caveat: 'Assumes every caller honours the budget.',
  },
  {
    id: 'shed',
    title: 'Bound the API queue to 200 (shed load)',
    why: 'the API queue held 2.4 s of work against a 1 s timeout',
    result: 'Stuck → recovers in 14 s',
    seeds: '5 of 5 seeds',
    affected: '2,310 affected, 640 rejected fast',
    caveat: 'Assumes users do not immediately retry rejected requests.',
  },
];
const failed = [
  { title: 'Raise the API timeout to 3 s', result: 'Still stuck in 5 of 5 seeds' },
  { title: 'Add 2 API instances', result: 'Still stuck in 4 of 5 seeds' },
];

describe('failedToggleLabel', () => {
  it('counts the fixes, singular and plural, and offers to hide when open', () => {
    expect(failedToggleLabel(2, false)).toBe('2 more fixes tried that did not help ▸');
    expect(failedToggleLabel(1, false)).toBe('1 more fix tried that did not help ▸');
    expect(failedToggleLabel(2, true)).toBe('Hide fixes that did not help');
  });
});

describe('FixList', () => {
  it('lists fixes in rank order with reason, result, seeds and affected count', () => {
    render(<FixList fixes={fixes} appliedId={null} onApply={() => {}} failed={failed} />);
    const items = within(screen.getAllByRole('list')[0]).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(within(items[0]).getByText('1')).toBeTruthy();
    expect(within(items[0]).getByText(fixes[0].title)).toBeTruthy();
    expect(within(items[0]).getByText('Suggested because retries were 76% of DB load')).toBeTruthy();
    expect(within(items[0]).getByText('Stuck → recovers in 12 s')).toBeTruthy();
    expect(within(items[0]).getByText('5 of 5 seeds · 1,140 requests affected (was 21,400)')).toBeTruthy();
    expect(within(items[1]).getByText('2')).toBeTruthy();
  });

  it('toggles each caveat independently', () => {
    render(<FixList fixes={fixes} appliedId={null} onApply={() => {}} failed={[]} />);
    const btn = screen.getByRole('button', { name: `Caveat for ${fixes[0].title}` });
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText(/Caveat: /)).toBeNull();
    fireEvent.click(btn);
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    const caveat = screen.getByText('Caveat: Assumes every caller honours the budget.');
    expect(btn.getAttribute('aria-controls')).toBe(caveat.id);
    expect(screen.getByRole('button', { name: `Caveat for ${fixes[1].title}` }).getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(btn);
    expect(screen.queryByText(/Caveat: /)).toBeNull();
  });

  it('applies a fix, and un-applies it when the applied fix is clicked again', () => {
    const onApply = vi.fn();
    const { rerender } = render(<FixList fixes={fixes} appliedId={null} onApply={onApply} failed={[]} />);
    fireEvent.click(screen.getByRole('button', { name: `Apply & compare: ${fixes[1].title}` }));
    expect(onApply).toHaveBeenLastCalledWith('shed');
    rerender(<FixList fixes={fixes} appliedId="shed" onApply={onApply} failed={[]} />);
    const applied = screen.getByRole('button', { name: `Applied: ${fixes[1].title}` });
    expect(applied.textContent).toBe('Applied');
    expect(applied.closest('li')!.className).toContain('csl-fix--applied');
    fireEvent.click(applied);
    expect(onApply).toHaveBeenLastCalledWith(null);
  });

  it('keeps fixes that did not help collapsed until asked', () => {
    render(<FixList fixes={fixes} appliedId={null} onApply={() => {}} failed={failed} />);
    const toggle = screen.getByRole('button', { name: '2 more fixes tried that did not help ▸' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Add 2 API instances')).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.textContent).toBe('Hide fixes that did not help');
    expect(screen.getByText('Add 2 API instances')).toBeTruthy();
    expect(screen.getByText('Still stuck in 4 of 5 seeds')).toBeTruthy();
  });

  it('handles no helpful fixes and no failed fixes', () => {
    render(<FixList fixes={[]} appliedId={null} onApply={() => {}} failed={[]} />);
    expect(screen.getByText('None of the fixes tried made this run recover.')).toBeTruthy();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });
});
