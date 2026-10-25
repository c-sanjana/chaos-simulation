/** Graph-aware analysis: the call-graph helpers, and stories, timelines and signals of branched systems. */
import { buildRunConfig } from '../data/buildConfig';
import { retryStorm } from '../data/scenarios';
import { webChain } from '../data/topologies';
import type { RunConfig } from '../engine/config';
import type { RunResult } from '../engine/result';
import { call, tier } from '../engine/testConfigs';
import {
  allCallEdges,
  callersInFront,
  callersOf,
  callFraction,
  callsFrom,
  callsLeadingTo,
  callsPerRequest,
  doesWork,
  heaviestCallerInto,
  heaviestPathTo,
  loadInto,
  reachableFrom,
  sentAlong,
  strictestCallerInto,
  tiersLeadingTo,
  topologicalOrder,
  trafficShares,
  type CallEdge,
} from './helpers';
import { buildStory, type StoryStep } from './story';
import { analyzed } from './testRuns';
import { fanIn, graphLabels, queueBranch, splitPools, webWithSearch } from './testGraphs';

const fixed = { kind: 'fixed', ms: 1 } as const;
const cacheTier = tier('cache', fixed, { cache: { capacity: 1, ttlMs: null, keys: 2, skew: 1 } });

/**
 * Users → LB splitting 3:1 over A and B. A looks things up in a cache, then asks the DB and Search
 * at once; B asks the DB. Fan-out, fan-in, a split and a cache in one.
 */
const graph: RunConfig = {
  seed: 1,
  durationMs: 1000,
  client: { rps: 1, call: call('lb', { timeoutMs: 3000 }) },
  tiers: [
    tier('lb', fixed, { downstream: call('a', { timeoutMs: 2000, share: 3 }), moreDownstream: [call('b', { timeoutMs: 1500 })], fanOut: 'split' }),
    tier('a', fixed, { cacheAside: call('cache', { timeoutMs: 50 }), downstream: call('db', { timeoutMs: 800 }), moreDownstream: [call('search', { timeoutMs: 900 })], fanOut: 'parallel' }),
    tier('b', fixed, { downstream: call('db', { timeoutMs: 500 }) }),
    cacheTier,
    tier('db', { kind: 'exponential', meanMs: 20 }, { workersPerInstance: 8, coresPerInstance: 4 }),
    tier('search', fixed),
  ],
};
const lb = graph.tiers[0];
const a = graph.tiers[1];
const b = graph.tiers[2];

