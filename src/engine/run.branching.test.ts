/**
 * Branching: a tier with several downstream calls, made one after another ('sequence'), all at
 * once ('parallel') or one of them by share ('split'). Checked against theory where it gives an
 * exact answer (split thinning, sums and maxima of service times), plus the mechanisms (failures,
 * retries, budgets, repeats, cache-aside, fan-in) and determinism. Seeds are fixed.
 */
import type { CallPolicy, FanOut, Fault, RunConfig, ServiceTime, TierConfig } from './config';
import { STATUS_FAILED, STATUS_OK, type RunResult } from './result';
import { runSimulation } from './run';
import { call, tier } from './testConfigs';
import { mm1MeanResponseMs, mmcMeanResponseMs } from './theory';

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const relErr = (actual: number, expected: number) => Math.abs(actual - expected) / expected;
const meanLatency = (r: RunResult, id: string) => r.tiers[id].totals.latencySumMs / r.tiers[id].totals.latencyCount;
const arrivals = (r: RunResult, id: string) => r.tiers[id].totals.arrivals;
const count = (r: RunResult, status: number) => r.client.requests.status.filter((s) => s === status).length;
/** Equal but for the few attempts still in flight when the run ended. */
const nearly = (actual: number, expected: number, slack = 5) => expect(Math.abs(actual - expected)).toBeLessThanOrEqual(slack);

/** A leaf with so many workers that nothing ever queues: a call to it takes exactly its service time. */
const roomy = (id: string, service: ServiceTime, overrides: Partial<TierConfig> = {}) => tier(id, service, { workersPerInstance: 100_000, ...overrides });

/** Client → front (fixed 1 ms, never queues), which calls `calls` as `fanOut` says. */
function fanOutConfig(o: { fanOut: FanOut; calls: CallPolicy[]; leaves: TierConfig[]; rps?: number; durationMs?: number; faults?: Fault[]; clientCall?: Partial<CallPolicy>; seed?: number }): RunConfig {
  const [first, ...more] = o.calls;
  return {
    seed: o.seed ?? 11,
    durationMs: o.durationMs ?? 200_000,
    client: { rps: o.rps ?? 50, call: call('front', o.clientCall) },
    tiers: [roomy('front', { kind: 'fixed', ms: 1 }, { downstream: first, moreDownstream: more, fanOut: o.fanOut }), ...o.leaves],
    faults: o.faults ?? [],
  };
}

function expectConservation(r: RunResult) {
  for (const t of Object.values(r.tiers)) {
    const x = t.totals;
    expect(x.arrivals).toBe(x.ok + x.failed + x.rejected + x.dropped + x.inFlightAtEnd);
  }
  expect(sum(r.client.sent)).toBe(r.client.requests.status.length);
}

