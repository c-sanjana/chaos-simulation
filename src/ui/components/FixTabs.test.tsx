import { fireEvent, render, screen, within } from '@testing-library/react';
import { FixTabs, type FixTab } from './FixTabs';

const tab = (over: Partial<FixTab>): FixTab => ({
  id: 'retry-budget',
  short: 'Retry budget',
  name: 'Retry budget of 10%',
  what: 'API stops retrying DB once retries reach 10% of first attempts.',
  why: "Retries made up 74% of DB's load.",
  result: 'Stuck → recovers in 3 s',
  failed: '40 failed requests instead of 12,687',
  seeds: 'helped on 5 of 5 random seeds',
  badge: '3s',
  helped: true,
  pros: ['Stops retries from multiplying load', 'Cheap: a client setting, no new servers'],
  cons: ['Callers see errors sooner during a real outage', 'Needs retry accounting in the client', 'A third con'],
  ...over,
});
const tabs = [tab({}), tab({ id: 'jitter', short: 'Jitter', name: 'Exponential backoff with full jitter', result: 'Stuck → stuck', badge: '', helped: false, seeds: '' })];

describe('FixTabs', () => {
  it("shows one tab per fix and the selected one's details in labelled parts", () => {
    render(<FixTabs tabs={tabs} selectedId={null} onSelect={() => {}} appliedId={null} onApply={() => {}} />);
    const [first, second] = screen.getAllByRole('tab');
    expect(first.getAttribute('aria-selected')).toBe('true'); // defaults to the first (best) fix
    expect(first.textContent).toBe('✓Retry budget3s');
    expect(second.textContent).toBe('✕Jitter'); // no badge
    expect(second.className).toContain('csl-fixtab--no');
    const panel = screen.getByRole('tabpanel');
    expect(panel.getAttribute('aria-labelledby')).toBe('fix-tab-retry-budget');
    expect(within(panel).getByRole('heading', { name: 'Retry budget of 10%' })).toBeTruthy();
    expect(within(panel).getByText('API stops retrying DB once retries reach 10% of first attempts.')).toBeTruthy();
    expect(within(panel).getByText('Why try it').nextElementSibling!.textContent).toBe("Retries made up 74% of DB's load.");
    const result = within(panel).getByText('Result').nextElementSibling!;
    expect(result.textContent).toBe('Stuck → recovers in 3 s40 failed requests instead of 12,687 · helped on 5 of 5 random seeds');
    expect(result.querySelector('b')!.className).toBe('csl-fixtabs__good');
  });

  it('lists pros and cons with their counts, so several cons are never missed', () => {
    render(<FixTabs tabs={tabs} selectedId={null} onSelect={() => {}} appliedId={null} onApply={() => {}} />);
    const pros = screen.getByRole('region', { name: 'Pros' });
    const cons = screen.getByRole('region', { name: 'Cons' });
    expect(within(pros).getByRole('heading').textContent).toBe('Pros (2)');
    expect(within(cons).getByRole('heading').textContent).toBe('Cons (3)');
    expect(within(cons).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      '−Callers see errors sooner during a real outage',
      '−Needs retry accounting in the client',
      '−A third con',
    ]);
    expect(within(pros).getAllByRole('listitem')[0].textContent).toBe('+Stops retries from multiplying load');
  });

  it('selects a tab, applies it, and un-applies it', () => {
    const onSelect = vi.fn();
    const onApply = vi.fn();
    const { rerender } = render(<FixTabs tabs={tabs} selectedId="jitter" onSelect={onSelect} appliedId={null} onApply={onApply} />);
    const panel = screen.getByRole('tabpanel');
    expect(panel.textContent).not.toContain('seeds'); // not checked for a fix that did not help
    expect(within(panel).getByText('Stuck → stuck').className).toBe('csl-fixtabs__bad');
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
