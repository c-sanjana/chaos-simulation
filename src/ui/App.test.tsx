import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App } from './App';
import type { RunConfig } from '../engine/config';
import { stableKey } from '../worker/cachingPool';
import { CancelledError, type SimPool } from '../worker/pool';
import { FakePool } from './testing/fakePool';

vi.mock('uplot', () => import('./testing/fakeUplot'));

const SLOW = { timeout: 30_000 };

// The guided tour opens on a first visit; these tests start as returning visitors (the tour has its own tests).
beforeEach(() => localStorage.setItem('csl-tour-seen-v2', 'completed'));
afterEach(() => localStorage.clear());

/** Builds Client → Load balancer → App server → Database, with a Cache, by keyboard-friendly buttons only. */
function buildChain() {
  for (const kind of ['client', 'load balancer', 'app server', 'database', 'cache']) fireEvent.click(screen.getByRole('button', { name: `Add ${kind}` }));
  const connect = (from: RegExp, to: string) => {
    fireEvent.click(screen.getByRole('button', { name: from }));
    fireEvent.change(screen.getByRole('combobox', { name: /Calls…/ }), { target: { value: to } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
  };
  connect(/^Client, a client/, 'loadBalancer-1');
  connect(/^Load balancer, a load balancer/, 'server-1');
  connect(/^App server, an app server/, 'database-1');
  connect(/^App server, an app server/, 'cache-1');
}

describe('App', { timeout: 60_000 }, () => {
  it('runs the default scenario and shows what happened', async () => {
    const pool = new FakePool();
    render(<App pool={pool} />);
    expect(screen.getByRole('heading', { name: 'Chaos Simulation Lab' })).toBeTruthy();
    expect(screen.getByText(/Simulating 120 s of traffic/)).toBeTruthy();
    await screen.findByRole('heading', { name: 'What happened' }, SLOW);
    // The verdict isn't given away up front: the replay reveals it when it gets there.
    expect(screen.queryByText('Stuck: did not recover after the failure ended')).toBeNull();
    expect(screen.getByText('A short failure, replayed')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Details: what was measured' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: "What's happening" })).toBeNull(); // one panel, not two
    expect(pool.analyzed).toHaveLength(1);
    expect(pool.analyzed[0].client.rps).toBe(200);
  });

  it('edits the failure, then re-runs only when asked', async () => {
    const pool = new FakePool();
    render(<App pool={pool} />);
    await screen.findByRole('heading', { name: 'What happened' }, SLOW);
    expect(screen.queryByLabelText(/^Traffic/)).toBeNull(); // the editor starts closed
    fireEvent.click(screen.getByRole('button', { name: 'Change failure' }));
    expect(screen.getByRole('button', { name: 'Replay from the start' })).toBeTruthy();
    const traffic = screen.getByLabelText(/^Traffic/);
    fireEvent.change(traffic, { target: { value: '80' } });
    expect(pool.analyzed).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Run simulation' }));
    await waitFor(() => expect(pool.analyzed.at(-1)!.client.rps).toBe(80), SLOW);
    fireEvent.click(screen.getByRole('button', { name: 'Change failure' }));
    // Retries per layer, front to back (defaults 5 / 3 / 1).
    expect(['Client → Load balancer', 'Load balancer → App server', 'App server → DB'].map((l) => (screen.getByLabelText(l) as HTMLInputElement).value)).toEqual(['5', '3', '1']);
    fireEvent.change(screen.getByLabelText('App server → DB'), { target: { value: '0' } });
    fireEvent.change(screen.getByLabelText('Client → Load balancer'), { target: { value: '2' } });
    const first = screen.getByRole('group', { name: 'Failure 1' });
    fireEvent.change(within(first).getByLabelText(/^How much slower/), { target: { value: '4' } });
    fireEvent.change(within(first).getByLabelText(/^Lasting/), { target: { value: '10' } });
    fireEvent.change(within(first).getByLabelText(/^Starts at/), { target: { value: '20' } });
    expect(within(first).getByText('DB slows 4× for 10 s.')).toBeTruthy();
    // A second failure, anywhere in the stack.
    fireEvent.click(screen.getByRole('button', { name: '+ Add another failure' }));
    const second = screen.getByRole('group', { name: 'Failure 2' });
    expect((within(second).getByLabelText('Part') as HTMLSelectElement).value).toBe('gateway');
    fireEvent.change(within(second).getByLabelText('Part'), { target: { value: 'cache' } });
    fireEvent.change(within(second).getByLabelText('What happens'), { target: { value: 'restart-empty' } });
    expect(within(second).getByText('Cache goes down and restarts empty for 10 s.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Run simulation' }));
    await waitFor(() => expect(pool.analyzed.length).toBeGreaterThan(2), SLOW);
    const last = pool.analyzed.at(-1)!;
    expect(last.tiers.find((t) => t.id === 'api')!.downstream!.retries).toBe(0);
    expect(last.client.call.retries).toBe(2);
    expect(last.faults).toEqual([
      { tier: 'db', kind: 'slow', factor: 4, startMs: 20_000, endMs: 30_000 },
      { tier: 'cache', kind: 'dead', flushAtEnd: true, startMs: 20_000, endMs: 30_000 },
    ]);
    expect(screen.getByRole('region', { name: 'Scenario' }).textContent).toMatch(/\(\+1 more\).*asks again: users' apps 2× · Load balancer 3× · App server 0×/);
    // Extra failures can be removed; the first stays.
    fireEvent.click(screen.getByRole('button', { name: 'Change failure' }));
    expect(screen.queryByRole('button', { name: 'Remove failure 1' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Remove failure 2' }));
    expect(screen.queryByRole('group', { name: 'Failure 2' })).toBeNull();
  });

  it('compares a re-run with the previous run, until dismissed or the preset changes', async () => {
    const pool = new FakePool();
    render(<App pool={pool} />);
    await screen.findByRole('heading', { name: 'What happened' }, SLOW);
    expect(screen.queryByRole('region', { name: 'Compared with your last run' })).toBeNull(); // nothing to compare yet
    fireEvent.click(screen.getByRole('button', { name: 'Change failure' }));
    fireEvent.change(screen.getByLabelText('App server → DB'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run simulation' }));
    await waitFor(() => expect(pool.analyzed).toHaveLength(2), SLOW);
    await screen.findByRole('heading', { name: 'What happened' }, SLOW);
    // Not while the new run is replaying: only once the replay reaches the end.
    expect(screen.queryByRole('region', { name: 'Compared with your last run' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Playback position'), { target: { value: '120000' } });
    const panel = await screen.findByRole('region', { name: 'Compared with your last run' }, SLOW);
    expect(within(panel).getByText('App server → DB retries 1 → 5')).toBeTruthy();
    expect(within(panel).getByText(/^The App server retried more, adding repeats\. It was stuck either way because/)).toBeTruthy();
    fireEvent.click(within(panel).getByRole('button', { name: 'Dismiss the comparison' }));
    expect(screen.queryByRole('region', { name: 'Compared with your last run' })).toBeNull();
    // A different preset isn't comparable.
    fireEvent.click(screen.getByRole('button', { name: 'Change failure' }));
    fireEvent.click(screen.getByRole('button', { name: /^Cache restarts empty/ }));
    await waitFor(() => expect(pool.analyzed.at(-1)!.faults![0].tier).toBe('cache'), SLOW);
    await act(async () => {});
    expect(screen.queryByRole('region', { name: 'Compared with your last run' })).toBeNull();
  });

  it('offers failures in other parts of the stack as presets', async () => {
    const pool = new FakePool();
    render(<App pool={pool} />);
    await screen.findByRole('heading', { name: 'What happened' }, SLOW);
    fireEvent.click(screen.getByRole('button', { name: 'Change failure' }));
    fireEvent.click(screen.getByRole('button', { name: /^Cache restarts empty/ }));
    await waitFor(() => expect(pool.analyzed.at(-1)!.faults![0]).toMatchObject({ tier: 'cache', kind: 'dead', flushAtEnd: true }), SLOW);
    expect(screen.getByRole('region', { name: 'Scenario' }).textContent).toMatch(/Cache goes down and restarts empty for 5 s/);
    fireEvent.click(screen.getByRole('button', { name: /^Load balancer slows down/ }));
    await waitFor(() => expect(pool.analyzed.at(-1)!.faults![0]).toMatchObject({ tier: 'gateway', kind: 'slow', factor: 50 }), SLOW);
    const part = within(screen.getByRole('group', { name: 'Failure 1' })).getByLabelText('Part') as HTMLSelectElement;
    expect(part.value).toBe('gateway');
    // One server down is offered where there is more than one server; "restarts empty" only for the cache.
    const kinds = () => [...(within(screen.getByRole('group', { name: 'Failure 1' })).getByLabelText('What happens') as HTMLSelectElement).options].map((o) => o.value);
    expect(kinds()).toEqual(['slow', 'down', 'one-down']);
    fireEvent.change(part, { target: { value: 'db' } });
    expect(kinds()).toEqual(['slow', 'down']);
  });

  it('shows the tipping-point map, its progress and an inline replay of the selected cell', async () => {
    const pool = new FakePool();
    render(<App pool={pool} />);
    fireEvent.click(screen.getByRole('button', { name: /Where's the tipping point/ }));
    await screen.findByText('60 of 60 runs', undefined, SLOW);
    expect(pool.cells).toHaveLength(60);
    expect(screen.getByText(/With a 5 s failure, the system tips at 120 req\/s/)).toBeTruthy();
    expect(screen.getByText(/Every layer asks again when it gives up \(Client 5×, Load balancer 3×, App server 1×\)/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /80 requests per second, 1s failure length: recovers in 2 s/ })).toBeTruthy();
    await screen.findByRole('heading', { name: /Replaying 200 req\/s · 5s failure length/ }, SLOW);
    fireEvent.click(screen.getByRole('button', { name: /^80 requests per second, 12s failure length/ }));
    await screen.findByRole('heading', { name: /Replaying 80 req\/s · 12s failure length/ }, SLOW);
    expect(screen.getByText('Recovers in 2 s')).toBeTruthy();
    // Side by side: map on the left; the replay on the right, with its details (story included) beside the chart.
    const timeline = screen.getByRole('region', { name: 'Details: what was measured' });
    expect(timeline.closest('.csl-player__timeline--side')).not.toBeNull();
    expect(screen.getByRole('region', { name: 'Tipping point' }).contains(timeline)).toBe(false);
  });

  it('summarises the scenario in one line on every step, and opens the editor to change it', async () => {
    const pool = new FakePool();
    render(<App pool={pool} />);
    fireEvent.click(screen.getByRole('button', { name: /Where's the tipping point/ }));
    const summary = screen.getByRole('region', { name: 'Scenario' });
    // A banner: labelled, the preset's name, then the failure, traffic and retries as chips.
    expect(summary.textContent).toMatch(/^Failure being tested\s*Retry storm/);
    expect(within(summary).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      '⚡DB slows 8× for 5 s at 30 s',
      '200 req/s',
      "asks again: users' apps 5× · Load balancer 3× · App server 1×",
    ]);
    const toggle = within(summary).getByRole('button', { name: 'Change failure' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(screen.getByRole('region', { name: 'Change the failure' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/^Traffic/), { target: { value: '90' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run simulation' }));
    expect(screen.queryByRole('region', { name: 'Change the failure' })).toBeNull();
    expect(screen.getByRole('region', { name: 'Scenario' }).textContent).toMatch(/90 req\/s/);
    fireEvent.click(screen.getByRole('button', { name: 'Change failure' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('region', { name: 'Change the failure' })).toBeNull();
  });

  it('puts the title and one toolbar of page tools on the first row, and the failure being tested under them', async () => {
    const pool = new FakePool();
    render(<App pool={pool} />);
    await screen.findByRole('heading', { name: 'What happened' }, SLOW);
    const header = screen.getByRole('banner');
    const title = within(header).getByRole('heading', { level: 1, name: 'Chaos Simulation Lab' });
    const tools = within(header).getByRole('group', { name: 'Page tools' });
    // Row 1: the title and the toolbar side by side; every page tool is in that one toolbar, in order.
    expect(tools.parentElement).toBe(title.parentElement);
    const names = () => [...tools.querySelectorAll('button, summary')].map((el) => el.getAttribute('aria-label') ?? el.textContent);
    expect(names()).toEqual(['✎ Build your own system', 'Glossary', 'Switch to dark mode', 'Show the guided tour']);
    expect(within(tools).getByRole('button', { name: '✎ Build your own system' })).toBeTruthy(); // the ✎ and words are its name
    // Row 2: the banner, full width under row 1, labelled as the experiment, with its button attached.
    const banner = within(header).getByRole('region', { name: 'Scenario' });
    expect(title.parentElement!.contains(banner)).toBe(false);
    expect(title.parentElement!.compareDocumentPosition(banner) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(banner).getByText('Failure being tested')).toBeTruthy();
    expect(within(banner).getByRole('button', { name: 'Change failure' })).toBeTruthy();
    // The builder's variant: no banner and no build button; the other tools stay where they were.
    fireEvent.click(within(tools).getByRole('button', { name: '✎ Build your own system' }));
    expect(within(header).queryByRole('region', { name: 'Scenario' })).toBeNull();
    expect(names()).toEqual(['Glossary', 'Switch to dark mode', 'Show the guided tour']);
    expect(tools.querySelector('.csl-topbar__sep')).toBeNull();
  });

  it('reports failed requests for stuck cells and recovery everywhere when nothing tips', async () => {
    const pool = new FakePool(() => ({ verdict: 'recovered', recoveryMs: 1000, failedRequests: 0 }));
    render(<App pool={pool} />);
    fireEvent.click(screen.getByRole('button', { name: /Where's the tipping point/ }));
    await screen.findByText(/recovers at every traffic level shown/, undefined, SLOW);
    const stuckPool = new FakePool();
    render(<App pool={stuckPool} />);
    fireEvent.click(screen.getAllByRole('button', { name: /Where's the tipping point/ })[1]);
    await screen.findByText(/^1,234 failed requests$/, undefined, SLOW);
  });

  it('opens one tier\'s settings from its box in the topology', async () => {
    const pool = new FakePool();
    render(<App pool={pool} />);
    await screen.findByRole('heading', { name: 'What happened' }, SLOW);
    fireEvent.click(screen.getByRole('button', { name: /^Edit App server settings/ }));
    const dialog = screen.getByRole('dialog', { name: 'App server settings' });
    expect(within(dialog).queryByRole('group', { name: 'DB' })).toBeNull();
    expect(within(dialog).getByRole('group', { name: 'App server' })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Edit all settings' }));
    expect(screen.getByRole('dialog', { name: 'All settings' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close All settings' }));
    fireEvent.click(screen.getByRole('button', { name: /^Edit Client settings/ }));
    const traffic = screen.getByRole('dialog', { name: 'Traffic settings' });
    expect(within(traffic).getByLabelText(/^User traffic/)).toBeTruthy();
    expect(within(traffic).queryByRole('group', { name: 'App server' })).toBeNull();
  });

  it('edits settings in the drawer, re-runs, and can reset to the preset', async () => {
    const pool = new FakePool();
    render(<App pool={pool} />);
    await screen.findByRole('heading', { name: 'What happened' }, SLOW);
    fireEvent.click(screen.getByRole('button', { name: /Edit all settings/ }));
    const dialog = screen.getByRole('dialog');
    const api = within(dialog).getByRole('group', { name: 'App server' });
    // The builder's words for the same settings.
    fireEvent.change(within(api).getByLabelText(/^Copies \(instances\)/), { target: { value: '8' } });
    fireEvent.click(within(api).getByLabelText(/^Randomise the wait before retrying/));
    fireEvent.click(within(api).getByLabelText('Skip requests whose caller already gave up'));
    fireEvent.click(within(api).getByLabelText('Limit the waiting line'));
    fireEvent.change(within(api).getByLabelText(/^Requests allowed to wait, per copy/), { target: { value: '50' } });
    fireEvent.change(within(api).getByLabelText(/^Retries to DB/), { target: { value: '1' } });
    const gateway = within(dialog).getByRole('group', { name: 'Load balancer' });
    fireEvent.change(within(gateway).getByLabelText(/^Retries to App server/), { target: { value: '2' } });
    fireEvent.change(within(gateway).getByLabelText(/^Timeout to App server/), { target: { value: '1500' } });
    fireEvent.change(within(gateway).getByLabelText(/^Wait before retrying/), { target: { value: '20' } });
    fireEvent.change(within(gateway).getByLabelText(/^Typical time per request/), { target: { value: '2' } });
    fireEvent.change(within(gateway).getByLabelText(/^Slowest 1% take/), { target: { value: '9' } });
    fireEvent.change(within(gateway).getByLabelText(/^Requests each copy handles at once/), { target: { value: '100' } });
    fireEvent.change(within(gateway).getByLabelText(/^CPU cores per copy/), { target: { value: '2' } });
    const cache = within(dialog).getByRole('group', { name: 'Cache' });
    fireEvent.change(within(cache).getByLabelText(/^Keys it can hold/), { target: { value: '500' } });
    fireEvent.change(within(cache).getByLabelText(/^Expire after/), { target: { value: '30' } });
    fireEvent.change(within(cache).getByLabelText(/^Different keys requested/), { target: { value: '5000' } });
    fireEvent.change(within(cache).getByLabelText(/^Popularity skew/), { target: { value: '0.8' } });
    fireEvent.change(within(dialog).getByLabelText(/^User traffic/), { target: { value: '150' } });
    fireEvent.change(within(dialog).getByLabelText(/^Duration/), { target: { value: '90' } });
    fireEvent.change(within(dialog).getByLabelText(/^Timeout to Load balancer/), { target: { value: '2500' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Re-run simulation' }));
    await waitFor(() => expect(pool.analyzed.some((c) => c.client.rps === 150)).toBe(true), SLOW);
    const c = pool.analyzed.find((x) => x.client.rps === 150)!;
    const tier = (id: string) => c.tiers.find((t) => t.id === id)!;
    expect(tier('api')).toMatchObject({ instances: 8, dropExpired: true, queueLimit: 50 });
    expect(tier('api').downstream).toMatchObject({ jitter: true, retries: 1 });
    expect(tier('gateway').downstream).toMatchObject({ retries: 2, timeoutMs: 1500, backoffBaseMs: 20 });
    expect(tier('gateway')).toMatchObject({ workersPerInstance: 100, coresPerInstance: 2, service: { medianMs: 2, p99Ms: 9 } });
    expect(tier('cache').cache).toEqual({ capacity: 500, ttlMs: 30_000, keys: 5000, skew: 0.8 });
    expect(c.durationMs).toBe(90_000);
    expect(c.client.call.timeoutMs).toBe(2500);

    await screen.findByRole('button', { name: /Edit all settings/ }, SLOW);
    fireEvent.click(screen.getByRole('button', { name: /Edit all settings/ }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Reset to preset' }));
    expect((within(screen.getByRole('dialog')).getByLabelText(/^User traffic/) as HTMLInputElement).value).toBe('200');
    fireEvent.click(screen.getByRole('button', { name: 'Close All settings' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('the drawer can say "no timeout" and "never expires", and Re-run never silently does nothing', async () => {
    const pool = new FakePool();
    render(<App pool={pool} />);
    await screen.findByRole('heading', { name: 'What happened' }, SLOW);
    fireEvent.click(screen.getByRole('button', { name: /Edit all settings/ }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByLabelText('Give up on Load balancer after a timeout'));
    expect(within(dialog).queryByLabelText(/^Timeout to Load balancer/)).toBeNull();
    const cache = within(dialog).getByRole('group', { name: 'Cache' });
    fireEvent.click(within(cache).getByLabelText('Entries expire'));
    expect(within(cache).queryByLabelText(/^Expire after/)).toBeNull();
    // At 0 retries the wait between tries isn't asked for.
    const api = within(dialog).getByRole('group', { name: 'App server' });
    fireEvent.change(within(api).getByLabelText(/^Retries to DB/), { target: { value: '0' } });
    expect(within(api).queryByLabelText(/^Wait before retrying/)).toBeNull();
    // A half-typed number blocks Re-run, says why beside it, and a press goes to the field.
    const traffic = within(dialog).getByLabelText(/^User traffic/);
    fireEvent.change(traffic, { target: { value: '0' } });
    const rerun = within(dialog).getByRole('button', { name: 'Re-run simulation' });
    await waitFor(() => expect(rerun.getAttribute('aria-disabled')).toBe('true'));
    expect(within(dialog).getByText('Fix "User traffic" first')).toBeTruthy();
    fireEvent.click(rerun);
    expect(document.activeElement).toBe(traffic);
    expect(pool.analyzed).toHaveLength(1);
    fireEvent.change(traffic, { target: { value: '200' } });
    // A typical time above the slowest 1%: the slowest-1% field says so, and Re-run points at it.
    const gateway = within(dialog).getByRole('group', { name: 'Load balancer' });
    fireEvent.change(within(gateway).getByLabelText(/^Typical time per request/), { target: { value: '9' } });
    await within(dialog).findByText('Fix "Slowest 1% take" first');
    expect(within(gateway).getByText('Must take longer than the typical time (9 ms)')).toBeTruthy();
    fireEvent.click(rerun);
    expect(pool.analyzed).toHaveLength(1);
    fireEvent.change(within(gateway).getByLabelText(/^Typical time per request/), { target: { value: '1' } });
    // Settings that don't fit together: the reason points at the list.
    fireEvent.change(within(dialog).getByLabelText(/^Duration/), { target: { value: '30' } });
    await within(dialog).findByText('Fix the problem above first');
    fireEvent.click(rerun);
    expect(pool.analyzed).toHaveLength(1);
    fireEvent.change(within(dialog).getByLabelText(/^Duration/), { target: { value: '120' } });
    await waitFor(() => expect(rerun.getAttribute('aria-disabled')).toBeNull());
    fireEvent.click(rerun);
    await waitFor(() => expect(pool.analyzed).toHaveLength(2), SLOW);
    const c = pool.analyzed[1];
    expect(c.client.call.timeoutMs).toBeNull();
    expect(c.tiers.find((t) => t.id === 'cache')!.cache!.ttlMs).toBeNull();
  });

  it('opens step 3 and switches scenarios', async () => {
    const pool = new FakePool();
    render(<App pool={pool} />);
    fireEvent.click(screen.getByRole('button', { name: /Does a fix help/ }));
    expect(screen.getByText('Waiting for the original run…')).toBeTruthy();
    await screen.findByRole('heading', { name: 'Did the tipping point move?' }, SLOW);
    fireEvent.click(screen.getByRole('button', { name: 'Change failure' }));
    fireEvent.click(screen.getByRole('button', { name: /Retry storm/ }));
    await act(async () => {});
  });

  it('opens the guided tour on a first visit once the run is ready, and replays it from the ? button', async () => {
    localStorage.clear();
    render(<App pool={new FakePool()} />);
    expect(screen.queryByRole('dialog')).toBeNull(); // waits for the first run, so its targets exist
    const tour = await screen.findByRole('dialog', {}, SLOW);
    expect(tour.textContent).toMatch(/Demo: a retry storm/);
    fireEvent.click(within(tour).getByRole('button', { name: /Skip tour/ }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(localStorage.getItem('csl-tour-seen-v2')).toBe('skipped');
    // The replay waits for the tour to close.
    fireEvent.click(screen.getByRole('button', { name: /Where's the tipping point/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Show the guided tour' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Play' })).toBeTruthy(); // the tour jumps to step 1, replay held
    fireEvent.keyDown(document, { key: 'Escape' });
    // Closing the tour returns to the step it was started from.
    expect(screen.getByRole('button', { name: /Where's the tipping point/ }).getAttribute('aria-current')).toBe('step');
    // The theme toggle sits beside it in the top bar.
    expect(screen.getByRole('button', { name: /Switch to (dark|light) mode/ })).toBeTruthy();
  });

  it('finishing the tour lands on the end of the replay, with the verdict shown', async () => {
    localStorage.clear();
    render(<App pool={new FakePool()} />);
    await screen.findByRole('dialog', {}, SLOW);
    for (let i = 0; i < 10; i++) fireEvent.keyDown(document, { key: 'ArrowRight' });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Done' }));
    expect(localStorage.getItem('csl-tour-seen-v2')).toBe('completed');
    expect(screen.getByRole('button', { name: /What happened/ }).getAttribute('aria-current')).toBe('step');
    // The steps the tour visited stay mounted (hidden); only step 1's replay is visible.
    await waitFor(() => expect(Number((screen.getByRole('slider', { name: 'Playback position' }) as HTMLInputElement).value)).toBe(120_000), SLOW);
    expect(screen.getByRole('button', { name: 'Play' })).toBeTruthy(); // paused there, not replaying from the start
    expect(screen.getByText('Stuck: did not recover after the failure ended')).toBeTruthy();
  });

  it('the tour is a demo of the default retry storm: other settings are set aside for it and come back after', async () => {
    const pool = new FakePool();
    render(<App pool={pool} />);
    await screen.findByRole('heading', { name: 'What happened' }, SLOW);
    fireEvent.click(screen.getByRole('button', { name: 'Change failure' }));
    fireEvent.change(screen.getByLabelText(/^Traffic/), { target: { value: '80' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run simulation' }));
    await waitFor(() => expect(pool.analyzed.at(-1)!.client.rps).toBe(80), SLOW);
    await screen.findByRole('heading', { name: 'What happened' }, SLOW);

    fireEvent.click(screen.getByRole('button', { name: 'Show the guided tour' }));
    // The demo's run: the default settings, whose run from the start is reused.
    const tour = await screen.findByRole('dialog', {}, SLOW);
    expect(screen.getByRole('region', { name: 'Scenario' }).textContent).toMatch(/200 req\/s/);
    expect(pool.analyzed.filter((c) => c.client.rps === 200)).toHaveLength(1);
    // Each demo stop moves the replay to its moment.
    fireEvent.click(within(tour).getByRole('button', { name: 'Next' }));
    expect(within(screen.getByRole('dialog')).getByText('Normal traffic')).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy()); // playing forward to 20 s
    fireEvent.keyDown(document, { key: 'ArrowLeft' });
    await waitFor(() => expect(Number((screen.getByLabelText('Playback position') as HTMLInputElement).value)).toBe(0)); // back: jumps
    fireEvent.keyDown(document, { key: 'Escape' });
    // The viewer's settings, back, with their run reused rather than simulated again.
    await waitFor(() => expect(screen.getByRole('region', { name: 'Scenario' }).textContent).toMatch(/80 req\/s/), SLOW);
    await screen.findByRole('heading', { name: 'What happened' }, SLOW);
    expect(pool.analyzed.filter((c) => c.client.rps === 80)).toHaveLength(1);
  });

  it('explains invalid input and blocks running it', async () => {
    const pool = new FakePool();
    render(<App pool={pool} />);
    await screen.findByRole('heading', { name: 'What happened' }, SLOW);
    fireEvent.click(screen.getByRole('button', { name: 'Change failure' }));
    const traffic = screen.getByLabelText(/^Traffic/) as HTMLInputElement;
    fireEvent.change(traffic, { target: { value: '100000' } });
    expect(screen.getByText('Enter a whole number from 1 to 5000')).toBeTruthy();
    // The invalid entry stays visible (no snap back) and Run is disabled until it is fixed.
    fireEvent.blur(traffic);
    expect(traffic.value).toBe('100000');
    const replay = screen.getByRole('button', { name: 'Replay from the start' }) as HTMLButtonElement;
    expect(replay.disabled).toBe(true);
    fireEvent.click(replay);
    expect(pool.analyzed).toHaveLength(1); // nothing ran
    fireEvent.change(traffic, { target: { value: '200' } });
    expect(replay.disabled).toBe(false);
    // "Starts at" is bounded by the run: the failure must end 20 s before it does (120 s run, 5 s failure).
    const start = screen.getByLabelText(/^Starts at/) as HTMLInputElement;
    expect(start.max).toBe('95');
    fireEvent.change(start, { target: { value: '500' } });
    expect(screen.getByText('Enter a whole number from 0 to 95')).toBeTruthy();
    expect(replay.disabled).toBe(true);
    fireEvent.change(start, { target: { value: '40' } });
    const run = screen.getByRole('button', { name: 'Run simulation' }) as HTMLButtonElement;
    expect(run.disabled).toBe(false);
    // A run that ends too soon for the failure is explained in words.
    fireEvent.change(start, { target: { value: '30' } });
    fireEvent.change(screen.getByLabelText(/^Lasting/), { target: { value: '80' } });
    expect(screen.getByText('Enter a whole number from 1 to 70')).toBeTruthy();
  });

  it('replays the same run from the start when nothing changed, labels edited presets, and caps added failures', async () => {
    const pool = new FakePool();
    render(<App pool={pool} />);
    await screen.findByRole('heading', { name: 'What happened' }, SLOW);
    const position = () => Number((screen.getByLabelText('Playback position') as HTMLInputElement).value);
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    fireEvent.change(screen.getByLabelText('Playback position'), { target: { value: '60000' } });
    expect(position()).toBe(60_000);
    fireEvent.click(screen.getByRole('button', { name: 'Change failure' }));
    fireEvent.click(screen.getByRole('button', { name: 'Replay from the start' }));
    await waitFor(() => expect(position()).toBeLessThan(60_000));
    expect(pool.analyzed).toHaveLength(1); // the same run, replayed: nothing re-simulated
    expect(screen.getByRole('region', { name: 'Scenario' }).textContent).not.toMatch(/\(edited\)/);
    expect(screen.getByRole('region', { name: 'Scenario' }).textContent).toMatch(/asks again: users' apps 5× · Load balancer 3× · App server 1×/);

    fireEvent.click(screen.getByRole('button', { name: 'Change failure' }));
    const add = screen.getByRole('button', { name: '+ Add another failure' }) as HTMLButtonElement;
    for (let i = 0; i < 3; i++) fireEvent.click(add); // gateway, app server, cache: every part fails
    expect(add.disabled).toBe(true);
    expect(screen.getByText('Every part already has a failure.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Run simulation' }));
    await waitFor(() => expect(screen.getByRole('region', { name: 'Scenario' }).textContent).toMatch(/Retry storm \(edited\)/));
  });

  it('keeps a way out when a run cannot be simulated', async () => {
    const pool = new FakePool();
    const makeBatch = pool.batch.bind(pool);
    // Any traffic but the preset's fails, as an invalid config would.
    pool.batch = () => {
      const b = makeBatch();
      return { ...b, analyze: (c, l) => (c.client.rps !== 200 ? Promise.reject(new Error('Invalid config: db service p99Ms must exceed medianMs')) : b.analyze(c, l)) };
    };
    render(<App pool={pool} />);
    await screen.findByRole('heading', { name: 'What happened' }, SLOW);
    fireEvent.click(screen.getByRole('button', { name: 'Change failure' }));
    fireEvent.change(screen.getByLabelText(/^Traffic/), { target: { value: '150' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run simulation' }));
    const alert = await screen.findByRole('alert', { name: 'Simulation error' }, SLOW);
    expect(alert.textContent).toMatch(/These settings couldn't be simulated/);
    expect(alert.textContent).toMatch(/db service p99Ms must exceed medianMs/);
    expect(screen.getByText("Couldn't simulate these settings")).toBeTruthy(); // the step tab says so too
    fireEvent.click(within(alert).getByRole('button', { name: '⚙ Edit settings' }));
    expect(screen.getByRole('dialog', { name: 'All settings' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close All settings' }));
    fireEvent.click(screen.getByRole('button', { name: /Does a fix help/ }));
    expect(screen.getByRole('alert', { name: 'Simulation error' })).toBeTruthy(); // not "waiting" forever
    fireEvent.click(within(screen.getByRole('alert', { name: 'Simulation error' })).getByRole('button', { name: 'Reset to the preset' }));
    await screen.findByRole('heading', { name: 'Did the tipping point move?' }, SLOW);
  });

  it('creates and disposes its own pool when none is injected (falls back in-process without Workers)', async () => {
    const { unmount } = render(<App />);
    await act(async () => {});
    unmount();
  });

  it('builds a system on the canvas and runs every step on it', async () => {
    const pool = new FakePool();
    render(<App pool={pool} />);
    await screen.findByRole('heading', { name: 'What happened' }, SLOW);
    fireEvent.click(screen.getByRole('button', { name: '✎ Build your own system' }));
    // The canvas opens on the example system, drawn; the failure summary steps aside meanwhile.
    const builder = screen.getByRole('region', { name: 'Build your own system' });
    expect(within(builder).queryByText(/Branching is coming next|A chain for now/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Change failure' })).toBeNull();
    fireEvent.click(within(builder).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('region', { name: 'Build your own system' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Change failure' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '✎ Build your own system' }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.getByRole('button', { name: /^Use this topology · 1 thing to fix/ }).getAttribute('aria-disabled')).toBe('true');
    buildChain();
    fireEvent.click(screen.getByRole('button', { name: 'Use this topology' }));
    // New tier ids: the old run must never be shown against the new system.
    await screen.findByRole('heading', { name: 'What happened' }, SLOW);
    await waitFor(() => expect(pool.analyzed.at(-1)!.tiers.map((t) => t.id)).toEqual(['loadBalancer-1', 'server-1', 'cache-1', 'database-1']), SLOW);
    expect(screen.getByRole('region', { name: 'Scenario' }).textContent).toMatch(/^Failure being tested\s*Database slows down/);
    // The DB the retry storm slowed down isn't in this system: the failure was reset, and it says why.
    const reset = screen.getByText(/^The failure was reset to "Database slows down": the example's DB, where it happened, is not in your system\./);
    fireEvent.click(within(reset).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText(/The failure was reset/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Change failure' }));
    expect(screen.getAllByRole('button', { name: /slows down|restarts empty/ }).map((b) => b.textContent!.split(/(?<=down|empty)/)[0])).toEqual(['Database slows down', 'Cache restarts empty', 'Load balancer slows down']);
    fireEvent.click(screen.getByRole('button', { name: /^Cache restarts empty/ }));
    await waitFor(() => expect(pool.analyzed.at(-1)!.faults![0].tier).toBe('cache-1'), SLOW);
    fireEvent.click(screen.getByRole('button', { name: /Where's the tipping point/ }));
    await screen.findByText(/Traffic × failure length/, undefined, SLOW);
    fireEvent.click(screen.getByRole('button', { name: /Does a fix help/ }));
    // Edit the built system again; then go back to the example, which can be undone.
    fireEvent.click(screen.getByRole('button', { name: '✎ Edit your system' }));
    fireEvent.click(screen.getByRole('button', { name: 'Use the example system instead' }));
    expect(screen.getByRole('button', { name: '✎ Build your own system' })).toBeTruthy();
    const notice = screen.getByText(/Switched to the example system/);
    fireEvent.click(within(notice).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(pool.analyzed.at(-1)!.tiers.map((t) => t.id)).toEqual(['loadBalancer-1', 'server-1', 'cache-1', 'database-1']), SLOW);
    expect(screen.getByRole('region', { name: 'Scenario' }).textContent).toMatch(/^Failure being tested\s*Cache restarts empty/);
    expect(screen.queryByText(/Switched to the example system/)).toBeNull();
  });

  it('remembers a built system in this browser, and keeps a cancelled drawing for next time', async () => {
    const pool = new FakePool();
    const { unmount } = render(<App pool={pool} />);
    await screen.findByRole('heading', { name: 'What happened' }, SLOW);
    fireEvent.click(screen.getByRole('button', { name: '✎ Build your own system' }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    buildChain();
    fireEvent.click(screen.getByRole('button', { name: 'Use this topology' }));
    await waitFor(() => expect(pool.analyzed.at(-1)!.tiers[0].id).toBe('loadBalancer-1'), SLOW);
    // A drawer edit, re-run: part of what is remembered.
    fireEvent.click(screen.getByRole('button', { name: /Edit all settings/ }));
    expect(screen.getByRole('dialog').textContent).toMatch(/Your system: Database slows down/);
    expect(within(screen.getByRole('dialog')).getByRole('button', { name: 'Reset to how you built it' })).toBeTruthy();
    fireEvent.change(within(screen.getByRole('group', { name: 'App server' })).getByLabelText(/^Copies/), { target: { value: '7' } });
    fireEvent.click(screen.getByRole('button', { name: 'Re-run simulation' }));
    await waitFor(() => expect(pool.analyzed.at(-1)!.tiers[1].instances).toBe(7), SLOW);
    // Changing the failure keeps that edit.
    fireEvent.click(screen.getByRole('button', { name: 'Change failure' }));
    fireEvent.click(screen.getByRole('button', { name: /^Cache restarts empty/ }));
    await waitFor(() => expect(pool.analyzed.at(-1)!.faults![0].tier).toBe('cache-1'), SLOW);
    expect(pool.analyzed.at(-1)!.tiers[1].instances).toBe(7);
    // Open the builder, change the drawing, cancel: the system stays; the drawing is kept.
    fireEvent.click(screen.getByRole('button', { name: '✎ Edit your system' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add queue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    unmount();

    // A reload: the built system, its failure and the edit are back; so is the kept drawing.
    const again = new FakePool();
    render(<App pool={again} />);
    await waitFor(() => expect(again.analyzed).toHaveLength(1), SLOW);
    expect(again.analyzed[0].tiers.map((t) => t.id)).toEqual(['loadBalancer-1', 'server-1', 'cache-1', 'database-1']);
    expect(again.analyzed[0].tiers[1].instances).toBe(7);
    expect(screen.getByRole('region', { name: 'Scenario' }).textContent).toMatch(/^Failure being tested\s*Cache restarts empty/);
    fireEvent.click(screen.getByRole('button', { name: '✎ Edit your system' }));
    expect(screen.getByRole('button', { name: /^Queue, a queue/ })).toBeTruthy();
    // It says this is the kept drawing; a second Cancel without changes keeps it still (code review 3).
    expect(screen.getByText(/^This is the drawing you kept from last time, not the system you are running\./)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: '✎ Edit your system' }));
    expect(screen.getByRole('button', { name: /^Queue, a queue/ })).toBeTruthy();
    // The running system instead: the kept drawing stays kept for next time.
    fireEvent.click(screen.getByRole('button', { name: 'Open the system you are running instead' }));
    expect(screen.queryByRole('button', { name: /^Queue, a queue/ })).toBeNull();
    expect(screen.queryByText(/This is the drawing you kept/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: '✎ Edit your system' }));
    expect(screen.getByRole('button', { name: /^Queue, a queue/ })).toBeTruthy();
  });

  it('says so when a damaged save had to be left out, and shows the example', async () => {
    localStorage.setItem('csl-built-system-v1', '{"system": {"nodes": [{"id": 1}], "edges": []}, "canvas": null}');
    render(<App pool={new FakePool()} />);
    expect(screen.getByText(/^Your saved system couldn't be restored \(the save is damaged or from another version of this page\), so the example system is shown\./)).toBeTruthy();
    await screen.findByRole('heading', { name: 'What happened' }, SLOW);
    expect(screen.getByRole('button', { name: '✎ Build your own system' })).toBeTruthy();
  });

  it('"Use this topology" keeps the current failure and step when its parts still exist', async () => {
    const pool = new FakePool();
    render(<App pool={pool} />);
    await screen.findByRole('heading', { name: 'What happened' }, SLOW);
    fireEvent.click(screen.getByRole('button', { name: 'Change failure' }));
    fireEvent.change(within(screen.getByRole('group', { name: 'Failure 1' })).getByLabelText(/^How much slower/), { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run simulation' }));
    fireEvent.click(screen.getByRole('button', { name: /Where's the tipping point/ }));
    // The example on the canvas keeps its part ids, so the DB failure still has its DB.
    fireEvent.click(screen.getByRole('button', { name: '✎ Build your own system' }));
    fireEvent.click(screen.getByRole('button', { name: 'Use this topology' }));
    await waitFor(() => expect(pool.analyzed.at(-1)!.faults).toEqual([{ tier: 'db', kind: 'slow', factor: 4, startMs: 30_000, endMs: 35_000 }]), SLOW);
    expect(screen.getByRole('region', { name: 'Scenario' }).textContent).toMatch(/^Failure being tested\s*Retry storm.*DB slows 4×/);
    expect(screen.getByRole('button', { name: /Where's the tipping point/ }).getAttribute('aria-current')).toBe('step');
    expect(screen.queryByText(/The failure was reset/)).toBeNull();
  });
});

describe('App: switching steps keeps finished work and state', { timeout: 120_000 }, () => {
  const slider = () => screen.getByRole('slider', { name: 'Playback position' }) as HTMLInputElement;
  const goTo = (name: RegExp) => fireEvent.click(screen.getByRole('button', { name }));

  it('step 1 keeps its replay position, tab and comparison; step 2 its map and cell; step 3 its fix, reusing step 2\'s map', async () => {
    const pool = new FakePool();
    render(<App pool={pool} />);
    await screen.findByRole('heading', { name: 'What happened' }, SLOW);
    // A re-run, so there is a comparison with the last run once the replay ends.
    fireEvent.click(screen.getByRole('button', { name: 'Change failure' }));
    fireEvent.change(screen.getByLabelText('App server → DB'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run simulation' }));
    await waitFor(() => expect(pool.analyzed).toHaveLength(2), SLOW);
    await screen.findByRole('heading', { name: 'What happened' }, SLOW);
    fireEvent.change(slider(), { target: { value: '120000' } });
    await screen.findByRole('region', { name: 'Compared with your last run' }, SLOW);
    fireEvent.change(slider(), { target: { value: '30000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Errors' }));

    goTo(/Where's the tipping point/);
    expect(screen.queryByRole('heading', { name: 'What happened' })).toBeNull(); // step 1 is hidden
    await screen.findByText('60 of 60 runs', undefined, SLOW);
    fireEvent.click(screen.getByRole('button', { name: /^80 requests per second, 12s failure length/ }));
    await screen.findByRole('heading', { name: /Replaying 80 req\/s · 12s failure length/ }, SLOW);

    goTo(/What happened/);
    expect(slider().value).toBe('30000');
    expect(screen.getByRole('button', { name: 'Errors' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('region', { name: 'Compared with your last run' })).toBeTruthy();

    goTo(/Where's the tipping point/);
    expect(screen.getByText('60 of 60 runs')).toBeTruthy(); // not started again
    expect(screen.getByRole('heading', { name: /Replaying 80 req\/s · 12s failure length/ })).toBeTruthy();
    expect(pool.cells).toHaveLength(59); // the cell at your settings is step 1's run

    goTo(/Does a fix help/);
    await screen.findByRole('heading', { name: /^Before vs after/ }, SLOW);
    await waitFor(() => expect(screen.queryByText(/ of \d+ runs done/)).toBeNull(), SLOW); // both maps done
    // No cell was ever simulated twice: the "before" map is step 2's map, the checks reuse the runs they can.
    expect(new Set(pool.cells.map((c) => stableKey(c))).size).toBe(pool.cells.length);
    // The replay at your settings reuses the ranking's run of the fix and the original run.
    expect(new Set(pool.analyzed.map((c) => stableKey(c))).size).toBe(pool.analyzed.length);
    const tabs = screen.getAllByRole('tab');
    fireEvent.click(tabs[1]);
    const short = tabs[1].textContent!.replace(/^[✓⚠✕]|\d+ s$/g, '');
    await screen.findByText(`After: ${short}`, undefined, SLOW);
    await screen.findByRole('heading', { name: /^Before vs after/ }, SLOW);
    const work = [pool.cells.length, pool.analyzed.length];
    goTo(/What happened/);
    goTo(/Does a fix help/);
    expect(screen.getAllByRole('tab')[1].getAttribute('aria-selected')).toBe('true');
    await act(async () => {});
    expect([pool.cells.length, pool.analyzed.length]).toEqual(work);
  });

  it('a replay pauses while its step is hidden and carries on when it is back, also one that arrived while hidden', async () => {
    const pool = new FakePool();
    render(<App pool={pool} />);
    goTo(/Where's the tipping point/); // before the first run is ready
    await waitFor(() => expect(pool.analyzed.length).toBeGreaterThan(0));
    await screen.findByText('60 of 60 runs', undefined, SLOW);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    goTo(/What happened/);
    await screen.findByRole('heading', { name: 'What happened' }, SLOW);
    expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy(); // it plays now that it is shown
    goTo(/Where's the tipping point/);
    goTo(/What happened/);
    expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy();
  });

  it('a re-run starts the other steps afresh', async () => {
    const pool = new FakePool();
    render(<App pool={pool} />);
    goTo(/Where's the tipping point/);
    await screen.findByText('60 of 60 runs', undefined, SLOW);
    goTo(/What happened/);
    fireEvent.click(screen.getByRole('button', { name: 'Change failure' }));
    fireEvent.change(screen.getByLabelText(/^Traffic/), { target: { value: '80' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run simulation' }));
    goTo(/Where's the tipping point/);
    expect(screen.getByText(/^\d+ of 60 runs$/).textContent).not.toBe('60 of 60 runs'); // the map's 80 req/s cell is selected now
    await screen.findByRole('heading', { name: /Replaying 80 req\/s/ }, SLOW);
  });
});

describe('App: long runs', { timeout: 60_000 }, () => {
  /** A pool where any traffic but the preset's runs "forever", reporting 40% done, until cancelled. */
  function slowPool() {
    const fake = new FakePool();
    const started: RunConfig[] = [];
    const pool: SimPool = {
      size: 1,
      dispose: () => fake.dispose(),
      batch: () => {
        const b = fake.batch();
        let cancel = () => {};
        return {
          ...b,
          analyze: (config, labels, opts) => {
            if (config.client.rps === 200) return b.analyze(config, labels, opts);
            started.push(config);
            return new Promise((_, reject) => {
              setTimeout(() => opts?.onProgress?.(0.4), 0);
              cancel = () => reject(new CancelledError());
            });
          },
          cancel: () => (b.cancel(), cancel()),
          get cancelled() {
            return b.cancelled;
          },
        };
      },
    };
    return { pool, started };
  }

  it('shows how far a long run is, and can stop it; then run it anyway, or go back to the preset', async () => {
    const { pool, started } = slowPool();
    render(<App pool={pool} />);
    await screen.findByRole('heading', { name: 'What happened' }, SLOW);
    fireEvent.click(screen.getByRole('button', { name: 'Change failure' }));
    fireEvent.change(screen.getByLabelText(/^Traffic/), { target: { value: '150' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run simulation' }));
    await screen.findByText('40%', undefined, SLOW);
    expect(screen.getByText(/^Simulating 120 s of traffic/)).toBeTruthy();
    expect(screen.getByRole('progressbar', { name: 'Simulation progress' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Stop this run' }));
    const stopped = screen.getByRole('alert', { name: 'Simulation stopped' });
    expect(stopped.textContent).toMatch(/You stopped this run before it finished/);
    expect(screen.getByText('Stopped before it finished')).toBeTruthy(); // the step tab says so too
    fireEvent.click(screen.getByRole('button', { name: /Does a fix help/ }));
    expect(screen.getByRole('alert', { name: 'Simulation stopped' })).toBeTruthy(); // not "waiting" forever
    fireEvent.click(screen.getByRole('button', { name: /What happened/ }));

    fireEvent.click(within(screen.getByRole('alert', { name: 'Simulation stopped' })).getByRole('button', { name: 'Run it anyway' }));
    await screen.findByText('40%', undefined, SLOW);
    expect(started).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Stop this run' }));
    // Running the same settings again from the editor ("Replay from the start") runs them again too.
    fireEvent.click(screen.getByRole('button', { name: 'Change failure' }));
    fireEvent.click(screen.getByRole('button', { name: 'Replay from the start' }));
    await screen.findByText('40%', undefined, SLOW);
    expect(started).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: 'Stop this run' }));
    fireEvent.click(within(screen.getByRole('alert', { name: 'Simulation stopped' })).getByRole('button', { name: 'Reset to the preset' }));
    await screen.findByRole('heading', { name: 'What happened' }, SLOW); // the preset's run, kept from the start
  });
});

describe('App focus, landmarks and announcements', { timeout: 60_000 }, () => {
  it('puts the banner beside main, not inside it, and announces runs in one live region', async () => {
    render(<App pool={new FakePool()} />);
    const banner = screen.getByRole('banner');
    expect(within(banner).getByRole('heading', { name: 'Chaos Simulation Lab' })).toBeTruthy();
    expect(screen.getByRole('main').contains(banner)).toBe(false);
    const live = screen.getByTestId('announcer');
    expect(live.getAttribute('aria-live')).toBe('polite');
    await waitFor(() => expect(live.textContent).toMatch(/Simulation ready\./), SLOW);
  });

  it('moves focus to the builder heading, back to the Build button, and to the step heading after a re-run', async () => {
    const pool = new FakePool();
    render(<App pool={pool} />);
    await screen.findByRole('heading', { name: 'What happened' }, SLOW);
    const build = screen.getByRole('button', { name: '✎ Build your own system' });
    fireEvent.click(build);
    const builder = screen.getByRole('region', { name: 'Build your own system' });
    expect(document.activeElement).toBe(within(builder).getAllByRole('heading')[0]);
    fireEvent.click(within(builder).getByRole('button', { name: 'Cancel' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '✎ Build your own system' }));

    // Re-run from the drawer without changes: the run is the same, so focus goes straight to the heading.
    fireEvent.click(screen.getByRole('button', { name: /Edit all settings/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Re-run simulation' }));
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'What happened' }));

    // Re-run from the failure editor with a change: focus waits for the new run.
    fireEvent.click(screen.getByRole('button', { name: 'Change failure' }));
    fireEvent.change(screen.getByLabelText(/^Traffic/), { target: { value: '80' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run simulation' }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'What happened' })), SLOW);
    expect(pool.analyzed.at(-1)!.client.rps).toBe(80);

    // On another step, the re-run lands on that step's heading.
    fireEvent.click(screen.getByRole('button', { name: /Where's the tipping point/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Change failure' }));
    fireEvent.change(screen.getByLabelText(/^Traffic/), { target: { value: '120' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run simulation' }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { name: "Where's the tipping point?" })), SLOW);
  });

  it('returns focus to the ? button when the first-visit tour closes', async () => {
    localStorage.clear();
    render(<App pool={new FakePool()} />);
    const tour = await screen.findByRole('dialog', {}, SLOW);
    fireEvent.click(within(tour).getByRole('button', { name: /Skip tour/ }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Show the guided tour' }));
  });
});