describe('split', { timeout: 60_000 }, () => {
  const LONG = 2_000_000;

  it('50/50 over two single-worker pools: each is an M/M/1 queue at half the traffic', () => {
    // Splitting at random thins a Poisson stream into two independent Poisson streams.
    const rps = 80; // each pool at ρ = 0.4 × 10 ms… = 40/s × 10 ms = 0.4
    const r = runSimulation(
      fanOutConfig({
        fanOut: 'split',
        rps,
        durationMs: LONG,
        calls: [call('a'), call('b')],
        leaves: [tier('a', { kind: 'exponential', meanMs: 10 }), tier('b', { kind: 'exponential', meanMs: 10 })],
      }),
    );
    expectConservation(r);
    const expected = mm1MeanResponseMs(rps / 2 / 1000, 10);
    expect(relErr(meanLatency(r, 'a'), expected)).toBeLessThan(0.03);
    expect(relErr(meanLatency(r, 'b'), expected)).toBeLessThan(0.03);
    expect(relErr(meanLatency(r, 'front'), 1 + expected)).toBeLessThan(0.03);
    expect(arrivals(r, 'a') + arrivals(r, 'b')).toBe(arrivals(r, 'front'));
  });

  it('50/50 over two identical pools behaves like one pool of double size (throughput and latency)', () => {
    // Pools of 8 workers at 40% utilisation. Two pools picked at random vs one pool of twice the
    // instances (round-robin): queueing is rare in both, so throughput and latency agree closely.
    const pool = (id: string, instances = 1) => tier(id, { kind: 'exponential', meanMs: 20 }, { instances, workersPerInstance: 8 });
    const rps = 320;
    const split = runSimulation(fanOutConfig({ fanOut: 'split', rps, durationMs: LONG / 4, calls: [call('a'), call('b')], leaves: [pool('a'), pool('b')] }));
    const single = runSimulation({
      seed: 11,
      durationMs: LONG / 4,
      client: { rps, call: call('front') },
      tiers: [roomy('front', { kind: 'fixed', ms: 1 }, { downstream: call('ab') }), pool('ab', 2)],
    });
    const throughput = (r: RunResult, ids: string[]) => sum(ids.map((id) => r.tiers[id].totals.ok));
    expect(relErr(throughput(split, ['a', 'b']), throughput(single, ['ab']))).toBeLessThan(0.005);
    expect(relErr(meanLatency(split, 'front'), meanLatency(single, 'front'))).toBeLessThan(0.02);
    // And each pool matches M/M/8 at half the traffic.
    expect(relErr(meanLatency(split, 'a'), mmcMeanResponseMs(rps / 2 / 1000, 20, 8))).toBeLessThan(0.03);
  });

  it('80/20 shares send ≈ 80% and 20% of the attempts', () => {
    const r = runSimulation(
      fanOutConfig({
        fanOut: 'split',
        rps: 200,
        calls: [call('a', { share: 4 }), call('b')],
        leaves: [roomy('a', { kind: 'fixed', ms: 1 }), roomy('b', { kind: 'fixed', ms: 1 })],
      }),
    );
    const total = arrivals(r, 'front');
    expect(total).toBeGreaterThan(39_000);
    expect(Math.abs(arrivals(r, 'a') / total - 0.8)).toBeLessThan(0.01);
    expect(arrivals(r, 'a') + arrivals(r, 'b')).toBe(total);
  });

  it('three-way shares are normalised (1 : 2 : 7)', () => {
    const r = runSimulation(
      fanOutConfig({
        fanOut: 'split',
        rps: 200,
        calls: [call('a', { share: 0.1 }), call('b', { share: 0.2 }), call('c', { share: 0.7 })],
        leaves: ['a', 'b', 'c'].map((id) => roomy(id, { kind: 'fixed', ms: 1 })),
      }),
    );
    const total = arrivals(r, 'front');
    expect(Math.abs(arrivals(r, 'a') / total - 0.1)).toBeLessThan(0.01);
    expect(Math.abs(arrivals(r, 'b') / total - 0.2)).toBeLessThan(0.01);
    expect(Math.abs(arrivals(r, 'c') / total - 0.7)).toBeLessThan(0.01);
  });

  it('a dead pool fails only the attempts sent to it; a retry may land on the other pool', () => {
    const faults: Fault[] = [{ tier: 'b', kind: 'dead', startMs: 0, endMs: 1e9 }];
    const leaves = [roomy('a', { kind: 'fixed', ms: 1 }), roomy('b', { kind: 'fixed', ms: 1 })];
    const noRetry = runSimulation(fanOutConfig({ fanOut: 'split', rps: 100, durationMs: 100_000, calls: [call('a'), call('b')], leaves, faults }));
    const sent = noRetry.client.requests.status.length;
    expect(Math.abs(count(noRetry, STATUS_FAILED) / sent - 0.5)).toBeLessThan(0.02);
    // The client retries up to 3 times: a request fails only if all 4 tries go to the dead pool.
    const retried = runSimulation(fanOutConfig({ fanOut: 'split', rps: 100, durationMs: 100_000, calls: [call('a'), call('b')], leaves, faults, clientCall: { retries: 3 } }));
    expect(Math.abs(count(retried, STATUS_FAILED) / sent - 0.5 ** 4)).toBeLessThan(0.01);
  });

  it("the split's own retry goes to another pool, so with one pool down almost every user gets an answer", () => {
    // Like nginx's proxy_next_upstream: a try that fails on the dead pool is retried elsewhere.
    const faults: Fault[] = [{ tier: 'b', kind: 'dead', startMs: 0, endMs: 1e9 }];
    const leaves = [roomy('a', { kind: 'fixed', ms: 1 }), roomy('b', { kind: 'fixed', ms: 1 }), roomy('c', { kind: 'fixed', ms: 1 })];
    for (const calls of [[call('a', { retries: 1 }), call('b', { retries: 1 })], [call('a', { retries: 2 }), call('b', { retries: 2 }), call('c', { retries: 2 })]]) {
      const r = runSimulation(fanOutConfig({ fanOut: 'split', rps: 100, durationMs: 100_000, calls, leaves: leaves.slice(0, calls.length), faults }));
      expectConservation(r);
      expect(count(r, STATUS_FAILED)).toBe(0);
      // Every try that went to b failed and was retried once, on another pool.
      expect(r.tiers.a.totals.arrivals + (r.tiers.c?.totals.arrivals ?? 0)).toBe(r.tiers.front.totals.arrivals);
      expect(sum(r.tiers.front.retriesSent)).toBe(r.tiers.b.totals.arrivals);
      // The per-call counts tell where each try went: the retries all went to the live pools.
      const sentTo = (id: string) => r.tiers.front.calls!.find((c) => c.target === id)!;
      expect(sum(sentTo('b').retries)).toBe(0);
      expect(sum(sentTo('a').retries) + (calls.length > 2 ? sum(sentTo('c').retries) : 0)).toBe(r.tiers.b.totals.arrivals);
    }
    // With shares, the retry picks again by share among the others: 1 : 3 for a and c here.
    const shared = runSimulation(
      fanOutConfig({ fanOut: 'split', rps: 200, durationMs: 200_000, calls: [call('a', { retries: 1, share: 1 }), call('b', { retries: 1, share: 4 }), call('c', { retries: 1, share: 3 })], leaves, faults }),
    );
    const retriesTo = (id: string) => sum(shared.tiers.front.calls!.find((c) => c.target === id)!.retries);
    expect(Math.abs(retriesTo('a') / (retriesTo('a') + retriesTo('c')) - 0.25)).toBeLessThan(0.02);
    // Only one call: nowhere else to go, so the retry goes back to it (a chain is unchanged).
    const single = runSimulation(fanOutConfig({ fanOut: 'split', rps: 100, durationMs: 20_000, calls: [call('b', { retries: 2 })], leaves: [leaves[1]], faults }));
    expect(single.tiers.b.totals.arrivals).toBe(3 * single.tiers.front.totals.arrivals);
  });
});

