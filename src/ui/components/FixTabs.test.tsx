import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { FixTabs, tabLabel, type FixTab } from './FixTabs';

const tab = (over: Partial<FixTab>): FixTab => ({
  id: 'retry-budget',
  short: 'Retry budget',
  name: 'Retry budget of 10%',
  what: 'API stops retrying DB once retries reach 10% of first attempts.',
  how: 'Repeats stop piling up, so the database can catch up.',
  why: "Retries made up 74% of DB's load.",
  result: 'Stuck → recovers in 3 s',
  where: 'at your settings (200 req/s · 3 DB retries)',
  failed: '40 failed requests instead of 12,687',
  checks: ['helped in 5 of 5 random runs', 'still helps if the slowdown lasts 10 s'],
  badge: '3 s',
  status: 'reliable',
  pros: ['Stops retries from multiplying load', 'Cheap: a client setting, no new servers'],
  cons: ['Callers see errors sooner during a real outage', 'The calling code must count its retries', 'A third con'],
  ...over,
});
const tabs = [
  tab({}),
  tab({ id: 'cap-retries', short: 'Cap retries', name: 'Cap retries at 1', badge: '13 s', status: 'unreliable', result: 'Stuck → recovers in 13 s' }),
  tab({ id: 'jitter', short: 'Jitter', name: 'Exponential backoff with full jitter', result: 'No improvement: still stuck', badge: '', status: 'no', checks: [] }),
];

describe('FixTabs', () => {
  it('names each tab with its outcome, marking fixes that help only sometimes', () => {
    render(<FixTabs tabs={tabs} selectedId={null} onSelect={() => {}} />);
    const [first, second, third] = screen.getAllByRole('tab');
    expect(first.getAttribute('aria-selected')).toBe('true'); // defaults to the first (best) fix
    expect(first.textContent).toBe('✓Retry budget3 s');
    expect(first.getAttribute('aria-label')).toBe('Retry budget: helped, back to normal 3 s after the failure ended');
    expect(second.textContent).toBe('⚠Cap retries13 s');
    expect(second.getAttribute('aria-label')).toBe('Cap retries: helped only sometimes, back to normal 13 s after the failure ended');
    expect(third.textContent).toBe('✕Jitter');
    expect(third.getAttribute('aria-label')).toBe('Jitter: did not help');
    expect(tabLabel(tab({ status: 'checking', badge: '' }))).toBe('Retry budget: helped (checking whether it holds up)');
  });

  it("explains the selected fix in labelled parts: what, how, why and the result where it was measured", () => {
    render(<FixTabs tabs={tabs} selectedId={null} onSelect={() => {}} />);
    const panel = screen.getByRole('tabpanel');
    expect(panel.getAttribute('aria-labelledby')).toBe('fix-tab-retry-budget');
    expect(within(panel).getByRole('heading', { name: 'Retry budget of 10%' })).toBeTruthy();
    expect(within(panel).getByText('Shown in the replay')).toBeTruthy();
    expect(within(panel).getByText('How it helps').nextElementSibling!.textContent).toBe('Repeats stop piling up, so the database can catch up.');
    expect(within(panel).getByText('Why try it').nextElementSibling!.textContent).toBe("Retries made up 74% of DB's load.");
    const result = within(panel).getByText('Result').nextElementSibling!;
    expect(result.textContent).toBe(
      'Stuck → recovers in 3 s at your settings (200 req/s · 3 DB retries)40 failed requests instead of 12,687 · helped in 5 of 5 random runs · still helps if the slowdown lasts 10 s',
    );
    expect(result.querySelector('b')!.className).toBe('csl-fixtabs__good');
  });

  it('lists pros and cons with their counts, so several cons are never missed', () => {
    render(<FixTabs tabs={tabs} selectedId={null} onSelect={() => {}} />);
    expect(within(screen.getByRole('region', { name: 'Pros' })).getByRole('heading').textContent).toBe('Pros (2)');
    const cons = screen.getByRole('region', { name: 'Cons' });
    expect(within(cons).getByRole('heading').textContent).toBe('Cons (3)');
    expect(within(cons).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      '−Callers see errors sooner during a real outage',
      '−The calling code must count its retries',
      '−A third con',
    ]);
  });

  it('shows the chosen fix, colouring its result by whether it helped reliably', () => {
    const onSelect = vi.fn();
    const { rerender } = render(<FixTabs tabs={tabs} selectedId="jitter" onSelect={onSelect} />);
    expect(within(screen.getByRole('tabpanel')).getByText('No improvement: still stuck').className).toBe('csl-fixtabs__bad');
    fireEvent.click(screen.getAllByRole('tab')[1]);
    expect(onSelect).toHaveBeenCalledWith('cap-retries');
    rerender(<FixTabs tabs={tabs} selectedId="cap-retries" onSelect={onSelect} />);
    expect(screen.getAllByRole('tab')[1].getAttribute('aria-selected')).toBe('true');
    expect(within(screen.getByRole('tabpanel')).getByText('Stuck → recovers in 13 s').className).toBe('csl-fixtabs__warn');
  });

  it('renders nothing when there are no fixes (the step explains why)', () => {
    const { container } = render(<FixTabs tabs={[]} selectedId={null} onSelect={() => {}} />);
    expect(container.innerHTML).toBe('');
  });
});

describe('FixTabs keyboard', () => {
  it('is one tab stop; ←/→/Home/End move focus (wrapping) and Enter or a click chooses', () => {
    const onSelect = vi.fn();
    render(<FixTabs tabs={tabs} selectedId="cap-retries" onSelect={onSelect} />);
    const all = screen.getAllByRole('tab');
    expect(all.map((t) => t.tabIndex)).toEqual([-1, 0, -1]);
    act(() => all[1].focus());
    fireEvent.keyDown(all[1], { key: 'ArrowRight' });
    expect(document.activeElement).toBe(all[2]);
    expect(all.map((t) => t.tabIndex)).toEqual([-1, -1, 0]);
    fireEvent.keyDown(all[2], { key: 'ArrowRight' }); // wraps
    expect(document.activeElement).toBe(all[0]);
    fireEvent.keyDown(all[0], { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(all[2]);
    fireEvent.keyDown(all[2], { key: 'Home' });
    expect(document.activeElement).toBe(all[0]);
    fireEvent.keyDown(all[0], { key: 'End' });
    expect(document.activeElement).toBe(all[2]);
    fireEvent.keyDown(all[2], { key: 'x' });
    expect(document.activeElement).toBe(all[2]);
    // Moving focus doesn't choose (choosing re-simulates); Enter/Space click the focused tab.
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.click(all[2]);
    expect(onSelect).toHaveBeenCalledWith('jitter');
  });

  it('puts the tab stop back on the chosen tab when focus leaves the list, and the panel is focusable', () => {
    render(
      <>
        <FixTabs tabs={tabs} selectedId="retry-budget" onSelect={() => {}} />
        <button type="button">after</button>
      </>,
    );
    const all = screen.getAllByRole('tab');
    act(() => all[0].focus());
    fireEvent.keyDown(all[0], { key: 'ArrowRight' });
    expect(all[1].tabIndex).toBe(0);
    fireEvent.blur(all[1], { relatedTarget: screen.getByRole('button', { name: 'after' }) });
    expect(all.map((t) => t.tabIndex)).toEqual([0, -1, -1]);
    expect(screen.getByRole('tabpanel').tabIndex).toBe(0);
  });
});
