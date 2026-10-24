import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App } from './App';
import { FakePool } from './testing/fakePool';

vi.mock('uplot', () => import('./testing/fakeUplot'));

const SLOW = { timeout: 30_000 };

// The guided tour opens on a first visit; these tests start as returning visitors (the tour has its own tests).
beforeEach(() => localStorage.setItem('csl-tour-seen-v2', 'completed'));
afterEach(() => localStorage.clear());

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
    expect(screen.getByRole('heading', { name: "What's happening" })).toBeTruthy();
    expect(pool.analyzed).toHaveLength(1);
    expect(pool.analyzed[0].client.rps).toBe(200);
  });

  it('edits the failure, then re-runs only when asked', async () => {
    const pool = new FakePool();
    render(<App pool={pool} />);
    await screen.findByRole('heading', { name: 'What happened' }, SLOW);
    expect(screen.queryByLabelText(/^Traffic/)).toBeNull(); // the editor starts closed
    fireEvent.click(screen.getByRole('button', { name: 'Change failure' }));
    expect(screen.getByRole('button', { name: 'Re-run' })).toBeTruthy();
    const traffic = screen.getByLabelText(/^Traffic/);
    fireEvent.change(traffic, { target: { value: '80' } });
    expect(pool.analyzed).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Run simulation' }));
    await waitFor(() => expect(pool.analyzed.at(-1)!.client.rps).toBe(80), SLOW);
    fireEvent.click(screen.getByRole('button', { name: 'Change failure' }));
    // Retries per layer, front to back (defaults 5 / 3 / 1).
    expect(['Client → Gateway', 'Gateway → App server', 'App server → DB'].map((l) => (screen.getByLabelText(l) as HTMLInputElement).value)).toEqual(['5', '3', '1']);
    fireEvent.change(screen.getByLabelText('App server → DB'), { target: { value: '0' } });
    fireEvent.change(screen.getByLabelText('Client → Gateway'), { target: { value: '2' } });
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
    expect(screen.getByRole('region', { name: 'Scenario' }).textContent).toMatch(/\(\+1 more\).*retries 2 \/ 3 \/ 0/);
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
    expect(within(panel).getByText(/^A lot changed inside the system, but users see about the same/)).toBeTruthy();
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
    fireEvent.click(screen.getByRole('button', { name: /^Gateway slows down/ }));
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
    expect(screen.getByText(/Every layer asks again when it gives up \(Client 5×, Gateway 3×, App server 1×\)/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /80 requests per second, 1s failure length: recovers in 2 s/ })).toBeTruthy();
    await screen.findByRole('heading', { name: /Replaying 200 req\/s · 5s failure length/ }, SLOW);
    fireEvent.click(screen.getByRole('button', { name: /^80 requests per second, 12s failure length/ }));
    await screen.findByRole('heading', { name: /Replaying 80 req\/s · 12s failure length/ }, SLOW);
    expect(screen.getByText('Recovers in 2 s')).toBeTruthy();
    // Side by side: map on the left; the replay on the right, with its compact story and details beside the chart.
    expect(screen.getByRole('region', { name: 'What is happening, in plain words' }).closest('.csl-player__timeline--side')).not.toBeNull();
    const timeline = screen.getByRole('region', { name: 'Details: what was measured' });
    expect(timeline.closest('.csl-player__timeline--side')).not.toBeNull();
    expect(screen.getByRole('region', { name: 'Tipping point' }).contains(timeline)).toBe(false);
  });

  it('summarises the scenario in one line on every step, and opens the editor to change it', async () => {
    const pool = new FakePool();
    render(<App pool={pool} />);
    fireEvent.click(screen.getByRole('button', { name: /Where's the tipping point/ }));
    const summary = screen.getByRole('region', { name: 'Scenario' });
    expect(summary.textContent).toMatch(/Retry storm.*DB slows 8× for 5 s at 30 s · 200 req\/s · retries 5 \/ 3 \/ 1/);
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
    fireEvent.click(screen.getByRole('button', { name: 'Close all settings' }));
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
    fireEvent.change(within(api).getByLabelText(/^Instances/), { target: { value: '8' } });
    fireEvent.click(within(api).getByLabelText('Jitter on retries'));
    fireEvent.click(within(api).getByLabelText('Drop requests whose caller gave up'));
    fireEvent.click(within(api).getByLabelText('Unbounded queue'));
    fireEvent.change(within(api).getByLabelText(/^Queue limit per instance/), { target: { value: '50' } });
    fireEvent.change(within(api).getByLabelText(/^Retries/), { target: { value: '1' } });
    const gateway = within(dialog).getByRole('group', { name: 'Gateway' });
    fireEvent.change(within(gateway).getByLabelText(/^Retries/), { target: { value: '2' } });
    fireEvent.change(within(gateway).getByLabelText(/^Timeout to App server/), { target: { value: '1500' } });
    fireEvent.change(within(gateway).getByLabelText(/^Backoff base/), { target: { value: '20' } });
    fireEvent.change(within(gateway).getByLabelText(/^Service time median/), { target: { value: '2' } });
    fireEvent.change(within(gateway).getByLabelText(/^Service time p99/), { target: { value: '9' } });
    fireEvent.change(within(gateway).getByLabelText(/^Workers per instance/), { target: { value: '100' } });
    fireEvent.change(within(gateway).getByLabelText(/^Cores per instance/), { target: { value: '2' } });
    const cache = within(dialog).getByRole('group', { name: 'Cache' });
    fireEvent.change(within(cache).getByLabelText(/^Capacity/), { target: { value: '500' } });
    fireEvent.change(within(cache).getByLabelText(/^TTL/), { target: { value: '30' } });
    fireEvent.change(within(cache).getByLabelText(/^Distinct keys requested/), { target: { value: '5000' } });
    fireEvent.change(within(cache).getByLabelText(/^Popularity skew/), { target: { value: '0.8' } });
    fireEvent.change(within(dialog).getByLabelText(/^User traffic/), { target: { value: '150' } });
    fireEvent.change(within(dialog).getByLabelText(/^Duration/), { target: { value: '90' } });
    fireEvent.change(within(dialog).getByLabelText(/^Client timeout/), { target: { value: '2500' } });
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
    fireEvent.click(screen.getByRole('button', { name: 'Close all settings' }));
    expect(screen.queryByRole('dialog')).toBeNull();
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
    await waitFor(() => expect(pool.analyzed.at(-1)!.client.rps).toBe(200), SLOW); // the demo's run
    const tour = await screen.findByRole('dialog', {}, SLOW);
    expect(screen.getByRole('region', { name: 'Scenario' }).textContent).toMatch(/200 req\/s/);
    // Each demo stop moves the replay to its moment.
    fireEvent.click(within(tour).getByRole('button', { name: 'Next' }));
    expect(within(screen.getByRole('dialog')).getByText('Normal traffic')).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy()); // playing forward to 20 s
    fireEvent.keyDown(document, { key: 'ArrowLeft' });
    await waitFor(() => expect(Number((screen.getByLabelText('Playback position') as HTMLInputElement).value)).toBe(0)); // back: jumps
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(pool.analyzed.at(-1)!.client.rps).toBe(80), SLOW); // the viewer's settings, back
    expect(screen.getByRole('region', { name: 'Scenario' }).textContent).toMatch(/80 req\/s/);
  });

  it('explains invalid input and blocks running it', async () => {
    const pool = new FakePool();
    render(<App pool={pool} />);
    await screen.findByRole('heading', { name: 'What happened' }, SLOW);
    fireEvent.click(screen.getByRole('button', { name: 'Change failure' }));
    const traffic = screen.getByLabelText(/^Traffic/);
    fireEvent.change(traffic, { target: { value: '100000' } });
    expect(screen.getByText('Enter a whole number from 1 to 5000')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Re-run' }));
    expect(pool.analyzed).toHaveLength(1); // nothing ran
    fireEvent.change(traffic, { target: { value: '200' } });
    fireEvent.change(screen.getByLabelText(/^Starts at/), { target: { value: '500' } });
    expect(screen.getByRole('alert').textContent).toMatch(/The failure must end at least 20 s before the run ends/);
    const run = screen.getByRole('button', { name: 'Run simulation' }) as HTMLButtonElement;
    expect(run.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/^Starts at/), { target: { value: '30' } });
    expect(run.disabled).toBe(false);
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
    fireEvent.click(screen.getByRole('button', { name: 'Close all settings' }));
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
    // The canvas opens on the example system, drawn.
    const builder = screen.getByRole('region', { name: 'Build your own system' });
    expect(within(builder).getByText(/Branching is coming next/)).toBeTruthy();
    fireEvent.click(within(builder).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('region', { name: 'Build your own system' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '✎ Build your own system' }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect((screen.getByRole('button', { name: 'Use this topology' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getAllByRole('button', { name: 'Start from the example' })[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Use this topology' }));
    // New tier ids: the old run must never be shown against the new system.
    await screen.findByRole('heading', { name: 'What happened' }, SLOW);
    await waitFor(() => expect(pool.analyzed.at(-1)!.tiers.map((t) => t.id)).toEqual(['loadBalancer-1', 'server-1', 'cache-1', 'database-1']), SLOW);
    expect(screen.getByRole('region', { name: 'Scenario' }).textContent).toMatch(/^Database slows down/);
    fireEvent.click(screen.getByRole('button', { name: 'Change failure' }));
    expect(screen.getAllByRole('button', { name: /slows down|restarts empty/ }).map((b) => b.textContent!.split(/(?<=down|empty)/)[0])).toEqual(['Database slows down', 'Cache restarts empty', 'Load balancer slows down']);
    fireEvent.click(screen.getByRole('button', { name: /^Cache restarts empty/ }));
    await waitFor(() => expect(pool.analyzed.at(-1)!.faults![0].tier).toBe('cache-1'), SLOW);
    fireEvent.click(screen.getByRole('button', { name: /Where's the tipping point/ }));
    await screen.findByText(/Traffic × failure length/, undefined, SLOW);
    fireEvent.click(screen.getByRole('button', { name: /Does a fix help/ }));
    // Edit the built system again; then go back to the example.
    fireEvent.click(screen.getByRole('button', { name: '✎ Edit your system' }));
    fireEvent.click(screen.getByRole('button', { name: 'Use the example system instead' }));
    await waitFor(() => expect(pool.analyzed.at(-1)!.tiers.map((t) => t.id)).toEqual(['gateway', 'api', 'cache', 'db']), SLOW);
    expect(screen.getByRole('button', { name: '✎ Build your own system' })).toBeTruthy();
  });
});
