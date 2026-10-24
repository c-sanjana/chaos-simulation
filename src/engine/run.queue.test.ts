/**
 * Asynchronous message queues: queueing theory for the consumer side, decoupling of producers,
 * full queues, dead-lettering, faults on the queue itself, and determinism.
 */
import type { CallPolicy, Fault, RunConfig, ServiceTime } from './config';
import { STATUS_OK, type RunResult } from './result';
import { runSimulation } from './run';
import { call, tier } from './testConfigs';
import { mg1MeanResponseMs, mmcMeanResponseMs } from './theory';

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const mean = (xs: number[]) => sum(xs) / xs.length;
const relErr = (actual: number, expected: number) => Math.abs(actual - expected) / expected;

interface QueuedOptions {
  rps: number;
  consumers: number;
  /** The consumers' downstream: a leaf with plenty of workers, so a call takes exactly its service time. */
  leaf: ServiceTime;
  durationMs: number;
  maxDepth?: number;
  consume?: Partial<CallPolicy>;
  faults?: Fault[];
  queueInstances?: number;
  seed?: number;
}

/** Client → queue (stores in a fixed 1 ms, with plenty of workers) → leaf. */
function queued(o: QueuedOptions): RunConfig {
  return {
    seed: o.seed ?? 5,
    durationMs: o.durationMs,
    client: { rps: o.rps, call: call('q') },
    tiers: [
      tier('q', { kind: 'fixed', ms: 1 }, {
        instances: o.queueInstances ?? 1,
        workersPerInstance: 50,
        queue: { maxDepth: o.maxDepth ?? 1_000_000, consumers: o.consumers },
        downstream: call('leaf', o.consume),
      }),
      tier('leaf', o.leaf, { workersPerInstance: 500 }),
    ],
    faults: o.faults ?? [],
  };
}

/** Attempts are conserved at every tier, and every stored message is accounted for exactly once. */
function expectConservation(r: RunResult) {
  for (const t of Object.values(r.tiers)) {
    const x = t.totals;
    expect(x.arrivals).toBe(x.ok + x.failed + x.rejected + x.dropped + x.inFlightAtEnd);
    expect(x.delivered).toBe(sum(t.delivered));
    expect(x.deadLettered).toBe(sum(t.deadLettered));
    if (t.consumers > 0) {
      // A queue tier's ok responses are exactly the messages it stored.
      expect(x.ok).toBe(x.delivered + x.deadLettered + x.backlogAtEnd + x.inProcessingAtEnd);
      expect(x.inProcessingAtEnd).toBeLessThanOrEqual(t.consumers);
      expect(Math.max(...t.busyConsumersAvg)).toBeLessThanOrEqual(t.consumers + 1e-9);
    } else {
      expect(x.delivered + x.deadLettered + x.backlogAtEnd + x.inProcessingAtEnd + x.backlogArea + t.peaks.backlog).toBe(0);
      expect(t.backlogAvg.every((v) => v === 0)).toBe(true);
      expect(t.messageAgeMeanMs.every(Number.isNaN)).toBe(true);
    }
  }
}

