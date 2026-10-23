import type { Attempt, FinalState } from './attempt';
import { CacheStore, ZipfKeys } from './cache';
import { callWithRetries, type CallTarget } from './caller';
import type { Fault, TierConfig } from './config';
import { sampleServiceTime } from './distributions';
import { Instance } from './instance';
import { RoundRobin, type LoadBalancer } from './loadBalancer';
import type { TierMetrics } from './metrics';
import type { TierSeries } from './result';
import { Stream, uniform } from './rng';
import type { Simulation } from './simulation';

/**
 * A tier (gateway, API, cache, database…): a set of identical instances behind a load balancer.
 *
 * Handling an attempt: compute on a core for a sampled service time, then
 * - a cache tier answers hit/miss from its store;
 * - a tier with `cacheAside` looks the request's key up in its cache tier and, on a miss, calls
 *   downstream and writes the key back if that succeeded;
 * - otherwise, a tier with a downstream calls it (holding the worker throughout);
 * then it responds.
 *
 * ASSUMPTION: all compute happens before the downstream call (one compute phase per attempt).
 */
export class Tier implements CallTarget {
  readonly instances: Instance[];
  private downstream: Tier | null = null;
  private cacheTier: Tier | null = null;
  private readonly balancer: LoadBalancer = new RoundRobin();
  /** Present on cache tiers. */
  private readonly store: CacheStore | null = null;
  private readonly keys: ZipfKeys | null = null;
  /** Active fault effects, per instance. */
  private readonly slowFactor: number[];
  private readonly dead: boolean[];

  constructor(
    private readonly sim: Simulation,
    readonly config: TierConfig,
    /** Position in the run config; part of the key for this tier's random values. */
    readonly index: number,
    readonly metrics: TierMetrics,
  ) {
    this.instances = Array.from(
      { length: config.instances },
      (_, i) => new Instance(this, i, config.workersPerInstance, config.coresPerInstance, config.queueLimit),
    );
    this.slowFactor = new Array<number>(config.instances).fill(1);
    this.dead = new Array<boolean>(config.instances).fill(false);
    if (config.cache) {
      this.store = new CacheStore(config.cache.capacity, config.cache.ttlMs);
      this.keys = new ZipfKeys(config.cache.keys, config.cache.skew);
      this.warmUp();
    }
  }

  get now(): number {
    return this.sim.now;
  }

  get dropExpired(): boolean {
    return this.config.dropExpired;
  }

  connect(downstream: Tier | null, cacheTier: Tier | null): void {
    this.downstream = downstream;
    this.cacheTier = cacheTier;
  }

  accept(attempt: Attempt): void {
    this.metrics.arrival(this.sim.now, attempt.isRetry);
    const i = this.balancer.pick(this.instances.length);
    if (this.dead[i]) {
      this.respondUnstarted(attempt, 'failed'); // connection refused: fails fast, holds nothing
      return;
    }
    this.instances[i].accept(attempt);
  }

  /** Called by an instance when a worker picks up the attempt. */
  process(attempt: Attempt, instance: Instance): void {
    instance.withCore(() => {
      const u = uniform(this.sim.seed, Stream.Service, attempt.requestId, attempt.pathHash, this.index);
      // ASSUMPTION: a slowdown applies to computes that start while it is active.
      const ms = sampleServiceTime(this.config.service, u) * this.slowFactor[instance.index];
      attempt.computeMs += ms;
      this.metrics.compute(ms);
      this.sim.schedule(this.sim.now + ms, () => {
        instance.releaseCore();
        this.afterCompute(attempt, instance);
      });
    });
  }

  /** Responds for an attempt that never got a worker (rejected, dropped, or refused by a dead tier). */
  respondUnstarted(attempt: Attempt, state: 'rejected' | 'dropped' | 'failed'): void {
    this.metrics.response(this.sim.now, attempt, state);
    attempt.respond(state);
  }

