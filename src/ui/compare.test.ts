import { buildRunConfig } from '../data/buildConfig';
import { executeJob } from '../worker/jobs';
import { busyAfterFailure, compareRuns, peakLoad, retriesSent, retryTakeaway, settingsChanges, type ComparisonRow, type RunSnapshot } from './compare';
import { addFault, presetDraft, updateFault, updateRetries, updateScenario, updateTier, type Draft } from './draft';
import { chainGraph } from '../builder/testGraphs';
import { customSystem } from './system';
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
    expect(c.rows.map((r) => r.label)).toEqual(['Failed requests', 'Retries sent (all layers)', 'DB peak load over the whole run', 'App server workers busy after the failure']);
    expect(c.rows[0]).toMatchObject({ change: 'same', tone: 'same' });
    expect(c.rows[1].tone).toBe('worse');
    expect(c.rows[3]).toMatchObject({ before: expect.stringMatching(/%$/), tone: 'worse' });
    expect(c.rows[3].change).toMatch(/^\+\d+ pts$/);
    // Only retries changed: the takeaway says why, from the run.
    expect(c.takeaway).toBe("The App server retried more, adding repeats. It was stuck either way because users' apps (5×), the Gateway (3×) and the App server (5×) multiply the load.");
  });

  it('says why cutting users\' retries made things worse: the other layers still multiply the load', () => {
    const fewer = snapshot(updateRetries(base.draft, 'client', 1));
    const c = compareRuns(base, fewer, labels);
    expect(c.rows[0].label).toBe('Failed requests');
    if (c.rows[0].tone === 'worse') {
      expect(c.takeaway).toBe('Users retried less, so more failures reached them directly. It was still stuck because users\' apps (1×), the Gateway (3×) and the App server (1×) still multiply the load.');
    } else {
      expect(c.takeaway).toMatch(/^Users retried less(, so fewer repeats piled up and fewer requests failed)?\. It was still stuck because/);
    }
  });

  it('shows the outcome when it changes, in both directions', () => {
    const stuck = snapshot(singleLayer(5));
    const recovers = snapshot(singleLayer(1));
    const better = compareRuns(stuck, recovers, labels);
    expect(better.rows[0]).toMatchObject({ label: 'Outcome', before: 'Stuck', now: expect.stringMatching(/^Recovers in \d+ s$/), tone: 'better' });
    expect(better.rows[1].change).toMatch(/^-\d+%$/);
    expect(better.takeaway).toBe('With fewer repeats from the App server, the load fell enough for the system to recover.');
    const worse = compareRuns(recovers, stuck, labels);
    expect(worse.rows[0].tone).toBe('worse');
    expect(worse.takeaway).toBe('The App server retried more, and the extra repeats kept the system from recovering.');
    // A change other than retries keeps the plain takeaway.
    const slower = compareRuns(recovers, snapshot(updateFault(singleLayer(1), { endMs: 45_000 })), labels);
    expect(slower.takeaway).toMatch(/^This change (stopped the system from recovering|made the system recover)\.$|^(Little changed|Users see|Fewer|More|A lot)/);
  });

  it('says when little changed, or how users fared', () => {
    const same = compareRuns(base, snapshot(updateTier(base.draft, 'cache', (t) => ({ ...t, cache: { ...t.cache!, skew: 1.01 } }))), labels);
    expect(same.takeaway).toMatch(/^(Little changed|Users see about the same)/);
    const fewer = compareRuns(snapshot(singleLayer(5)), snapshot(singleLayer(3)), labels);
    expect(fewer.takeaway).toMatch(/^The App server retried less(, so fewer repeats piled up and fewer requests failed|, so more failures reached users directly)?\. It was still stuck because the App server \(3×\) still multiplies the load\.$/);
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

describe('compareRuns behind a queue', { timeout: 60_000 }, () => {
  it('counts messages dropped behind the queue', () => {
    const system = customSystem(chainGraph(['client', 'loadBalancer', 'queue', 'server', 'database']));
    if (system.kind !== 'custom') throw new Error('expected a built system');
    const queueLabels = labelsOf(system.topology);
    const scenario = system.scenarios.find((x) => x.id === 'custom-db-slow')!;
    const run = (seconds: number): RunSnapshot => {
      const draft = { topology: system.topology, scenario: { ...scenario, rps: 100, faults: [{ tier: 'n4', kind: 'dead' as const, startMs: 30_000, endMs: 30_000 + seconds * 1000 }] } };
      const config = buildRunConfig(draft.topology, draft.scenario);
      return { draft, config, result: executeJob({ kind: 'analyze', config, labels: queueLabels }) };
    };
    const row = compareRuns(run(5), run(10), queueLabels).rows.find((r) => r.label === 'Messages dropped behind the queue')!;
    expect(row.tone).toBe('worse');
    expect(Number(row.now.replace(/,/g, ''))).toBeGreaterThan(Number(row.before.replace(/,/g, '')));
  });
});

describe('retryTakeaway', () => {
  const d = presetDraft('retry-storm');
  const rows = (tone: ComparisonRow['tone']): ComparisonRow[] => [{ label: 'Failed requests', before: '1', now: '2', change: '+1', tone }];
  const changes = (next: Draft) => settingsChanges(d, next);
  it('tells retry changes as cause and effect, and stays out of the way otherwise', () => {
    const gw = updateRetries(d, 'gateway', 1);
    expect(retryTakeaway(d, gw, changes(gw), 'recovered', 'recovered', rows('worse'))).toBe('The Gateway retried less, so more failures reached users directly. It recovered either way.');
    expect(retryTakeaway(d, gw, changes(gw), 'stuck', 'stuck', rows('same'))).toBe("The Gateway retried less. It was still stuck because users' apps (5×), the Gateway (1×) and the App server (1×) still multiply the load.");
    const users = updateRetries(d, 'client', 8);
    expect(retryTakeaway(d, users, changes(users), 'recovered', 'recovered', rows('better'))).toBe('Users retried more, adding repeats, yet fewer requests failed. It recovered either way.');
    const none = updateRetries(updateRetries(updateRetries(d, 'client', 0), 'gateway', 0), 'api', 0);
    expect(retryTakeaway(d, none, changes(none), 'stuck', 'stuck', rows('worse'))).toBe("Users' apps, the Gateway and the App server retried less, so more failures reached users directly. It was still stuck.");
    // Up at one layer and down at another, or another setting changed: no clear story.
    const mixed = updateRetries(updateRetries(d, 'client', 1), 'api', 3);
    expect(retryTakeaway(d, mixed, changes(mixed), 'stuck', 'stuck', rows('same'))).toBeNull();
    const traffic = updateScenario(gw, { rps: 150 });
    expect(retryTakeaway(d, traffic, changes(traffic), 'stuck', 'stuck', rows('same'))).toBeNull();
    expect(retryTakeaway(d, d, [], 'stuck', 'stuck', rows('same'))).toBeNull();
    expect(retryTakeaway(d, users, changes(users), 'stuck', 'recovered', rows('better'))).toBeNull();
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
