import { fireEvent, render, screen } from '@testing-library/react';
import { FixTabs, type FixTab } from './FixTabs';

const tab = (over: Partial<FixTab>): FixTab => ({
  id: 'retry-budget',
  short: 'Retry budget',
  title: 'Retry budget of 10%: API → DB',
  why: 'retries were 74% of DB load',
  result: 'Stuck → recovers in 3 s',
  badge: '3 s',
  helped: true,
  seeds: 'helps in 5 of 5 seeds',
  affected: '40 failed requests (was 12,687)',
  caveat: 'Some requests fail fast instead of retrying.',
  ...over,
});
const tabs = [tab({}), tab({ id: 'jitter', short: 'Jitter', title: 'Jitter on retries', badge: '', helped: false, seeds: '' })];

describe('FixTabs', () => {
  it('shows one tab per fix and the selected one\'s details', () => {
    render(<FixTabs tabs={tabs} selectedId={null} onSelect={() => {}} appliedId={null} onApply={() => {}} />);
    const [first, second] = screen.getAllByRole('tab');
    expect(first.getAttribute('aria-selected')).toBe('true'); // defaults to the first (best) fix
    expect(first.textContent).toBe('✓Retry budget3 s');
    expect(second.textContent).toBe('✕Jitter'); // no badge
    expect(second.className).toContain('csl-fixtab--no');
    const panel = screen.getByRole('tabpanel');
    expect(panel.getAttribute('aria-labelledby')).toBe('fix-tab-retry-budget');
    expect(panel.textContent).toContain('Suggested because retries were 74% of DB load');
    expect(panel.textContent).toContain('helps in 5 of 5 seeds');
    expect(panel.textContent).toContain('Caveat: Some requests fail fast');
  });

  it('selects a tab, applies it, and un-applies it', () => {
    const onSelect = vi.fn();
    const onApply = vi.fn();
    const { rerender } = render(<FixTabs tabs={tabs} selectedId="jitter" onSelect={onSelect} appliedId={null} onApply={onApply} />);
    expect(screen.getByRole('tabpanel').textContent).not.toContain('seeds');
    fireEvent.click(screen.getAllByRole('tab')[0]);
    expect(onSelect).toHaveBeenCalledWith('retry-budget');
    fireEvent.click(screen.getByRole('button', { name: 'Apply & compare' }));
    expect(onApply).toHaveBeenCalledWith('jitter');
    rerender(<FixTabs tabs={tabs} selectedId="jitter" onSelect={onSelect} appliedId="jitter" onApply={onApply} />);
    const comparing = screen.getByRole('button', { name: 'Comparing' });
    expect(comparing.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getAllByRole('tab')[1].className).toContain('csl-fixtab--applied');
    fireEvent.click(comparing);
    expect(onApply).toHaveBeenLastCalledWith(null);
  });

  it('says so when there are no fixes', () => {
    render(<FixTabs tabs={[]} selectedId={null} onSelect={() => {}} appliedId={null} onApply={() => {}} />);
    expect(screen.getByText('No fixes to try for this run.')).toBeTruthy();
  });
});