describe('message queue vs queueing theory', { timeout: 120_000 }, () => {
  // 4 consumers calling a leaf that takes exactly 100 ms: they can deliver c/s = 40 messages/s.
  const C = 4;
  const S = 100;
  const capacity = (C / S) * 1000;

  it('overloaded (λ = 60/s > c/s = 40/s): delivers c/s per second and the backlog grows at λ − c/s', () => {
    const T = 500;
    const r = runSimulation(queued({ rps: 60, consumers: C, leaf: { kind: 'fixed', ms: S }, durationMs: T * 1000 }));
    const q = r.tiers.q;
    // Consumers are never idle, so each second delivers exactly 40 (±1 where a finish lands on a
    // bucket edge, as 100 ms steps add up in floating point).
    for (let s = 5; s < T; s++) expect(Math.abs(q.delivered[s] - capacity)).toBeLessThanOrEqual(1);
    expect(relErr(q.totals.delivered / T, capacity)).toBeLessThan(0.002);
    // Growth = arrivals − deliveries. Arrivals are Poisson: over 500 s the backlog of ~10,000 has a
    // standard deviation of √(60 × 500) ≈ 173 (1.7%); 5% is about 3σ.
    expect(relErr(q.totals.backlogAtEnd / T, 60 - capacity)).toBeLessThan(0.05);
    expect(relErr((q.backlogAvg[T - 1] - q.backlogAvg[T / 2]) / (T / 2 - 1), 60 - capacity)).toBeLessThan(0.05);
    expect(q.peaks.backlog).toBeGreaterThanOrEqual(q.totals.backlogAtEnd);
    expect(mean(q.busyConsumersAvg.slice(5))).toBeCloseTo(C, 6);
    // Producers are unaffected: every request is answered after the 1 ms store.
    expect(sum(r.client.ok)).toBe(r.client.requests.status.length);
    expectConservation(r);
  });

  it('underloaded (λ = 20/s < c/s): delivers λ and the backlog stays near zero', () => {
    const T = 500;
    const r = runSimulation(queued({ rps: 20, consumers: C, leaf: { kind: 'fixed', ms: S }, durationMs: T * 1000 }));
    const q = r.tiers.q;
    // Everything stored is delivered except the few messages in flight at the end.
    expect(q.totals.delivered).toBeGreaterThanOrEqual(q.totals.ok - 2 * C);
    expect(relErr(q.totals.delivered / T, 20)).toBeLessThan(0.03); // Poisson: √(20 × 500) / 10,000 = 1%
    expect(q.totals.backlogArea / (T * 1000)).toBeLessThan(0.1);
    expect(q.peaks.backlog).toBeLessThan(15);
    expectConservation(r);
  });

  it('one consumer and fixed service is M/D/1: message age and backlog match Pollaczek–Khinchine', () => {
    // Producers store in exactly 1 ms with no queueing, so messages arrive as a Poisson stream, and
    // a consumer's call takes exactly 20 ms: M/D/1 at ρ = 0.6. Same run length and tolerance as the
    // engine's own M/D/1 accuracy test.
    const T = 5_000_000;
    const r = runSimulation({ ...queued({ rps: 30, consumers: 1, leaf: { kind: 'fixed', ms: 20 }, durationMs: T }), bucketMs: T });
    const q = r.tiers.q;
    const W = mg1MeanResponseMs(0.03, 20, 400); // 35 ms: 15 ms waiting + 20 ms being handled
    expect(relErr(q.messageAgeMeanMs[0], W)).toBeLessThan(0.03);
    // Little's law on the waiting part: average backlog = delivery rate × mean wait (≈ 0.45).
    expect(relErr(q.totals.backlogArea / T, (q.totals.delivered / T) * (W - 20))).toBeLessThan(0.04);
    expect(q.messageAgeP99Ms[0]).toBeGreaterThan(W);
    expectConservation(r);
  });

  it('four consumers and exponential service is M/M/4 (Erlang C): mean message age', () => {
    const T = 5_000_000;
    const r = runSimulation({ ...queued({ rps: 100, consumers: 4, leaf: { kind: 'exponential', meanMs: 30 }, durationMs: T }), bucketMs: T });
    expect(relErr(r.tiers.q.messageAgeMeanMs[0], mmcMeanResponseMs(0.1, 30, 4))).toBeLessThan(0.04);
  });

  it('after a downstream slowdown, the backlog drains at c/s − λ', () => {
    // λ = 20/s. The leaf slows 4× for 100 s, so consumers deliver 10/s and ~1,000 messages pile up;
    // afterwards they deliver 40/s, so the backlog drains at 20/s: ~50 s.
    // Tolerance: the backlog is a random walk with drift −20/s and variance λ = 20 per second, so the
    // time to empty from x₀ has standard deviation √(x₀λ/20³) ≈ 1.6 s on ~50 s (3%). Reading it at
    // 1 s resolution adds up to ~1 s. 10% (5 s) is about 3σ.
    const end = 120_000;
    const r = runSimulation(
      queued({ rps: 20, consumers: C, leaf: { kind: 'fixed', ms: S }, durationMs: 250_000, faults: [{ tier: 'leaf', kind: 'slow', factor: 4, startMs: 20_000, endMs: end }] }),
    );
    const q = r.tiers.q;
    const x0 = q.backlogAvg[end / 1000 - 1];
    expect(x0).toBeGreaterThan(800);
    expect(x0).toBeLessThan(1200);
    // Slowed consumers each finish every 400 ms (2 or 3 per second), 10/s between them.
    expect(relErr(mean(q.delivered.slice(25, 119)), capacity / 4)).toBeLessThan(0.02);
    const drainedAt = q.backlogAvg.findIndex((b, s) => s >= end / 1000 && b < 1);
    const drainS = drainedAt - end / 1000;
    const predictedS = x0 / (capacity - 20);
    expect(Math.abs(drainS - predictedS) / predictedS).toBeLessThan(0.1);
    // While draining, consumers run flat out; afterwards they deliver what arrives.
    for (let s = end / 1000 + 1; s < drainedAt - 1; s++) expect(Math.abs(q.delivered[s] - capacity)).toBeLessThanOrEqual(1);
    expect(relErr(mean(q.delivered.slice(drainedAt + 5)), 20)).toBeLessThan(0.05);
    expectConservation(r);
  });
});

