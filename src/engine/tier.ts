import type { Attempt, FinalState } from './attempt';
import { callWithRetries, type CallTarget } from './caller';
import type { TierConfig } from './config';
import { sampleServiceTime } from './distributions';
import { Instance } from './instance';
import { RoundRobin, type LoadBalancer } from './loadBalancer';
import type { TierMetrics } from './metrics';
import type { TierSeries } from './result';
import { Stream, uniform } from './rng';
import type { Simulation } from './simulation';

/**
 * A tier (service, database, …): a set of identical instances behind a load balancer.
 *
 * Handling an attempt: compute on a core for a sampled service time, then (if the tier has a
 * downstream) call it with the tier's call policy while holding the worker, then respond.
 * ASSUMPTION: all compute happens before the downstream call (one compute phase per attempt).
 */
export class Tier implements CallTarget {
  readonly instances: Instance[];
  private downstream: Tier | null = null;
  private readonly balancer: LoadBalancer = new RoundRobin();

  constructor(
    private readonly sim: Simulation,
    readonly config: TierConfig,
    /** Position in the run config; part of the key for this tier's random values. */
    readonly index: number,
    readonly metrics: TierMetrics,
  ) {
    this.instances = Array.from(
      { length: config.instances },
      () => new Instance(this, config.workersPerInstance, config.coresPerInstance, config.queueLimit),
    );
  }

  get now(): number {
    return this.sim.now;
  }

  get dropExpired(): boolean {
    return this.config.dropExpired;
  }

  connect(downstream: Tier): void {
    this.downstream = downstream;
  }

  accept(attempt: Attempt): void {
    this.metrics.arrival(this.sim.now, attempt.isRetry);
    this.instances[this.balancer.pick(this.instances.length)].accept(attempt);
  }

  /** Called by an instance when a worker picks up the attempt. */
  process(attempt: Attempt, instance: Instance): void {
    instance.withCore(() => {
      const u = uniform(this.sim.seed, Stream.Service, attempt.requestId, attempt.pathHash, this.index);
      const ms = sampleServiceTime(this.config.service, u);
      attempt.computeMs += ms;
      this.metrics.compute(ms);
      this.sim.schedule(this.sim.now + ms, () => {
        instance.releaseCore();
        this.afterCompute(attempt, instance);
      });
    });
  }

  /** Responds for an attempt that never got a worker (rejected or dropped). */
  respondUnstarted(attempt: Attempt, state: 'rejected' | 'dropped'): void {
    this.metrics.response(this.sim.now, attempt, state);
    attempt.respond(state);
  }

  series(): TierSeries {
    const c = this.config;
    const peak = (f: (i: Instance) => number) => Math.max(...this.instances.map(f));
    return this.metrics.toSeries(
      c.id,
      { workers: c.instances * c.workersPerInstance, cores: c.instances * c.coresPerInstance },
      {
        busyWorkersPerInstance: peak((i) => i.peakBusyWorkers),
        busyCoresPerInstance: peak((i) => i.peakBusyCores),
        queuePerInstance: peak((i) => i.peakQueue),
      },
    );
  }

  private afterCompute(attempt: Attempt, instance: Instance): void {
    // `downstream` is connected exactly when the config has a downstream policy (see runSimulation).
    if (this.downstream === null) {
      this.finish(attempt, instance, 'ok');
      return;
    }
    attempt.state = 'waiting';
    callWithRetries(this.sim, this.config.downstream!, this.downstream, attempt.requestId, attempt.pathHash, this.metrics, (ok) =>
      this.finish(attempt, instance, ok ? 'ok' : 'failed'),
    );
  }

  private finish(attempt: Attempt, instance: Instance, state: FinalState): void {
    this.metrics.response(this.sim.now, attempt, state);
    attempt.respond(state);
    instance.freeWorker();
  }
}