describe('sequence and parallel latency', { timeout: 60_000 }, () => {
  const exp = (meanMs: number): ServiceTime => ({ kind: 'exponential', meanMs });
  const leaves = [roomy('a', exp(10)), roomy('b', exp(20))];
  const run = (fanOut: FanOut, l = leaves) => runSimulation(fanOutConfig({ fanOut, calls: [call('a'), call('b')], leaves: l }));

  it('sequence: the mean is the sum of the calls (1 + 10 + 20 ms)', () => {
    const r = run('sequence');
    expectConservation(r);
    expect(relErr(meanLatency(r, 'front'), 31)).toBeLessThan(0.02);
    expect(arrivals(r, 'a')).toBe(arrivals(r, 'front'));
    expect(arrivals(r, 'b')).toBe(arrivals(r, 'front'));
  });

  it('parallel: the mean is the mean of the slower call, E[max] = 10 + 20 − 1/(1/10 + 1/20)', () => {
    const r = run('parallel');
    expectConservation(r);
    expect(relErr(meanLatency(r, 'front'), 1 + 30 - 1 / (1 / 10 + 1 / 20))).toBeLessThan(0.02);
  });

  it('fixed services: sequence takes exactly the sum, parallel exactly the max', () => {
    const fixed = [roomy('a', { kind: 'fixed', ms: 5 }), roomy('b', { kind: 'fixed', ms: 8 })];
    expect(meanLatency(run('sequence', fixed), 'front')).toBeCloseTo(14, 6);
    expect(meanLatency(run('parallel', fixed), 'front')).toBeCloseTo(9, 6);
    // Mixed: E[max(Exp(10), 8)] = 8 + 10·e^(−0.8).
    const mixed = [roomy('a', exp(10)), roomy('b', { kind: 'fixed', ms: 8 })];
    expect(relErr(meanLatency(run('parallel', mixed), 'front'), 1 + 8 + 10 * Math.exp(-0.8))).toBeLessThan(0.02);
  });

  it('parallel holds the worker until the slowest call answers', () => {
    // λ = 50/s × (1 + 8) ms = 0.45 workers busy on average (Little's law), not 50 × (1 + 5) ms.
    const fixed = [roomy('a', { kind: 'fixed', ms: 5 }), roomy('b', { kind: 'fixed', ms: 8 })];
    const r = run('parallel', fixed);
    expect(relErr(r.tiers.front.totals.busyWorkersArea / r.durationMs, 0.05 * 9)).toBeLessThan(0.02);
  });

  it('two branches reaching the same database draw independent service times there', () => {
    // front → a and b in parallel, both → db (exponential, 10 ms). Independent draws give
    // E[max of two] = 1.5 × 10 ms; shared draws would give 10 ms.
    const r = runSimulation(
      fanOutConfig({
        fanOut: 'parallel',
        calls: [call('a'), call('b')],
        leaves: [roomy('a', { kind: 'fixed', ms: 1 }, { downstream: call('db') }), roomy('b', { kind: 'fixed', ms: 1 }, { downstream: call('db') }), roomy('db', exp(10))],
      }),
    );
    expect(relErr(meanLatency(r, 'front'), 1 + 1 + 15)).toBeLessThan(0.02);
  });
});