describe('message queue behaviour', { timeout: 60_000 }, () => {
  const healthy = () => queued({ rps: 50, consumers: 4, leaf: { kind: 'fixed', ms: 50 }, durationMs: 30_000, consume: { timeoutMs: 200, retries: 2, backoffBaseMs: 10 } });

  it('producers wait only for the store, whatever happens downstream', () => {
    const base = runSimulation(healthy());
    const leafFault = (kind: 'slow' | 'dead'): Fault => ({ tier: 'leaf', kind, factor: 100, startMs: 5_000, endMs: 25_000 });
    for (const fault of [leafFault('slow'), leafFault('dead')]) {
      const r = runSimulation({ ...healthy(), faults: [fault] });
      // Users see exactly the same thing: every request answered after the 1 ms store.
      expect(r.client.requests).toEqual(base.client.requests);
      const { latencyMs, status } = r.client.requests;
      status.forEach((s, i) => {
        expect(s).toBe(STATUS_OK);
        expect(latencyMs[i]).toBeCloseTo(1, 9);
      });
      expect(r.tiers.q.latencyMeanMs.filter((x) => !Number.isNaN(x)).every((x) => Math.abs(x - 1) < 1e-9)).toBe(true);
      // …while behind the queue, messages were held up or lost.
      expect(r.tiers.q.totals.deadLettered).toBeGreaterThan(0); // refused, or timed out every try
      if (fault.kind === 'slow') {
        expect(sum(r.tiers.q.timeouts)).toBeGreaterThan(0);
        expect(r.tiers.q.peaks.backlog).toBeGreaterThan(500);
      }
      expectConservation(r);
    }
  });

  it('a full queue rejects producers', () => {
    // 1 consumer at 10 messages/s against 30/s: the backlog fills to 50 and stays there.
    const r = runSimulation(queued({ rps: 30, consumers: 1, leaf: { kind: 'fixed', ms: 100 }, durationMs: 60_000, maxDepth: 50 }));
    const q = r.tiers.q;
    expect(q.peaks.backlog).toBe(50);
    expect(relErr(q.totals.rejected / 60, 20)).toBeLessThan(0.1);
    expect(sum(r.client.failed)).toBe(q.totals.rejected); // the client does not retry
    expect(q.totals.ok + q.totals.rejected).toBe(q.totals.arrivals - q.totals.inFlightAtEnd);
    expect(q.latencyMeanMs.slice(10).every((x) => Math.abs(x - 1) < 1e-9)).toBe(true); // rejected after the store compute
    expectConservation(r);
  });

  it('a dead downstream dead-letters every message after its retries', () => {
    const r = runSimulation({ ...healthy(), faults: [{ tier: 'leaf', kind: 'dead', startMs: 0, endMs: 30_000 }] });
    const q = r.tiers.q.totals;
    const leaf = r.tiers.leaf.totals;
    expect(q.delivered).toBe(0);
    expect(q.deadLettered).toBeGreaterThan(1000);
    expect(r.tiers.q.messageAgeMeanMs.every(Number.isNaN)).toBe(true);
    // Each message is tried 3 times (refused at once), backing off 10 then 20 ms.
    const retries = sum(r.tiers.q.retriesSent);
    expect(retries).toBeGreaterThanOrEqual(2 * q.deadLettered);
    expect(retries).toBeLessThanOrEqual(2 * (q.deadLettered + q.inProcessingAtEnd));
    expect(leaf.arrivals).toBe(q.deadLettered + q.inProcessingAtEnd + retries);
    expect(leaf.failed).toBe(leaf.arrivals);
    expectConservation(r);
  });

  it('consumer calls that time out count as this tier\'s timeouts, and its retry budget limits retries', () => {
    const r = runSimulation(
      queued({ rps: 50, consumers: 20, leaf: { kind: 'fixed', ms: 1000 }, durationMs: 30_000, consume: { timeoutMs: 100, retries: 3, retryBudget: 0.1 } }),
    );
    const q = r.tiers.q;
    expect(sum(q.timeouts)).toBeGreaterThan(100);
    expect(q.totals.delivered).toBe(0);
    const retries = sum(q.retriesSent);
    const firstTries = r.tiers.leaf.totals.arrivals - retries;
    expect(retries).toBeGreaterThan(0);
    expect(retries).toBeLessThanOrEqual(0.1 * firstTries + 10);
    expect(r.tiers.leaf.totals.wastedMs).toBeGreaterThan(0); // the leaf kept working for consumers that left
    expectConservation(r);
  });

  it('a dead queue refuses producers and pauses its consumers, then resumes; nothing stored is lost', () => {
    // 60/s against 40/s of consumer capacity, so a backlog is waiting when the queue dies at 10 s.
    const r = runSimulation(
      queued({ rps: 60, consumers: 4, leaf: { kind: 'fixed', ms: 100 }, durationMs: 40_000, faults: [{ tier: 'q', kind: 'dead', startMs: 10_000, endMs: 20_000 }] }),
    );
    const q = r.tiers.q;
    const { arrivalMs, status } = r.client.requests;
    arrivalMs.forEach((t, i) => {
      if (t >= 10_000 && t < 20_000) expect(status[i]).not.toBe(STATUS_OK);
    });
    for (let s = 11; s < 20; s++) {
      expect(q.delivered[s]).toBe(0);
      expect(q.busyConsumersAvg[s]).toBe(0);
      expect(q.backlogAvg[s]).toBe(q.backlogAvg[11]); // frozen: nothing stored, nothing taken
    }
    expect(q.backlogAvg[11]).toBeGreaterThan(150); // ~20/s for 10 s
    // The 4 consumers restart together at 20 s, so a finish landing on a bucket edge (100 ms steps
    // add up in floating point) moves all four at once: 40 ± 4 per second, 40 on average.
    for (let s = 21; s < 40; s++) expect(Math.abs(q.delivered[s] - 40)).toBeLessThanOrEqual(4);
    expect(mean(q.delivered.slice(21, 39))).toBeCloseTo(40, 0);
    expect(q.totals.deadLettered).toBe(0);
    expectConservation(r);
  });

  it('one dead instance of a queue tier refuses its share of producers but does not pause the consumers', () => {
    const r = runSimulation(
      queued({ rps: 20, consumers: 4, leaf: { kind: 'fixed', ms: 100 }, durationMs: 30_000, queueInstances: 2, faults: [{ tier: 'q', instance: 0, kind: 'dead', startMs: 0, endMs: 30_000 }] }),
    );
    const q = r.tiers.q.totals;
    expect(q.failed / q.arrivals).toBeCloseTo(0.5, 2);
    expect(q.delivered).toBeGreaterThanOrEqual(q.ok - 4);
    expectConservation(r);
  });

  it('a slow queue slows only the store', () => {
    const r = runSimulation({ ...healthy(), faults: [{ tier: 'q', kind: 'slow', factor: 5, startMs: 10_000, endMs: 20_000 }] });
    const { arrivalMs, latencyMs } = r.client.requests;
    arrivalMs.forEach((t, i) => {
      if (t >= 10_000 && t < 20_000) expect(latencyMs[i]).toBeCloseTo(5, 9);
    });
    // Consumers and their downstream calls are untouched: every call still takes exactly 50 ms.
    expect(r.tiers.leaf.totals.computeMs).toBeCloseTo(50 * r.tiers.leaf.totals.arrivals, 6);
    expectConservation(r);
  });

  it('flushAtEnd does not empty a queue', () => {
    const config = queued({ rps: 60, consumers: 4, leaf: { kind: 'fixed', ms: 100 }, durationMs: 30_000 });
    const flushed = runSimulation({ ...config, faults: [{ tier: 'q', kind: 'slow', factor: 1, startMs: 10_000, endMs: 15_000, flushAtEnd: true }] });
    const plain = runSimulation(config);
    expect(flushed.tiers).toEqual(plain.tiers);
  });

  it('a queue can hand messages to another queue', () => {
    const config: RunConfig = {
      seed: 2,
      durationMs: 20_000,
      client: { rps: 30, call: call('q1') },
      tiers: [
        tier('q1', { kind: 'fixed', ms: 1 }, { workersPerInstance: 10, queue: { maxDepth: 1000, consumers: 2 }, downstream: call('q2') }),
        tier('q2', { kind: 'fixed', ms: 1 }, { workersPerInstance: 10, queue: { maxDepth: 1000, consumers: 2 }, downstream: call('leaf') }),
        tier('leaf', { kind: 'fixed', ms: 50 }, { workersPerInstance: 10 }),
      ],
    };
    const r = runSimulation(config);
    // q1's consumers are done as soon as q2 has stored the message.
    expect(r.tiers.q1.totals.delivered).toBe(r.tiers.q2.totals.ok);
    expect(Math.max(...r.tiers.q1.messageAgeMeanMs.filter((x) => !Number.isNaN(x)))).toBeLessThan(5);
    expect(r.tiers.q2.totals.delivered).toBeGreaterThan(500);
    expectConservation(r);
  });
});

