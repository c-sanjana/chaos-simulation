/**
 * Review 3: one rule for the part that struggled (story, fix explanations, fixes, load chart),
 * siblings that repeats did or did not reach, and the story's wording around shared parts.
 * Built systems are made the way the builder makes them (customSystem), as a user would.
 */
import { defaultCall, defaultSettings, type ComponentKind } from '../builder/graph';
import { buildRunConfig } from '../data/buildConfig';
import { cacheRestart } from '../data/scenarios';
import { webChain } from '../data/topologies';
import type { Fault, RunConfig } from '../engine/config';
import type { RunResult } from '../engine/result';
import { call, tier } from '../engine/testConfigs';
import { candidateFixes } from '../fixes/candidates';
import { customSystem } from '../ui/system';
import { bottleneckTier, topologyView } from '../ui/viewModels';
import { heaviestCallerInto, incidentWindow, loadInto, peakLoad, strugglingPart, sumRange, wholeTierDown } from './helpers';
import { computeSignals } from './signals';
import { buildStory, type StoryStep } from './story';
import { fanIn, graphLabels, splitPools } from './testGraphs';
import { analyzed } from './testRuns';

type Node = [id: string, kind: ComponentKind, label: string, col: number, row: number];

/** A system built in the builder: its config for the scenario `pick` chooses (or `faults`), simulated and told. */
function built(nodes: Node[], edges: Array<[string, string, Record<string, unknown>?]>, o: { pick?: (faults: Fault[]) => boolean; faults?: Fault[]; rps?: number } = {}) {
  const ns = nodes.map(([id, kind, label, col, row]) => ({ id, label, col, row, settings: defaultSettings(kind) }));
  const kindOf = (id: string) => ns.find((n) => n.id === id)!.settings.kind;
  const system = customSystem({ nodes: ns, edges: edges.map(([from, to, patch]) => ({ id: `${from}--${to}`, from, to, call: { ...defaultCall(kindOf(from), kindOf(to)), ...patch } })) });
  if (system.kind !== 'custom') throw new Error('expected a built system');
  const scenario = system.scenarios.find((s) => o.pick?.(s.faults) ?? true)!;
  const config = buildRunConfig(system.topology, o.faults ? { ...scenario, faults: o.faults } : scenario, o.rps ? { rps: o.rps } : {});
  const { run, analysis } = analyzed(config);
  const labels = Object.fromEntries(Object.entries(system.topology.layout).map(([id, l]) => [id, l.label]));
  return { system, config, run, analysis, labels, story: buildStory(run, config, analysis, labels), fixes: candidateFixes(config, analysis.signals, labels, run) };
}
const step = (story: StoryStep[], kind: StoryStep['kind']) => story.find((s) => s.kind === kind);
const hits = (id: string) => (faults: Fault[]) => faults.some((f) => f.tier === id);

/** App server calls Database first, then App server 2, which calls Database 2 (the user's report). */
const reported: Node[] = [
  ['c', 'client', 'Client', 1, 3],
  ['s1', 'server', 'App server', 3, 3],
  ['d1', 'database', 'Database', 5, 3],
  ['s2', 'server', 'App server 2', 7, 3],
  ['d2', 'database', 'Database 2', 9, 3],
];

