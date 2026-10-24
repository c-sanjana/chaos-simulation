import { fireEvent, render, screen, within } from '@testing-library/react';
import { FixTabs, rankedFirstReason, tabLabel, type FixTab } from './FixTabs';

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
  recoverySeconds: 3,
  failedCount: 40,
  pros: ['Stops retries from multiplying load', 'Cheap: a client setting, no new servers'],
  cons: ['Callers see errors sooner during a real outage', 'The calling code must count its retries', 'A third con'],
  ...over,
});
const tabs = [
  tab({}),
  tab({ id: 'cap-retries', short: 'Cap retries', name: 'Cap retries at 1', badge: '13 s', status: 'unreliable', result: 'Stuck → recovers in 13 s', recoverySeconds: 13 }),
  tab({ id: 'jitter', short: 'Jitter', name: 'Exponential backoff with full jitter', result: 'No improvement: still stuck', badge: '', status: 'no', checks: [], recoverySeconds: null }),
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
    expect(within(panel).getByText('Shown on the right')).toBeTruthy();
    expect(within(panel).getByText('How it works').nextElementSibling!.textContent).toBe('Repeats stop piling up, so the database can catch up.');
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

  it('explains its marks and numbers on screen, and why the first fix is first', () => {
    render(<FixTabs tabs={tabs} selectedId={null} onSelect={() => {}} />);
    expect(document.getElementById('fix-tabs-key')!.textContent).toBe("✓ held up in the checks⚠ helped only sometimes✕ didn't help (or only by luck)12 s = time to recover after the failure ended");
    expect(screen.getByRole('tablist').getAttribute('aria-describedby')).toBe('fix-tabs-key');
    const panel = screen.getByRole('tabpanel');
    expect(within(panel).getByText("Why it's ranked first").nextElementSibling!.textContent).toBe('It held up in the checks; Cap retries helped only sometimes.');
  });

  it("shows the run's own reason it worked or didn't, and the rank reason only on the first fix", () => {
    const verdict = { title: "Why it didn't help here", text: "Users' apps (5×) still retry, so the database still had up to 3.2× the work it can handle." };
    const { rerender } = render(<FixTabs tabs={[tabs[0], { ...tabs[2], verdict }]} selectedId="jitter" onSelect={() => {}} />);
    const panel = screen.getByRole('tabpanel');
    expect(within(panel).getByText("Why it didn't help here").nextElementSibling!.textContent).toBe(verdict.text);
    expect(within(panel).queryByText("Why it's ranked first")).toBeNull();
    rerender(<FixTabs tabs={[tab({ status: 'rare', badge: '2 s' })]} selectedId={null} onSelect={() => {}} />);
    const rare = screen.getByRole('tab');
    expect(rare.textContent).toMatch(/^✕/); // helped once in five: luck, marked like no help
    expect(rare.className).toContain('csl-fixtab--rare');
    expect(rare.getAttribute('aria-label')).toBe('Retry budget: helped only by luck, back to normal 2 s after the failure ended');
    expect(within(screen.getByRole('tabpanel')).getByText('Stuck → recovers in 3 s').className).toBe('csl-fixtabs__bad');
  });
});

describe('rankedFirstReason', () => {
  const a = tab({ id: 'a', short: 'A' });
  it('names the key that puts the first fix ahead of the runner-up', () => {
    expect(rankedFirstReason([a])).toBe('It is the only fix that held up here.');
    expect(rankedFirstReason([tab({ status: 'unreliable' }), tab({ status: 'no' })])).toBe('It is the only fix that helped at all, though only sometimes.');
    expect(rankedFirstReason([a, tab({ short: 'B', status: 'rare' })])).toBe('It is the only fix that held up here.');
    expect(rankedFirstReason([a, tab({ short: 'B', recoverySeconds: 9 })])).toBe('It got back to normal soonest: 3 s after the failure ended, against 9 s for B.');
    expect(rankedFirstReason([a, tab({ short: 'B', recoverySeconds: null })])).toBe('It got back to normal soonest: 3 s after the failure ended, against never for B.');
    expect(rankedFirstReason([a, tab({ short: 'B', recoverySeconds: 4, failedCount: 1200 })])).toBe('It got back to normal about as soon as B (3 s and 4 s) but failed fewer requests (40 against 1,200).');
    expect(rankedFirstReason([a, tab({ short: 'B', recoverySeconds: 3, failedCount: 40 })])).toMatch(/^It ranks first by the checks it passed/);
    expect(rankedFirstReason([tab({ status: 'no' })])).toBeNull();
  });
});