describe('message queue determinism', () => {
  const config = () => queued({ rps: 60, consumers: 3, leaf: { kind: 'lognormal', medianMs: 40, p99Ms: 200 }, durationMs: 30_000, consume: { timeoutMs: 150, retries: 2, backoffBaseMs: 20, jitter: true } });

  it('the same seed gives an identical result', () => {
    expect(runSimulation(config())).toEqual(runSimulation(config()));
  });

  it('a different seed gives a different result', () => {
    expect(runSimulation({ ...config(), seed: 99 }).tiers.q.totals).not.toEqual(runSimulation(config()).tiers.q.totals);
  });

  it('a run and its control share random values: a fault that changes nothing changes nothing', () => {
    const control = runSimulation(config());
    // A failure that starts after the run ends…
    const after = runSimulation({ ...config(), faults: [{ tier: 'leaf', kind: 'dead', startMs: 40_000, endMs: 50_000 }] });
    expect(after).toEqual(control);
    // …and one active mid-run that has no effect (slowdown × 1), on the queue and on its downstream.
    for (const t of ['q', 'leaf']) {
      const noop = runSimulation({ ...config(), faults: [{ tier: t, kind: 'slow', factor: 1, startMs: 10_000, endMs: 20_000 }] });
      expect(noop.tiers).toEqual(control.tiers);
      expect(noop.client).toEqual(control.client);
    }
  });
});