describe('failures, retries and budgets per call', () => {
  const fixed = (id: string, ms = 1, overrides: Partial<TierConfig> = {}) => roomy(id, { kind: 'fixed', ms }, overrides);
  const deadAll = (id: string): Fault => ({ tier: id, kind: 'dead', startMs: 0, endMs: 1e9 });
  const run = (fanOut: FanOut, faults: Fault[], calls = [call('a'), call('b')]) =>
    runSimulation(fanOutConfig({ fanOut, rps: 20, durationMs: 50_000, calls, leaves: [fixed('a'), fixed('b')], faults }));

  it.each(['sequence', 'parallel'] as const)('%s: a failure in either call fails the attempt', (fanOut) => {
    for (const dead of ['a', 'b']) {
      const r = run(fanOut, [deadAll(dead)]);
      expect(count(r, STATUS_OK)).toBe(0);
      expect(r.tiers.front.totals.failed).toBe(r.tiers.front.totals.arrivals);
    }
    const healthy = run(fanOut, []);
    expect(count(healthy, STATUS_FAILED)).toBe(0);
  });

  it('sequence stops at the first failure; parallel makes every call anyway', () => {
    const seq = run('sequence', [deadAll('a')]);
    expect(arrivals(seq, 'b')).toBe(0);
    const par = run('parallel', [deadAll('a')]);
    expect(arrivals(par, 'b')).toBe(arrivals(par, 'front'));
    // The second call failing: the first was made and succeeded, and the attempt still fails.
    const second = run('sequence', [deadAll('b')]);
    expect(second.tiers.a.totals.ok).toBe(arrivals(second, 'front'));
  });

  it('each call keeps its own timeout and retries, and both count on the calling tier', () => {
    // a always times out (50 ms against a 10 ms timeout, 2 retries); b answers in 1 ms.
    const r = runSimulation(
      fanOutConfig({
        fanOut: 'parallel',
        rps: 20,
        durationMs: 50_000,
        calls: [call('a', { timeoutMs: 10, retries: 2 }), call('b', { timeoutMs: 10, retries: 5 })],
        leaves: [fixed('a', 50), fixed('b')],
      }),
    );
    const n = arrivals(r, 'front');
    nearly(sum(r.tiers.front.timeouts), 3 * n);
    nearly(sum(r.tiers.front.retriesSent), 2 * n);
    nearly(r.tiers.a.totals.arrivals, 3 * n);
    expect(r.tiers.b.totals.arrivals).toBe(n);
    // Timed-out calls keep running at their target: a finishes all of them, wasted.
    expect(r.tiers.a.totals.ok).toBeGreaterThan(3 * n - 10);
    expect(r.tiers.a.totals.wastedMs).toBeGreaterThan(0);
  });

  it('each call has its own retry budget', () => {
    // Both targets dead, both calls retry up to 3 times within a 10% budget. Separate budgets
    // let each call retry ~10% of its own first attempts (plus the 10 tokens a bucket starts with).
    const budgeted = [call('a', { retries: 3, retryBudget: 0.1 }), call('b', { retries: 3, retryBudget: 0.1 })];
    const r = run('parallel', [deadAll('a'), deadAll('b')], budgeted);
    for (const id of ['a', 'b']) {
      const t = r.tiers[id];
      const first = sum(t.arrivalsFirst);
      expect(sum(t.arrivalsRetry)).toBeGreaterThanOrEqual(Math.floor(0.1 * first));
      expect(sum(t.arrivalsRetry)).toBeLessThanOrEqual(Math.ceil(0.1 * first) + 10);
    }
  });

  it('first tries made for a repeat further up count as repeats at every call (fromRepeat)', () => {
    // The client gives up after 15 ms but front's answer takes 21 ms (split, parallel) or 41 ms (sequence),
    // so every request is sent twice; each of front's calls for the second try is a repeat.
    for (const fanOut of ['sequence', 'parallel', 'split'] as const) {
      const r = runSimulation(
        fanOutConfig({ fanOut, rps: 20, durationMs: 50_000, calls: [call('a'), call('b')], leaves: [fixed('a', 20), fixed('b', 20)], clientCall: { timeoutMs: 15, retries: 1 } }),
      );
      const repeats = sum(r.tiers.front.arrivalsRetry);
      nearly(repeats, sum(r.tiers.front.arrivalsFirst));
      expect(repeats).toBeGreaterThan(900);
      const fromRepeats = sum(r.tiers.a.arrivalsFromRepeats) + sum(r.tiers.b.arrivalsFromRepeats);
      if (fanOut === 'split') nearly(fromRepeats, repeats);
      else {
        nearly(sum(r.tiers.a.arrivalsFromRepeats), repeats);
        nearly(sum(r.tiers.b.arrivalsFromRepeats), repeats);
      }
      // First tries for users' own first requests are not counted as repeats.
      expect(sum(r.tiers.a.arrivalsFirst) + sum(r.tiers.b.arrivalsFirst) - fromRepeats).toBeGreaterThan(900);
    }
  });
});

