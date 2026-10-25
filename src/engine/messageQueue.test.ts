import type { Attempt } from './attempt';
import type { CallTarget } from './caller';
import { Buckets, TierMetrics } from './metrics';
import { MessageQueue } from './messageQueue';
import { Simulation } from './simulation';
import { call } from './testConfigs';

/** A downstream that records the requests it is handed and answers each `ms` later. */
class Recorder implements CallTarget {
  readonly seen: number[] = [];
  constructor(private readonly sim: Simulation, private readonly ms: number) {}
  accept(attempt: Attempt): void {
    this.seen.push(attempt.requestId);
    this.sim.schedule(this.sim.now + this.ms, () => attempt.respond('ok'));
  }
}

function setUp(consumers: number, maxDepth = 100) {
  const sim = new Simulation(1);
  const metrics = new TierMetrics(new Buckets(10_000, 1000), ['x']);
  const target = new Recorder(sim, 10);
  const queue = new MessageQueue(sim, { maxDepth, consumers }, call('x'), target, null, metrics);
  return { sim, metrics, target, queue };
}

describe('MessageQueue', () => {
  it('hands messages over oldest first, at most `consumers` at a time, and never synchronously', () => {
    const { sim, target, queue } = setUp(2);
    for (let id = 0; id < 5; id++) expect(queue.offer(id, id)).toBe(true);
    expect(target.seen).toEqual([]); // consumers start in a later event
    sim.run(0);
    expect(target.seen).toEqual([0, 1]);
    expect(queue.length).toBe(3);
    sim.run(10);
    expect(target.seen).toEqual([0, 1, 2, 3]);
    sim.run(100);
    expect(target.seen).toEqual([0, 1, 2, 3, 4]);
    expect(queue.length).toBe(0);
  });

  it('refuses messages once maxDepth are waiting', () => {
    const { queue } = setUp(1, 2);
    expect([queue.offer(1, 1), queue.offer(2, 2), queue.offer(3, 3)]).toEqual([true, true, false]);
  });

  it('pausing stops consumers, even a hand-over already scheduled; resuming starts them again', () => {
    const { sim, metrics, target, queue } = setUp(1);
    queue.offer(7, 7); // schedules a hand-over…
    queue.setPaused(true); // …which finds the consumers paused
    sim.run(1000);
    expect(target.seen).toEqual([]);
    queue.setPaused(false);
    sim.run(2000);
    expect(target.seen).toEqual([7]);
    const series = metrics.toSeries('q', { workers: 1, cores: 1, consumers: 1 }, { busyWorkersPerInstance: 0, busyCoresPerInstance: 0, queuePerInstance: 0 });
    expect(series.totals.delivered).toBe(1);
    expect(series.messageAgeMeanMs[1]).toBe(1010); // stored at 0, handed over at 1000, done at 1010
    expect(series.totals.backlogArea).toBe(1000);
  });
});