describe('the part that struggled', { timeout: 60_000 }, () => {
  it('is the database still drowning after the failure, not the failed one with its own spike', () => {
    // App server 2 → Database 2 gives up after 300 ms and asks 3 more times; Database 2 slows.
    const { config, run, analysis, story, fixes } = built(reported, [['c', 's1'], ['s1', 'd1'], ['s1', 's2'], ['s2', 'd2', { timeoutMs: 300, retries: 3 }]], { pick: hits('d2') });
    expect(analysis.signals.overloaded).toMatchObject({ tier: 'd1', value: { sustained: true } });
    // Database 2's spike while it failed was higher than anything Database got...
    const [from, to] = [30, Math.floor(analysis.recovery.judgedUntilMs / 1000)];
    expect(peakLoad(config, run, 'd2', from, to)).toBeGreaterThan(peakLoad(config, run, 'd1', from, 36));
    // ...but every part of the app names Database: the story, the chart's default and the fixes.
    expect(step(story, 'overload')!.headline).toBe('Database overloaded');
    expect(step(story, 'stuck')!.text).toMatch(/with the database getting up to/);
    expect(bottleneckTier(config, run)).toBe('d1');
    expect(fixes.find((f) => f.id === 'bound-queue')!.title).toMatch(/: Database, /);
    expect(fixes.find((f) => f.id === 'longer-timeout')!.title).toMatch(/App server → Database,/);
    expect(analysis.timeline.at(-1)!.text).toMatch(/of d1 work/);
  });

  it('is the database a failed server’s repeats overload, though it is not behind that server', () => {
    const { story } = built(reported, [['c', 's1'], ['s1', 'd1'], ['s1', 's2'], ['s2', 'd2']], { faults: [{ tier: 's2', kind: 'dead', startMs: 30_000, endMs: 35_000 }] });
    expect(step(story, 'overload')).toMatchObject({ headline: 'Database overloaded', text: expect.stringMatching(/Repeats land on it too, not only on App server 2\.$/) });
    expect(step(story, 'stuck')!.text).toMatch(/with the database getting up to/);
  });

  it('ties go to the part that failed, the same in the story and the details', () => {
    // An app server asking two identical databases at once; Database 2 slows. Both end up equally overloaded.
    const db = (id: string) => tier(id, { kind: 'lognormal', medianMs: 20, p99Ms: 100 }, { workersPerInstance: 64, coresPerInstance: 4 });
    const config: RunConfig = {
      seed: 42,
      durationMs: 120_000,
      client: { rps: 120, call: call('api', { timeoutMs: 3000, retries: 2, backoffBaseMs: 100 }) },
      tiers: [
        tier('api', { kind: 'lognormal', medianMs: 4, p99Ms: 20 }, { instances: 4, workersPerInstance: 200, coresPerInstance: 4, downstream: call('a', { timeoutMs: 1000, retries: 1, backoffBaseMs: 50 }), moreDownstream: [call('b', { timeoutMs: 1000, retries: 1, backoffBaseMs: 50 })], fanOut: 'parallel' }),
        db('a'),
        db('b'),
      ],
      faults: [{ tier: 'b', kind: 'slow', factor: 8, startMs: 30_000, endMs: 35_000 }],
    };
    const { run, analysis } = analyzed(config);
    const window = incidentWindow(config, analysis.recovery);
    expect(strugglingPart(config, run, window)).toMatchObject({ id: 'b', sustained: true });
    // Swap the order of the two calls: still the failed one.
    const swapped: RunConfig = { ...config, tiers: [{ ...config.tiers[0], downstream: config.tiers[0].moreDownstream![0], moreDownstream: [config.tiers[0].downstream!] }, ...config.tiers.slice(1)] };
    expect(strugglingPart(swapped, analyzed(swapped).run, incidentWindow(swapped, analyzed(swapped).analysis.recovery))!.id).toBe('b');
    expect(analysis.timeline.at(-1)!.text).toMatch(/of b work/);
    expect(step(buildStory(run, config, analysis, { a: 'Database', b: 'Database 2' }), 'overload')!.headline).toBe('Database 2 overloaded');
  });

  it("leaves a dead part's refused requests out of its own peak", () => {
    const config = splitPools();
    const { run, analysis } = analyzed(config);
    // A flood of requests refused at once while the Green pool is down (30–35 s) is no work for it.
    const flooded: RunResult = { ...run, tiers: { ...run.tiers, green: { ...run.tiers.green, arrivalsFirst: run.tiers.green.arrivalsFirst.map((n, s) => (s >= 30 && s < 35 ? 2000 : n)) } } };
    const to = Math.floor(analysis.recovery.judgedUntilMs / 1000);
    expect(peakLoad(config, flooded, 'green', 30, to)).toBeGreaterThan(5);
    const skipDead = (s: number) => wholeTierDown(config, flooded, 'green', s);
    expect(peakLoad(config, flooded, 'green', 30, to, skipDead)).toBe(peakLoad(config, run, 'green', 30, to, skipDead));
    expect(strugglingPart(config, flooded, incidentWindow(config, analysis.recovery))!.load).toBeLessThan(2);
    expect(wholeTierDown(config, run, 'green', 29)).toBe(false);
    expect(wholeTierDown(config, run, 'blue', 32)).toBe(false);
  });
});

