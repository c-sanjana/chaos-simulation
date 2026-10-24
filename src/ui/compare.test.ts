import { buildRunConfig } from '../data/buildConfig';
import { executeJob } from '../worker/jobs';
import { busyAfterFailure, compareRuns, peakLoad, retriesSent, settingsChanges, type RunSnapshot } from './compare';
import { addFault, presetDraft, updateFault, updateRetries, updateScenario, updateTier, type Draft } from './draft';
import { labelsOf } from './viewModels';

const labels = labelsOf(presetDraft('retry-storm').topology);
const snapshot = (draft: Draft): RunSnapshot => {
  const config = buildRunConfig(draft.topology, draft.scenario);
  return { draft, config, result: executeJob({ kind: 'analyze', config, labels }) };
};
const singleLayer = (api: number) => updateRetries(updateRetries(updateRetries(presetDraft('retry-storm'), 'client', 0), 'gateway', 0), 'api', api);

describe('compareRuns', { timeout: 60_000 }, () => {
  const base = snapshot(presetDraft('retry-storm')); // 5 / 3 / 1: stuck

  it('says when a lot changed inside but users see the same', () => {
    const more = snapshot(updateRetries(base.draft, 'api', 5));
    const c = compareRuns(base, more, labels);
    expect(c.changes).toEqual(['App server → DB retries 1 → 5']);
    expect(c.rows.map((r) => r.label)).toEqual(['Failed requests', 'Retries sent (all layers)', 'DB load at its peak', 'App server workers busy after the failure']);
    expect(c.rows[0]).toMatchObject({ change: 'same', tone: 'same' });
    expect(c.rows[1].tone).toBe('worse');
    expect(c.rows[3]).toMatchObject({ before: expect.stringMatching(/%$/), tone: 'worse' });
    expect(c.rows[3].change).toMatch(/^\+\d+ pts$/);
    expect(c.takeaway).toBe('A lot changed inside the system, but users see about the same: it was stuck either way.');
  });

  it('shows the outcome when it changes, in both directions', () => {
    const stuck = snapshot(singleLayer(5));
    const recovers = snapshot(singleLayer(1));
    const better = compareRuns(stuck, recovers, labels);
    expect(better.rows[0]).toMatchObject({ label: 'Outcome', before: 'Stuck', now: expect.stringMatching(/^Recovers in \d+ s$/), tone: 'better' });
    expect(better.rows[1].change).toMatch(/^-\d+%$/);
    expect(better.takeaway).toBe('This change made the system recover.');
    const worse = compareRuns(recovers, stuck, labels);
    expect(worse.rows[0].tone).toBe('worse');
    expect(worse.takeaway).toBe('This change stopped the system from recovering.');
  });

  it('says when little changed, or how users fared', () => {
    const same = compareRuns(base, snapshot(updateTier(base.draft, 'cache', (t) => ({ ...t, cache: { ...t.cache!, skew: 1.01 } }))), labels);
    expect(same.takeaway).toMatch(/^(Little changed|Users see about the same)/);
    const fewer = compareRuns(snapshot(singleLayer(5)), snapshot(singleLayer(3)), labels);
    expect(fewer.takeaway).toMatch(/^(Fewer requests failed for users\.|Users see about the same: it was stuck either way\.)$/);
  });
});

describe('compareRuns when both runs recover', { timeout: 60_000 }, () => {
  it('words the takeaway for a system that recovers either way, and counts growth from zero', () => {
    const calm = (api: number) => snapshot(updateScenario(singleLayer(api), { rps: 80 }));
    const c = compareRuns(calm(0), calm(2), labels);
    expect(c.rows.find((r) => r.label === 'Retries sent (all layers)')!.change).toMatch(/^\+\d+%$/);
    expect(c.takeaway).toMatch(/recovered either way\.$|^(Fewer|More) requests failed for users\.$|^Little changed/);
  });
});

describe('run measures', { timeout: 60_000 }, () => {
  it('counts retries, peak load against capacity, and busy workers after the failure', () => {
    const s = snapshot(singleLayer(0));
    expect(retriesSent(s.result.run)).toBe(0);
    expect(peakLoad(s.config, s.result.run, 'db')).toBeGreaterThan(0.2);
    expect(peakLoad(s.config, s.result.run, 'api')).toBeNull(); // not a leaf: no fixed capacity
    expect(peakLoad(s.config, s.result.run, 'nope')).toBeNull();
    const busy = busyAfterFailure(s.config, s.result.run, 'api');
    expect(busy).toBeGreaterThanOrEqual(0);
    expect(busy).toBeLessThan(0.2);
    expect(busyAfterFailure({ ...s.config, faults: undefined }, s.result.run, 'api')).toBeGreaterThanOrEqual(0);
  });
});

describe('settingsChanges', () => {
  const d = presetDraft('retry-storm');

  it('lists traffic, run length, failures, retries, timeouts and tier settings in plain words', () => {
    let next = updateScenario(d, { rps: 150, durationMs: 90_000 });
    next = updateFault(next, { factor: 4, endMs: 40_000 });
    next = updateRetries(next, 'gateway', 0);
    next = { ...next, topology: { ...next.topology, clientCall: { ...next.topology.clientCall, timeoutMs: 5000 } } };
    next = updateTier(next, 'api', (t) => ({ ...t, instances: 6, queueLimit: 50, dropExpired: true, downstream: { ...t.downstream!, jitter: true } }));
    next = updateTier(next, 'cache', (t) => ({ ...t, cache: { ...t.cache!, ttlMs: 30_000 } }));
    expect(settingsChanges(d, next)).toEqual([
      'Traffic 200 → 150 req/s',
      'Run length 120 → 90 s',
      'DB slows 8× for 5 s at 30 s → slows 4× for 10 s at 30 s',
      'Gateway → App server retries 3 → 0',
      "Users' timeout 3000 → 5000 ms",
      'App server copies 4 → 6',
      'App server queue limit none → 50',
      'App server random retry delays off → on',
      'App server skips abandoned work off → on',
      'Cache entry lifetime 60 s → 30 s',
    ]);
  });

  it('lists added and removed failures', () => {
    const two = addFault(d);
    expect(settingsChanges(d, two)).toEqual(['Added: Gateway slows 4× for 5 s at 30 s']);
    expect(settingsChanges(two, d)).toEqual(['Removed: Gateway slows 4× for 5 s at 30 s']);
    expect(settingsChanges(d, d)).toEqual([]);
  });
});
