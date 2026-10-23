import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App } from './App';
import { FakePool } from './testing/fakePool';

vi.mock('uplot', () => import('./testing/fakeUplot'));

const SLOW = { timeout: 30_000 };

describe('App', { timeout: 60_000 }, () => {
  it('runs the default scenario and shows what happened', async () => {
    const pool = new FakePool();
    render(<App pool={pool} />);
    expect(screen.getByRole('heading', { name: 'Chaos Simulation Lab' })).toBeTruthy();
    expect(screen.getByText(/Simulating 120 s of traffic/)).toBeTruthy();
    await screen.findByRole('heading', { name: 'What happened' }, SLOW);
    expect(screen.getAllByText('Stuck: did not recover after the failure ended').length).toBeGreaterThan(0);
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
    fireEvent.change(screen.getByLabelText(/^API → DB retries/), { target: { value: '0' } });
    fireEvent.change(screen.getByLabelText(/^DB slowdown/), { target: { value: '4' } });
    fireEvent.change(screen.getByLabelText(/^Lasting/), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText(/^Starts at/), { target: { value: '20' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run simulation' }));
    await waitFor(() => expect(pool.analyzed.length).toBeGreaterThan(2), SLOW);
    const last = pool.analyzed.at(-1)!;
    expect(last.tiers.find((t) => t.id === 'api')!.downstream!.retries).toBe(0);
    expect(last.faults![0]).toMatchObject({ factor: 4, startMs: 20_000, endMs: 30_000 });
  });

  it('shows the tipping-point map, its progress and an inline replay of the selected cell', async () => {
    const pool = new FakePool();
    render(<App pool={pool} />);
    fireEvent.click(screen.getByRole('button', { name: /Where's the tipping point/ }));
    await screen.findByText('60 of 60 runs done', undefined, SLOW);
    expect(pool.cells).toHaveLength(60);
    expect(screen.getByText(/the system tips at 120 requests\/s/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /80 requests per second, 1 API → DB retries: recovers in 2 s/ })).toBeTruthy();
    await screen.findByRole('heading', { name: /Replaying 200 rps · 3 API → DB retries/ }, SLOW);
    fireEvent.click(screen.getByRole('button', { name: /^80 requests per second, 0 API → DB retries/ }));
    await screen.findByRole('heading', { name: /Replaying 80 rps · 0 API → DB retries/ }, SLOW);
    expect(screen.getByText('Recovers in 2 s')).toBeTruthy();
    // Side by side: the replay's live timeline is rendered in the map's column.
    const mapColumn = screen.getByRole('region', { name: 'Tipping point' });
    expect(mapColumn.querySelector('.csl-split__timeline .csl-timeline-title')).not.toBeNull();
  });

  it('summarises the scenario in one line on every step, and opens the editor to change it', async () => {
    const pool = new FakePool();
    render(<App pool={pool} />);
    fireEvent.click(screen.getByRole('button', { name: /Where's the tipping point/ }));
    const summary = screen.getByRole('region', { name: 'Scenario' });
    expect(summary.textContent).toMatch(/Retry storm.*DB slows 8× for 5 s at 30 s · 200 req\/s · 3 API → DB retries/);
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
    await screen.findByText(/1,234 requests failed because of the incident/, undefined, SLOW);
  });

  it('opens one tier\'s settings from its box in the topology', async () => {
    const pool = new FakePool();
    render(<App pool={pool} />);
    await screen.findByRole('heading', { name: 'What happened' }, SLOW);
    fireEvent.click(screen.getByRole('button', { name: /^Edit API settings/ }));
    const dialog = screen.getByRole('dialog', { name: 'API settings' });
    expect(within(dialog).queryByRole('group', { name: 'DB' })).toBeNull();
    expect(within(dialog).getByRole('group', { name: 'API' })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Edit all settings' }));
    expect(screen.getByRole('dialog', { name: 'All settings' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close all settings' }));
    fireEvent.click(screen.getByRole('button', { name: /^Edit Client settings/ }));
    const traffic = screen.getByRole('dialog', { name: 'Traffic settings' });
    expect(within(traffic).getByLabelText(/^User traffic/)).toBeTruthy();
    expect(within(traffic).queryByRole('group', { name: 'API' })).toBeNull();
  });

  it('edits settings in the drawer, re-runs, and can reset to the preset', async () => {
    const pool = new FakePool();
    render(<App pool={pool} />);
    await screen.findByRole('heading', { name: 'What happened' }, SLOW);
    fireEvent.click(screen.getByRole('button', { name: /Edit all settings/ }));
    const dialog = screen.getByRole('dialog');
    const api = within(dialog).getByRole('group', { name: 'API' });
    fireEvent.change(within(api).getByLabelText(/^Instances/), { target: { value: '8' } });
    fireEvent.click(within(api).getByLabelText('Jitter on retries'));
    fireEvent.click(within(api).getByLabelText('Drop requests whose caller gave up'));
    fireEvent.click(within(api).getByLabelText('Unbounded queue'));
    fireEvent.change(within(api).getByLabelText(/^Queue limit per instance/), { target: { value: '50' } });
    fireEvent.change(within(api).getByLabelText(/^Retries/), { target: { value: '1' } });
    const gateway = within(dialog).getByRole('group', { name: 'Gateway' });
    fireEvent.change(within(gateway).getByLabelText(/^Retries/), { target: { value: '2' } });
    fireEvent.change(within(gateway).getByLabelText(/^Timeout to API/), { target: { value: '1500' } });
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
    await screen.findByRole('heading', { name: 'Does a fix help?' }, SLOW);
    fireEvent.click(screen.getByRole('button', { name: 'Change failure' }));
    fireEvent.click(screen.getByRole('button', { name: /Retry storm/ }));
    await act(async () => {});
  });

  it('creates and disposes its own pool when none is injected (falls back in-process without Workers)', async () => {
    const { unmount } = render(<App />);
    await act(async () => {});
    unmount();
  });
});