describe('a busy part on another branch', { timeout: 60_000 }, () => {
  it('is not blamed on repeats that never reached it', () => {
    // 3:1 split, nobody retries; the Blue pool runs near what it can handle and goes over now and then.
    const config = splitPools({ shareBlue: 3, retries: 0, clientRetries: 0, rps: 210 });
    const { run, analysis } = analyzed(config);
    const to = Math.floor(analysis.recovery.judgedUntilMs / 1000);
    expect(peakLoad(config, run, 'blue', 30, to)).toBeGreaterThan(1);
    expect(sumRange(run.tiers.blue.arrivalsRetry, 0, to) + sumRange(run.tiers.blue.arrivalsFromRepeats, 0, to)).toBe(0);
    const story = buildStory(run, config, analysis, graphLabels);
    expect(story.some((s) => /Blue pool/.test(s.headline))).toBe(false);
    expect(story.map((s) => s.text).join(' ')).not.toMatch(/Repeats land on it/);
  });

  it('is told when repeats did push it over, from the second they did', () => {
    const config = splitPools({ shareBlue: 3, clientRetries: 2 });
    const { run, analysis } = analyzed(config);
    const overload = step(buildStory(run, config, analysis, graphLabels), 'overload')!;
    expect(overload.headline).toBe('Blue pool overloaded');
    expect(overload.text).toMatch(/Repeats land on it too, not only on the Green pool\.$/);
    const s = overload.tMs / 1000;
    expect(run.tiers.blue.arrivalsRetry[s] + run.tiers.blue.arrivalsFromRepeats[s]).toBeGreaterThan(0);
  });
});

describe('a chain with a small cache and the database down', { timeout: 60_000 }, () => {
  it('tells the same story as before branching: the cache is never named as overloaded', () => {
    const config: RunConfig = {
      seed: 3,
      durationMs: 90_000,
      client: { rps: 250, call: call('api', { timeoutMs: 2000, retries: 3, backoffBaseMs: 100 }) },
      tiers: [
        tier('api', { kind: 'fixed', ms: 1 }, { instances: 2, workersPerInstance: 400, coresPerInstance: 8, cacheAside: call('cache', { timeoutMs: 200 }), downstream: call('db', { timeoutMs: 500, retries: 2, backoffBaseMs: 50 }) }),
        // A small cache: 1 core, 3 ms a lookup, so about 330 lookups a second.
        tier('cache', { kind: 'fixed', ms: 3 }, { workersPerInstance: 64, coresPerInstance: 1, cache: { capacity: 500, ttlMs: 60_000, keys: 2000, skew: 1 } }),
        tier('db', { kind: 'exponential', meanMs: 10 }, { workersPerInstance: 64, coresPerInstance: 16 }),
      ],
      faults: [{ tier: 'db', kind: 'dead', startMs: 30_000, endMs: 40_000 }],
    };
    const { run, analysis } = analyzed(config);
    const story = buildStory(run, config, analysis, { api: 'API', cache: 'Cache', db: 'DB' });
    // The texts the story told at 0a999dd, before branching (review 3, F2).
    expect(story.map((s) => `${s.kind}: ${s.text}`)).toEqual([
      'fault: At 30 s the database went down for 10 seconds.',
      "giveup: The API gets an error from the database straight away. Every layer asks again when it gives up: users' apps up to 3 times, the API twice. One failed answer can come back as many requests.",
      "cache: Cache entries ran out and weren't refilled, sending even more requests to the database.",
      'back: At 40 s the database was back up — but the pile of repeated requests was still there.',
      'stuck: It never recovered: still failing at the end of the run.',
    ]);
    // An outage is noticed at once: no timeout as the give-up step's figure (review 3).
    expect(step(story, 'giveup')!.figure).toBeUndefined();
  });
});