describe('fan-in and cache-aside', () => {
  const fixed = (id: string, ms = 1, overrides: Partial<TierConfig> = {}) => roomy(id, { kind: 'fixed', ms }, overrides);

  it('two tiers calling the same database add up their load', () => {
    const leaves = [fixed('a', 1, { downstream: call('db') }), fixed('b', 1, { downstream: call('db') }), tier('db', { kind: 'exponential', meanMs: 2 }, { workersPerInstance: 4 })];
    for (const fanOut of ['parallel', 'sequence', 'split'] as const) {
      const r = runSimulation(fanOutConfig({ fanOut, rps: 200, durationMs: 100_000, calls: [call('a'), call('b')], leaves }));
      expectConservation(r);
      expect(arrivals(r, 'db')).toBe(arrivals(r, 'a') + arrivals(r, 'b'));
      const perRequest = fanOut === 'split' ? 1 : 2;
      nearly(arrivals(r, 'db'), perRequest * arrivals(r, 'front'));
      // Busy cores = arrival rate × mean service time.
      expect(relErr(r.tiers.db.totals.busyCoresArea / r.durationMs, 0.2 * perRequest * 2)).toBeLessThan(0.03);
    }
  });

  /** front looks keys up in a cache and, on a miss, calls a and b. */
  const cached = (fanOut: FanOut, coalesceMisses = false): RunConfig => {
    const c = fanOutConfig({ fanOut, rps: 300, durationMs: 60_000, calls: [call('a'), call('b')], leaves: [fixed('a', 20), fixed('b', 5)] });
    c.tiers[0] = { ...c.tiers[0], cacheAside: call('cache'), coalesceMisses };
    c.tiers.push(roomy('cache', { kind: 'fixed', ms: 0.5 }, { cache: { capacity: 50, ttlMs: 1000, keys: 1000, skew: 0.8 } }));
    return c;
  };

  it('a miss makes the whole fan-out; a hit makes none of it', () => {
    for (const fanOut of ['sequence', 'parallel', 'split'] as const) {
      const r = runSimulation(cached(fanOut));
      // A cache tier answers every lookup ok; the ones not found are the misses.
      const misses = r.tiers.cache.totals.ok - sum(r.tiers.cache.hits);
      expect(misses).toBeGreaterThan(1000);
      if (fanOut === 'split') expect(arrivals(r, 'a') + arrivals(r, 'b')).toBe(misses);
      else {
        expect(arrivals(r, 'a')).toBe(misses);
        // In sequence, b is called 20 ms after a: a few misses at the very end never got there.
        expect(arrivals(r, 'b')).toBeLessThanOrEqual(misses);
        expect(arrivals(r, 'b')).toBeGreaterThan(misses - 20);
      }
      expect(count(r, STATUS_FAILED)).toBe(0);
    }
  });

  it('a diamond with no queue: the next call of a sequence finds the worker its previous call just freed', () => {
    // client → W, which calls X then DB; X calls DB too. DB has one worker and turns away anything
    // it cannot start at once (queueLimit 0). Requests come every 2 s on average and take ~11 ms,
    // so they never overlap and DB is idle every time it is called (review 3, F1: W's call to DB
    // used to arrive while DB was still answering X, and was rejected).
    const diamond = (queueLimit: number | null): RunConfig => ({
      seed: 1,
      durationMs: 60_000,
      client: { rps: 0.5, call: call('w') },
      tiers: [
        fixed('w', 1, { downstream: call('x'), moreDownstream: [call('db')], fanOut: 'sequence' }),
        fixed('x', 1, { downstream: call('db') }),
        tier('db', { kind: 'fixed', ms: 5 }, { workersPerInstance: 1, queueLimit }),
      ],
    });
    for (const queueLimit of [0, null]) {
      const r = runSimulation(diamond(queueLimit));
      expectConservation(r);
      expect(sum(r.client.sent)).toBeGreaterThan(20);
      expect(count(r, STATUS_FAILED)).toBe(0);
      expect(r.tiers.db.totals.rejected).toBe(0);
      expect(r.tiers.db.peaks.queuePerInstance).toBe(0);
      expect(arrivals(r, 'db')).toBe(2 * arrivals(r, 'w'));
    }
  });

  it('counts what each call sent, so a shared database knows who sent what', () => {
    // a never asks the database again; b asks 3 more times; the database answers after the 10 ms both wait.
    const shared = fanOutConfig({
      fanOut: 'parallel',
      rps: 20,
      durationMs: 50_000,
      calls: [call('a'), call('b')],
      leaves: [fixed('a', 1, { downstream: call('db', { timeoutMs: 10 }) }), fixed('b', 1, { downstream: call('db', { timeoutMs: 10, retries: 3 }) }), fixed('db', 50)],
    });
    const r = runSimulation(shared);
    const sent = (from: string, to: string) => r.tiers[from].calls!.find((c) => c.target === to)!;
    expect(r.tiers.front.calls!.map((c) => c.target)).toEqual(['a', 'b']);
    expect(sum(sent('a', 'db').retries)).toBe(0);
    nearly(sum(sent('b', 'db').retries), 3 * sum(sent('b', 'db').first)); // but for retries the run ended before
    // Together they are exactly what the database got, second by second.
    r.tiers.db.arrivalsFirst.forEach((n, s) => {
      expect(sent('a', 'db').first[s] + sent('b', 'db').first[s]).toBe(n);
      expect(sent('b', 'db').retries[s]).toBe(r.tiers.db.arrivalsRetry[s]);
    });
    expect(sum(sent('front', 'a').first)).toBe(arrivals(r, 'front'));
    expect(r.tiers.db.calls).toEqual([]);
    // Cache lookups are a call too, listed first.
    const c = runSimulation(cached('sequence'));
    expect(c.tiers.front.calls!.map((x) => x.target)).toEqual(['cache', 'a', 'b']);
    expect(sum(c.tiers.front.calls![0].first) + sum(c.tiers.front.calls![0].retries)).toBe(arrivals(c, 'cache'));
    expect(sum(c.tiers.front.calls![1].first)).toBe(arrivals(c, 'a'));
  });

  it('with coalesced misses, a shared read is the whole fan-out', () => {
    const plain = runSimulation(cached('parallel'));
    const shared = runSimulation(cached('parallel', true));
    expect(arrivals(shared, 'a')).toBe(arrivals(shared, 'b'));
    expect(arrivals(shared, 'a')).toBeLessThan(arrivals(plain, 'a'));
    expect(count(shared, STATUS_FAILED)).toBe(0);
  });
});