  /** The key a request asks this cache tier for: fixed per request, popular keys more likely. */
  keyFor(requestId: number): number {
    return this.keys!.sample(uniform(this.sim.seed, Stream.CacheKey, requestId));
  }

  /**
   * Writes a key after a successful downstream read. Lost if the cache is entirely down.
   * ASSUMPTION: writes are fire-and-forget, take effect immediately and cost the cache nothing;
   * all instances of a cache tier share one logical store.
   */
  writeKey(key: number): void {
    if (!this.dead.every(Boolean)) this.store!.set(key, this.sim.now);
  }

  /**
   * Starts (`active`) or ends a fault.
   * ASSUMPTION: overlapping faults on the same instance are not combined; the latest change wins.
   * ASSUMPTION: a dead tier refuses new attempts; work already in progress or queued carries on.
   */
  setFault(fault: Fault, active: boolean): void {
    const targets = fault.instance === undefined ? this.instances.map((_, i) => i) : [fault.instance];
    for (const i of targets) {
      if (fault.kind === 'slow') this.slowFactor[i] = active ? fault.factor ?? 1 : 1;
      else this.dead[i] = active;
    }
    if (!active && fault.flushAtEnd) this.store?.clear();
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

  /**
   * Starts the cache warm: holding the most popular keys, with expiries spread across one TTL so they
   * don't all expire at the same moment.
   * ASSUMPTION: a warm cache's contents ≈ the `capacity` most popular keys (true for LRU under Zipf).
   */
  private warmUp(): void {
    const { capacity, keys, ttlMs } = this.config.cache!;
    for (let key = Math.min(capacity, keys) - 1; key >= 0; key--) {
      const expiry = ttlMs === null ? Infinity : uniform(this.sim.seed, Stream.CacheKey, key, 1) * ttlMs;
      this.store!.set(key, 0, expiry);
    }
  }

  private afterCompute(attempt: Attempt, instance: Instance): void {
    if (this.store !== null) {
      attempt.hit = this.store.get(attempt.key, this.sim.now);
      if (attempt.hit) this.metrics.cacheHit(this.sim.now);
      this.finish(attempt, instance, 'ok');
    } else if (this.cacheTier !== null) {
      this.lookUpThenCall(attempt, instance, this.cacheTier);
    } else if (this.downstream !== null) {
      this.callDownstream(attempt, instance, null);
    } else {
      this.finish(attempt, instance, 'ok');
    }
  }

  /** Cache-aside: a failed cache call is treated as a miss. Validation guarantees a downstream exists. */
  private lookUpThenCall(attempt: Attempt, instance: Instance, cacheTier: Tier): void {
    attempt.state = 'waiting';
    const key = cacheTier.keyFor(attempt.requestId);
    callWithRetries(
      this.sim,
      this.config.cacheAside!,
      cacheTier,
      attempt.requestId,
      attempt.pathHash,
      this.metrics,
      (ok, lookup) => {
        if (ok && lookup.hit) this.finish(attempt, instance, 'ok');
        else this.callDownstream(attempt, instance, key);
      },
      (lookup) => (lookup.key = key),
    );
  }

  /** `downstream` is connected exactly when the config has a downstream policy (see runSimulation). */
  private callDownstream(attempt: Attempt, instance: Instance, cacheKey: number | null): void {
    attempt.state = 'waiting';
    callWithRetries(this.sim, this.config.downstream!, this.downstream!, attempt.requestId, attempt.pathHash, this.metrics, (ok) => {
      if (ok && cacheKey !== null) this.cacheTier!.writeKey(cacheKey);
      this.finish(attempt, instance, ok ? 'ok' : 'failed');
    });
  }

  private finish(attempt: Attempt, instance: Instance, state: FinalState): void {
    this.metrics.response(this.sim.now, attempt, state);
    attempt.respond(state);
    instance.freeWorker();
  }
}