describe('the story around shared and numbered parts', { timeout: 60_000 }, () => {
  const lb: Node[] = [
    ['c', 'client', 'Client', 1, 3],
    ['lb', 'loadBalancer', 'Load balancer', 3, 3],
    ['s1', 'server', 'App server', 5, 2],
    ['s2', 'server', 'App server 2', 5, 4],
  ];

  it('names every part that looked things up in a cache that went down', () => {
    const { story, fixes } = built([...lb, ['k', 'cache', 'Cache', 7, 1], ['d', 'database', 'Database', 7, 3]], [['c', 'lb'], ['lb', 's1'], ['lb', 's2'], ['s1', 'k'], ['s2', 'k'], ['s1', 'd'], ['s2', 'd']], { pick: hits('k'), rps: 150 });
    expect(step(story, 'giveup')).toMatchObject({ text: 'Without the cache, the app server and App server 2 sent every lookup to the database instead.', headline: 'Lookups go to database', figure: undefined });
    const coalesce = fixes.find((f) => f.id === 'coalesce-misses')!;
    expect(coalesce.title).toBe('Coalesce concurrent cache misses: App server and App server 2');
    expect(coalesce.config.tiers.filter((t) => t.coalesceMisses).map((t) => t.id).sort()).toEqual(['s1', 's2']);
  });

  it('groups the pools a load balancer splits over: they are alternatives, not layers', () => {
    const { story } = built([...lb, ['d', 'database', 'Database', 7, 3]], [['c', 'lb'], ['lb', 's1'], ['lb', 's2'], ['s1', 'd'], ['s2', 'd']], { pick: hits('d') });
    const cause = step(story, 'giveup')!;
    expect(cause.text).toMatch(/users' apps up to twice, the load balancer once, the app server or App server 2 once\./);
    expect(cause.cascade).toEqual([
      { who: "users' apps", retries: 2 },
      { who: 'the load balancer', retries: 1 },
      { who: 'the app server or App server 2', retries: 1 },
    ]);
  });

  it("credits a shared database's arrows with the retries each caller really sent", () => {
    // App server never asks the database again; App server 2 asks 3 more times.
    const r = built([...lb, ['d', 'database', 'Database', 7, 3]], [['c', 'lb'], ['lb', 's1'], ['lb', 's2'], ['s1', 'd', { retries: 0 }], ['s2', 'd', { retries: 3 }]], { pick: hits('d') });
    for (const tMs of [31_000, 33_000, 45_000]) {
      const into = topologyView(r.system.topology, r.config, r.run, tMs).edges.filter((e) => e.to === 'd');
      const s1 = into.find((e) => e.from === 's1')!;
      const s2 = into.find((e) => e.from === 's2')!;
      expect(s1.detail).toBe('no retries');
      expect(s1.retryShare).toBe(0);
      expect(s2.detail).toMatch(/^incl\. \d+ retries$/);
      // The arrows add up to what the database got, split by what each server sent.
      const b = tMs / 1000;
      expect(s1.rps + s2.rps).toBeCloseTo(r.run.tiers.d.arrivalsFirst[b] + r.run.tiers.d.arrivalsRetry[b], 6);
      expect(s1.rps).toBe(r.run.tiers.s1.calls![0].first[b]);
    }
    // The cascade and the fixes agree: only App server 2 asks the database again.
    expect(step(r.story, 'giveup')!.cascade).toContainEqual({ who: 'App server 2', retries: 3 });
    expect(step(r.story, 'giveup')!.cascade!.map((c) => c.who)).not.toContain('the app server');
    expect(r.fixes.find((f) => f.id === 'retry-budget')!.title).toBe('Retry budget of 10%: App server 2 → Database');
  });
});

describe('who sent what into a shared part', { timeout: 60_000 }, () => {
  it('a caller whose cache absorbs most requests is not the heaviest caller of the database', () => {
    // A load balancer splits 2:1 between an API with a warm cache and a reports service without one.
    const config: RunConfig = {
      seed: 1,
      durationMs: 60_000,
      client: { rps: 300, call: call('lb', { timeoutMs: 3000 }) },
      tiers: [
        tier('lb', { kind: 'fixed', ms: 0.1 }, { workersPerInstance: 1000, downstream: call('api', { share: 2 }), moreDownstream: [call('reports')], fanOut: 'split' }),
        tier('api', { kind: 'fixed', ms: 0.5 }, { workersPerInstance: 1000, cacheAside: call('cache'), downstream: call('db', { timeoutMs: 1000 }) }),
        tier('reports', { kind: 'fixed', ms: 0.5 }, { workersPerInstance: 1000, downstream: call('db', { timeoutMs: 1000 }) }),
        tier('cache', { kind: 'fixed', ms: 0.1 }, { workersPerInstance: 1000, cache: { capacity: 1000, ttlMs: null, keys: 1000, skew: 1 } }),
        tier('db', { kind: 'fixed', ms: 1 }, { workersPerInstance: 1000, coresPerInstance: 64 }),
      ],
    };
    const { run } = analyzed(config);
    const [api, reports] = loadInto(config, 'db', run).map((l) => l.load);
    expect(api + reports).toBe(run.tiers.db.totals.arrivals);
    expect(api).toBeLessThan(reports / 10);
    expect(heaviestCallerInto(config, 'db', run)!.from).toBe('reports');
    // Without per-call counts (a hand-made result), the estimate discounts the cache's hits.
    const handMade: RunResult = { ...run, tiers: Object.fromEntries(Object.entries(run.tiers).map(([id, t]) => [id, { ...t, calls: undefined }])) };
    expect(heaviestCallerInto(config, 'db', handMade)!.from).toBe('reports');
  });

  it('only callers that sent retries are said to ask again', () => {
    // Orders waits 30 s for the database, so it never gives up and never asks again.
    const base = fanIn();
    const config: RunConfig = { ...base, tiers: base.tiers.map((t) => (t.id === 'orders' ? { ...t, downstream: { ...t.downstream!, timeoutMs: 30_000 } } : t)) };
    const { run, analysis } = analyzed(config);
    expect(sumRange(run.tiers.orders.retriesSent, 0, 120)).toBe(0);
    const cause = step(buildStory(run, config, analysis, graphLabels), 'giveup')!;
    expect(cause.text).toBe('The Reports service gives up on a database answer after 800 ms and asks again once.');
    expect(cause.cascade).toBeUndefined();
  });
});

describe('a cache-hit dip', { timeout: 60_000 }, () => {
  it('counts only when the run without the failure did not dip too', () => {
    const config = buildRunConfig(webChain, cacheRestart);
    const { run, control, analysis } = analyzed(config);
    expect(computeSignals(run, config, analysis.recovery, control).cacheHitDrop?.tier).toBe('cache');
    // The same dips in the "no-failure" run: not the failure's doing.
    expect(computeSignals(run, config, analysis.recovery, run).cacheHitDrop).toBeNull();
    // Without a control, any dip below half of normal counts.
    expect(computeSignals(run, config, analysis.recovery).cacheHitDrop?.tier).toBe('cache');
  });
});