describe('determinism', () => {
  const branched = (faults: Fault[] = []): RunConfig =>
    fanOutConfig({
      fanOut: 'split',
      rps: 150,
      durationMs: 30_000,
      calls: [call('a', { timeoutMs: 30, retries: 2, share: 2 }), call('b', { timeoutMs: 30, retries: 1, jitter: true, backoffBaseMs: 5 })],
      leaves: [
        tier('a', { kind: 'lognormal', medianMs: 4, p99Ms: 30 }, { workersPerInstance: 4, downstream: call('db', { timeoutMs: 20, retries: 1 }), moreDownstream: [call('c')], fanOut: 'parallel' }),
        tier('b', { kind: 'exponential', meanMs: 3 }, { workersPerInstance: 4, downstream: call('db', { timeoutMs: 20 }), moreDownstream: [call('c')] }),
        tier('c', { kind: 'exponential', meanMs: 1 }, { workersPerInstance: 8 }),
        tier('db', { kind: 'exponential', meanMs: 2 }, { workersPerInstance: 8 }),
      ],
      faults,
    });

  it('the same branched config gives an identical result', () => {
    const f: Fault[] = [{ tier: 'db', kind: 'slow', factor: 6, startMs: 10_000, endMs: 15_000 }];
    expect(runSimulation(branched(f))).toEqual(runSimulation(branched(f)));
  });

  it('a run whose failure starts after the end equals its control', () => {
    const late: Fault[] = [{ tier: 'db', kind: 'dead', startMs: 30_001, endMs: 40_000 }];
    expect(runSimulation(branched(late))).toEqual(runSimulation(branched()));
  });

  it('a chain written with branching fields gives exactly the chain result', () => {
    const chain: RunConfig = {
      seed: 3,
      durationMs: 20_000,
      client: { rps: 100, call: call('a', { timeoutMs: 50, retries: 2 }) },
      tiers: [tier('a', { kind: 'exponential', meanMs: 3 }, { workersPerInstance: 4, downstream: call('b', { timeoutMs: 20, retries: 1 }) }), tier('b', { kind: 'exponential', meanMs: 5 }, { workersPerInstance: 2 })],
    };
    const base = runSimulation(chain);
    for (const fanOut of ['sequence', 'parallel', 'split'] as const) {
      const same = { ...chain, tiers: [{ ...chain.tiers[0], moreDownstream: [], fanOut }, chain.tiers[1]] };
      expect(runSimulation(same)).toEqual(base);
    }
  });
});