describe('call-graph helpers', () => {
  it('lists every call a caller makes, cache lookup first', () => {
    expect(callsFrom(graph, 'client')).toEqual([{ from: 'client', kind: 'call', index: 0, policy: graph.client.call }]);
    expect(callsFrom(graph, 'a')).toEqual([
      { from: 'a', kind: 'cacheAside', index: 0, policy: a.cacheAside },
      { from: 'a', kind: 'downstream', index: 0, policy: a.downstream },
      { from: 'a', kind: 'downstream', index: 1, policy: a.moreDownstream![0] },
    ]);
    expect(callsFrom(graph, 'db')).toEqual([]);
    expect(callsFrom(graph, 'nobody')).toEqual([]);
    expect(allCallEdges(graph).map((e) => `${e.from}→${e.policy.target}`)).toEqual(['client→lb', 'lb→a', 'lb→b', 'a→cache', 'a→db', 'a→search', 'b→db']);
  });

  it('finds every caller of a tier (fan-in), the least patient and the heaviest', () => {
    expect(callersOf(graph, 'db').map((e) => e.from)).toEqual(['a', 'b']);
    expect(callersOf(graph, 'lb').map((e) => e.from)).toEqual(['client']);
    expect(callersOf(graph, 'nobody')).toEqual([]);
    expect(strictestCallerInto(graph, 'db')!.from).toBe('b');
    expect(strictestCallerInto(graph, 'nobody')).toBeNull();
    // No timeouts at all: the first caller.
    const patient: RunConfig = { ...graph, tiers: graph.tiers.map((t) => (t.id === 'b' ? { ...b, downstream: call('db') } : t.id === 'a' ? { ...a, downstream: call('db') } : t)) };
    expect(strictestCallerInto(patient, 'db')!.from).toBe('a');
    // Without a run, by share of user traffic: A gets 3/4 of it, B 1/4.
    expect(loadInto(graph, 'db').map((l) => l.load)).toEqual([0.75, 0.25]);
    expect(heaviestCallerInto(graph, 'db')!.from).toBe('a');
    expect(heaviestCallerInto(graph, 'lb')!.from).toBe('client');
    expect(heaviestCallerInto(graph, 'nobody')).toBeNull();
  });

  it('measures load from a run when given one', () => {
    const series = (arrivals: number, retries: number) => ({ arrivalsFirst: [arrivals], arrivalsRetry: [0], retriesSent: [retries] });
    const run = { client: { sent: [10] }, tiers: { a: series(100, 0), b: series(30, 400) } } as unknown as RunResult;
    // A: 100 × 1 (parallel); B: (30 + 400 retries over its one call) × 1.
    expect(loadInto(graph, 'db', run).map((l) => l.load)).toEqual([100, 430]);
    expect(heaviestCallerInto(graph, 'db', run)!.from).toBe('b');
    expect(loadInto(graph, 'lb', run)[0].load).toBe(10);
    // A caller missing from the run counts as nothing; a split call carries its share.
    expect(loadInto(graph, 'db', { ...run, tiers: { b: series(1, 0) } } as unknown as RunResult).map((l) => l.load)).toEqual([0, 1]);
    expect(loadInto(graph, 'a', { ...run, tiers: { lb: series(100, 40) } } as unknown as RunResult)[0].load).toBe((100 + 40 / 2) * 0.75);
  });

  it('reads what one call sent from the per-call counts, or estimates it without them', () => {
    const series = (first: number, retry: number, sent: number, calls?: unknown) => ({ arrivalsFirst: [first], arrivalsRetry: [retry], retriesSent: [sent], ...(calls ? { calls } : {}) });
    const [toDbFromA] = callsFrom(graph, 'a').slice(1);
    const [toDbFromB] = callsFrom(graph, 'b');
    const toLb = callsFrom(graph, 'client')[0];
    // Without per-call counts: the target's arrivals for a single caller, else the caller's own retries or an even split.
    const guessed = { client: { sent: [10] }, tiers: { lb: series(10, 2, 0), a: series(5, 0, 7), b: series(5, 0, 1), db: series(30, 8, 0) } } as unknown as RunResult;
    expect(sentAlong(graph, guessed, toLb, 'all')).toEqual([12]);
    expect(sentAlong(graph, guessed, toDbFromA, 'retries')).toEqual([7]);
    expect(sentAlong(graph, guessed, toDbFromB, 'all')).toEqual([19]);
    // With them: exactly what each call sent.
    const counted = { ...guessed, tiers: { ...guessed.tiers, a: series(5, 0, 7, [{ target: 'db', first: [20], retries: [6] }]), b: series(5, 0, 1, [{ target: 'db', first: [10], retries: [2] }]) } } as unknown as RunResult;
    expect(sentAlong(graph, counted, toDbFromA, 'all')).toEqual([26]);
    expect(sentAlong(graph, counted, toDbFromB, 'retries')).toEqual([2]);
  });

  it('gives each call its share of the caller’s attempts and each tier its share of user traffic', () => {
    const [toA, toB] = callsFrom(graph, 'lb');
    expect(callFraction(graph, toA)).toBe(0.75);
    expect(callFraction(graph, toB)).toBe(0.25);
    for (const e of callsFrom(graph, 'a')) expect(callFraction(graph, e)).toBe(1);
    expect(callFraction(graph, callsFrom(graph, 'client')[0])).toBe(1);
    expect(trafficShares(graph)).toEqual({ lb: 1, a: 0.75, b: 0.25, cache: 0.75, db: 1, search: 0.75 });
    // A split of one call is a chain; a tier nothing reaches gets 0.
    const single: RunConfig = { ...graph, tiers: [{ ...lb, moreDownstream: [] }, ...graph.tiers.slice(1), tier('lonely', fixed)] };
    expect(trafficShares(single)).toMatchObject({ a: 1, b: 0, lonely: 0 });
    // The web chain: every tier sees every request (cache hits ignored).
    expect(trafficShares(buildRunConfig(webChain, retryStorm))).toEqual({ lb: 1, api: 1, cache: 1, db: 1 });
  });

  it('orders tiers front to back', () => {
    expect(topologicalOrder(graph)).toEqual(['lb', 'a', 'b', 'cache', 'db', 'search']);
    expect(topologicalOrder(buildRunConfig(webChain, retryStorm))).toEqual(['lb', 'api', 'cache', 'db']);
    // The client's target first even when listed last; tiers on a cycle are left out.
    const cyclic: RunConfig = { ...graph, client: { rps: 1, call: call('x') }, tiers: [tier('p', fixed, { downstream: call('q') }), tier('q', fixed, { downstream: call('p') }), tier('x', fixed)] };
    expect(topologicalOrder(cyclic)).toEqual(['x']);
  });

  it('answers questions about the ways to a tier without listing them', () => {
    const route = (calls: CallEdge[]) => calls.map((e) => `${e.from}→${e.policy.target}`).join(' ');
    // Tiers a request can reach the database from, and the calls on some way to it.
    expect([...tiersLeadingTo(graph, 'db')].sort()).toEqual(['a', 'b', 'db', 'lb']);
    expect([...tiersLeadingTo(graph, 'db', (id) => id !== 'a')].sort()).toEqual(['b', 'db', 'lb']);
    expect(tiersLeadingTo(graph, 'nobody').size).toBe(0);
    expect(route(callsLeadingTo(graph, 'db'))).toBe('client→lb lb→a lb→b a→db b→db');
    expect(route(callsLeadingTo(graph, 'cache'))).toBe('client→lb lb→a a→cache');
    expect(callsLeadingTo(graph, 'client')).toEqual([]);
    // The heaviest way by a weight: by default ties go to the first found.
    expect(route(heaviestPathTo(graph, 'db', () => 1)!.calls)).toBe('client→lb lb→a a→db');
    expect(route(heaviestPathTo(graph, 'db', (e) => (e.from === 'b' ? 3 : 1))!.calls)).toBe('client→lb lb→b b→db');
    expect(heaviestPathTo(graph, 'db', (e) => (e.from === 'b' ? 3 : 2))!.product).toBe(12);
    expect(heaviestPathTo(graph, 'client', () => 1)).toBeNull();
    // Starting afresh at a tier (a queue), and only ways through one call.
    const restarted = heaviestPathTo(graph, 'db', () => 2, (id) => id === 'a')!;
    expect([restarted.product, route(restarted.calls)]).toEqual([8, 'client→lb lb→b b→db']);
    expect(route(heaviestPathTo(graph, 'db', () => 2, (id) => id === 'a', callsFrom(graph, 'a')[1])!.calls)).toBe('a→db');
    expect(heaviestPathTo(graph, 'db', () => 2, (id) => id === 'b', callsFrom(graph, 'lb')[1])).toBeNull();
    // A ladder of 30 diamonds has 2^30 ways; each answer still takes one pass.
    const tiers = [];
    for (let i = 0; i < 30; i++) {
      tiers.push(tier(`n${i}`, fixed, { downstream: call(`l${i}`), moreDownstream: [call(`r${i}`)] }), tier(`l${i}`, fixed, { downstream: call(`n${i + 1}`) }), tier(`r${i}`, fixed, { downstream: call(`n${i + 1}`) }));
    }
    const ladder: RunConfig = { ...graph, client: { rps: 1, call: call('n0') }, tiers: [...tiers, tier('n30', fixed), tier('orphan', fixed)] };
    const started = performance.now();
    expect(heaviestPathTo(ladder, 'n30', () => 2)!.product).toBe(2 ** 61);
    expect(callsLeadingTo(ladder, 'orphan')).toEqual([]);
    expect(callsLeadingTo(ladder, 'n30')).toHaveLength(1 + 30 * 4);
    // n_i, l_i and r_i each get 2^i of every request, n30 2^30: the calls multiply.
    expect(callsPerRequest(ladder)).toBe(4 * 2 ** 30 - 3);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it('finds what a tier reaches and who is in front of it', () => {
    expect(reachableFrom(graph, 'lb')).toEqual(['a', 'cache', 'db', 'search', 'b']);
    // The parts that do the work themselves: not the cache, which only answers lookups.
    expect(graph.tiers.filter(doesWork).map((t) => t.id)).toEqual(['db', 'search']);
    expect(callersInFront(graph, 'db')).toEqual(['a', 'b', 'lb', 'client']);
    expect(callersInFront(graph, 'client')).toEqual([]);
  });
});

const storyOf = (config: RunConfig) => {
  const { run, analysis } = analyzed(config);
  return { story: buildStory(run, config, analysis, graphLabels), analysis, run };
};
const step = (story: StoryStep[], kind: StoryStep['kind']) => story.find((s) => s.kind === kind)!;

describe('stories and timelines of branched systems', { timeout: 60_000 }, () => {
  it('a second call behind the app server: the cascade is the layers on the way to the database', () => {
    for (const fanOut of ['sequence', 'parallel'] as const) {
      const { story } = storyOf(webWithSearch(fanOut));
      const cause = step(story, 'giveup');
      expect(cause.text).toBe(
        "The app server gives up on a database answer after 1 s. Every layer retries when it gives up: users' apps up to 5 times, the load balancer 3 times, the app server once. One slow answer can come back as many requests.",
      );
      expect(cause.cascade).toEqual([
        { who: "users' apps", retries: 5 },
        { who: 'the load balancer', retries: 3 },
        { who: 'the app server', retries: 1 },
      ]);
      // A miss reads from both: an emptied cache sends more requests to each.
      expect(story.map((s) => s.text).join(' ')).toContain('sending even more requests to the database and the Search service.');
    }
  });

  it('a split pool going down: the load balancer says what share it sends there', () => {
    const { story, analysis } = storyOf(splitPools());
    expect(step(story, 'giveup').text).toBe(
      'The load balancer gets an error from the Green pool straight away and retries up to 2 times. The load balancer sends 50% of its requests to the Green pool.',
    );
    // The load balancer's own retries go to the Blue pool, so no user saw an error.
    expect(analysis.recovery.failedRequests).toBe(0);
    expect(step(story, 'recovered').text).toMatch(/^It was back to normal \d s after the failure ended\.$/);
  });

  it('a split pool going down can overload the other pool, and the story says so', () => {
    const { story } = storyOf(splitPools({ shareBlue: 3, clientRetries: 2 }));
    const cause = step(story, 'giveup');
    expect(cause.text).toContain('The load balancer sends 25% of its requests to the Green pool.');
    expect(cause.text).toContain("Every layer retries when it gives up: users' apps up to twice, the load balancer twice.");
    expect(step(story, 'overload').text).toContain('the Blue pool got more requests than it can handle');
    expect(step(story, 'stuck').text).toMatch(/with the Blue pool getting up to \d\.\d× the work it can handle\.$/);
  });

  it('fan-in: the caller that gives up first tells the story, and the timeline names it', () => {
    const { story, analysis } = storyOf(fanIn());
    const cause = step(story, 'giveup');
    expect(cause.text).toMatch(/^The Reports service gives up on a database answer after 800 ms\. Several layers retry when they give up: the Orders service once, the Reports service once\./);
    expect(cause.headline).toBe('The Reports service gives up, others retry');
    // (The analysis is labelled with the web app's names: ids elsewhere.)
    const texts = analysis.timeline.map((e) => e.text);
    expect(texts.some((t) => /^DB p99 .* exceeds the reports's 800 ms timeout$/.test(t))).toBe(true);
    expect(texts.some((t) => /^DB queue holds .* against the reports's 800 ms timeout/.test(t))).toBe(true);
    expect(analysis.signals.queueWaitOverTimeout?.tier).toBe('db');
  });

  it('a queue shields the callers in front of it only on paths that go through it', () => {
    // Only through the queue: users' apps and the front never see the database fail.
    const shielded = step(storyOf(queueBranch(false)).story, 'giveup');
    expect(shielded.text).toBe('The queue gets an error from the database straight away and retries up to 2 times.');
    expect(shielded.cascade).toBeUndefined();
    // Also through the app server: they do, and ask again.
    const open = step(storyOf(queueBranch(true)).story, 'giveup');
    expect(open.cascade?.map((c) => c.who)).toEqual(["users' apps", 'the Front', 'the queue', 'the app server']);
  });

  it('a cache in front of a split: lookups go to one or the other', () => {
    const base = splitPools({ faults: [{ tier: 'cache', kind: 'dead', startMs: 30_000, endMs: 35_000 }] });
    const config: RunConfig = {
      ...base,
      tiers: [...base.tiers.map((t) => (t.id === 'lb' ? { ...t, cacheAside: call('cache', { timeoutMs: 100 }) } : t)), { ...cacheTier, cache: { capacity: 200, ttlMs: 60_000, keys: 1000, skew: 1 } }],
    };
    const cause = step(storyOf(config).story, 'giveup');
    expect(cause.text).toMatch(/^Without the cache, the load balancer sent every lookup to the Blue pool or the Green pool instead\./);
    expect(cause.headline).toMatch(/^Lookups go to Blue pool or Green pool/);
  });

  it('a cache in front of a fan-out: both calls behind it count, the layer by its call that asks most', () => {
    const base = webWithSearch('parallel', 200, [{ tier: 'cache', kind: 'dead', startMs: 30_000, endMs: 35_000, flushAtEnd: true }]);
    // Search as slow as the database, so the stampede overloads both and both calls ask again.
    const db = base.tiers.find((t) => t.id === 'db')!;
    const config: RunConfig = {
      ...base,
      tiers: base.tiers.map((t) => (t.id === 'api' ? { ...t, moreDownstream: [{ ...t.moreDownstream![0], retries: 3 }] } : t.id === 'search' ? { ...t, service: db.service } : t)),
    };
    const { story } = storyOf(config);
    const cause = step(story, 'giveup');
    expect(cause.text).toMatch(/^Without the cache, the app server sent every lookup to the database and the Search service instead\./);
    expect(cause.cascade).toContainEqual({ who: 'the app server', retries: 3 });
  });
});
