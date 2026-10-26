import type { Attempt, FinalState } from './attempt';
import { CacheStore, ZipfKeys } from './cache';
import { callWithRetries, type CallTarget } from './caller';
import { callsOf, shareWeight, type CallPolicy, type Fault, type TierConfig } from './config';
import { sampleServiceTime } from './distributions';
import { Instance } from './instance';
import { RoundRobin, type LoadBalancer } from './loadBalancer';
import { MessageQueue } from './messageQueue';
import type { TierMetrics } from './metrics';
import type { TierSeries } from './result';
import { budgetFor, type RetryBudget } from './retryBudget';
import { hashPath, Stream, uniform } from './rng';
import type { Simulation } from './simulation';

/**
 * A tier (load balancer, app server, cache, database…): a set of identical instances (copies), with
 * attempts spread over them by an instance router (see loadBalancer.ts).
 *
 * Handling an attempt: compute on a core for a sampled service time (with `dropExpired`, an attempt
 * whose caller's deadline passed before it got a core is dropped instead), then
 * - a cache tier answers hit/miss from its store;
 * - a queue tier stores the request as a message and answers ok, or rejected if the queue is full;
 *   its consumers call downstream later, independently of the producer (see MessageQueue);
 * - a tier with `cacheAside` looks the request's key up in its cache tier and, on a miss, calls
 *   downstream and writes the key back if that succeeded (with `coalesceMisses`, concurrent misses
 *   for the same key share one downstream read);
 * - otherwise, a tier with downstream calls makes them as its `fanOut` says (holding the worker
 *   throughout; see `callDownstream`);
 * then it responds.
 *
 * ASSUMPTION: all compute happens before the downstream calls (one compute phase per attempt).
 */
export class Tier implements CallTarget {
  readonly instances: Instance[];
  /** The tiers this tier calls, in the order of `callsOf(config)`; empty for a leaf. */
  private targets: Tier[] = [];
  private cacheTier: Tier | null = null;
  private readonly balancer: LoadBalancer = new RoundRobin();
  /** Present on cache tiers. */
  private readonly store: CacheStore | null = null;
  private readonly keys: ZipfKeys | null = null;
  /** Present on queue tiers, once connected. */
  private queue: MessageQueue | null = null;
  /** Active fault effects, per instance. */
  private readonly slowFactor: number[];
  private readonly dead: boolean[];
  /** The tier's downstream calls, in order (see `callsOf`). */
  private readonly calls: CallPolicy[];
  /**
   * Retry budgets for the calls this tier makes, shared by all its instances (null = no budget):
   * one per downstream call (each call has its own) and one for the cache lookups.
   */
  private readonly callBudgets: Array<RetryBudget | null>;
  private readonly cacheBudget: RetryBudget | null;
  /**
   * With `coalesceMisses`: keys currently being read from downstream → callbacks waiting for that
   * read (the first one is the attempt that issued it).
   * ASSUMPTION: misses are coalesced across all instances of the tier (one shared in-flight map),
   * and a waiter simply inherits the reading attempt's outcome and timing.
   */
  private readonly readsInFlight = new Map<number, Array<(ok: boolean) => void>>();

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
    this.calls = callsOf(config);
    this.callBudgets = this.calls.map(budgetFor);
    this.cacheBudget = budgetFor(config.cacheAside);
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

  /** `targets`: the tier each of `callsOf(config)` calls, in the same order. */
  connect(targets: Tier[], cacheTier: Tier | null): void {
    this.targets = targets;
    this.cacheTier = cacheTier;
    // Validation guarantees a queue tier has exactly one downstream call.
    if (this.config.queue) {
      this.queue = new MessageQueue(this.sim, this.config.queue, this.calls[0], targets[0], this.callBudgets[0], this.metrics);
    }
  }

  accept(attempt: Attempt): void {
    this.metrics.arrival(this.sim.now, attempt.isRetry, attempt.fromRepeat);
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
      // ASSUMPTION: with `dropExpired` the handler is deadline-aware: it checks the caller's deadline
      // when it starts, as real servers typically do (e.g. gRPC deadline propagation). With more
      // workers than cores, "starts" means "gets a CPU core", so an attempt that expired while
      // waiting for a core is dropped here without computing: no work done, nothing wasted.
      // (Queued attempts are also checked when they get a worker; see Instance.freeWorker.)
      if (this.dropExpired && attempt.deadlineMs <= this.sim.now) {
        this.finish(attempt, instance, 'dropped');
        return false; // the core goes straight back to the instance
      }
      const u = uniform(this.sim.seed, Stream.Service, attempt.requestId, attempt.pathHash, this.index);
      // ASSUMPTION: a slowdown applies to computes that start while it is active.
      const ms = sampleServiceTime(this.config.service, u) * this.slowFactor[instance.index];
      attempt.computeMs += ms;
      this.metrics.compute(ms);
      this.sim.schedule(this.sim.now + ms, () => {
        instance.releaseCore();
        this.afterCompute(attempt, instance);
      });
      return true;
    });
  }

  /** Responds for an attempt that never got a worker (rejected, dropped from the queue, or refused by a dead tier). */
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
   * ASSUMPTION: a queue tier's consumers are one pool shared by its instances: they pause only while
   * every instance is dead, and resume when one is back. Messages are stored durably, so nothing
   * stored is lost (and `flushAtEnd` does not empty a queue).
   */
  setFault(fault: Fault, active: boolean): void {
    const targets = fault.instance === undefined ? this.instances.map((_, i) => i) : [fault.instance];
    for (const i of targets) {
      if (fault.kind === 'slow') this.slowFactor[i] = active ? fault.factor ?? 1 : 1;
      else this.dead[i] = active;
    }
    if (!active && fault.flushAtEnd) this.store?.clear();
    this.queue?.setPaused(this.dead.every(Boolean));
  }

  series(): TierSeries {
    const c = this.config;
    const peak = (f: (i: Instance) => number) => Math.max(...this.instances.map(f));
    return this.metrics.toSeries(
      c.id,
      { workers: c.instances * c.workersPerInstance, cores: c.instances * c.coresPerInstance, consumers: c.queue?.consumers ?? 0 },
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
    if (this.queue !== null) {
      // The producer is answered as soon as its message is stored; it never waits for processing.
      this.finish(attempt, instance, this.queue.offer(attempt.requestId, attempt.pathHash, attempt.isRetry || attempt.fromRepeat) ? 'ok' : 'rejected');
    } else if (this.store !== null) {
      attempt.hit = this.store.get(attempt.key, this.sim.now);
      if (attempt.hit) this.metrics.cacheHit(this.sim.now, attempt.isRetry || attempt.fromRepeat);
      this.finish(attempt, instance, 'ok');
    } else if (this.cacheTier !== null) {
      this.lookUpThenCall(attempt, instance, this.cacheTier);
    } else if (this.calls.length > 0) {
      this.callDownstream(attempt, (ok) => this.finish(attempt, instance, ok ? 'ok' : 'failed'));
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
      {
        stats: this.metrics,
        budget: this.cacheBudget,
        prepare: (lookup) => {
          lookup.key = key;
          this.metrics.callSent(cacheTier.config.id, this.sim.now, lookup.isRetry);
        },
        fromRepeat: attempt.isRetry || attempt.fromRepeat,
      },
      (ok, lookup) => {
        if (ok && lookup.hit) this.finish(attempt, instance, 'ok');
        else this.readMissedKey(attempt, key, (readOk) => this.finish(attempt, instance, readOk ? 'ok' : 'failed'));
      },
    );
  }

  /**
   * Reads a missed key from downstream (all of the tier's calls, as `fanOut` says) and, if that
   * succeeds, writes it to the cache. With `coalesceMisses`, a miss for a key already being read
   * joins that read instead: the shared read is the whole fan-out.
   */
  private readMissedKey(attempt: Attempt, key: number, done: (ok: boolean) => void): void {
    const coalesce = this.config.coalesceMisses === true;
    const waiting = coalesce ? this.readsInFlight.get(key) : undefined;
    if (waiting) {
      waiting.push(done);
      return;
    }
    const waiters = [done];
    if (coalesce) this.readsInFlight.set(key, waiters);
    this.callDownstream(attempt, (ok) => {
      this.readsInFlight.delete(key);
      if (ok) this.cacheTier!.writeKey(key);
      for (const w of waiters) w(ok);
    });
  }

  /**
   * Makes the tier's downstream calls for one attempt and calls `done` once with the outcome.
   * With one call, it is simply made. With several, `fanOut` decides:
   * - 'sequence': each call starts once the previous one succeeded; the first failure fails the
   *   attempt and later calls are not made. The next call starts as a new event at the same
   *   instant, never inside the previous call's response: that response runs while its target is
   *   still finishing (it frees its worker only afterwards), and with fan-in the next call can go
   *   to that same target (an app server calls Auth, then the database Auth just used). Made
   *   synchronously, it found the worker still taken: queued, or rejected with no queue, in an
   *   idle system (review 3, F1). Retries and a queue's consumers start as new events too.
   *   A single call answers `done` directly, so chains are unchanged.
   * - 'parallel': all calls start at once; `done` runs once every call has answered (or given up),
   *   ok only if all succeeded. The worker is held until then.
   * - 'split': exactly one call is made, picked at random by the calls' shares (see `splitPick`).
   * Each call follows its own policy (timeout, retries, backoff) with its own retry budget, and
   * counts its timeouts and retries on this tier, as a single call does.
   */
  private callDownstream(attempt: Attempt, done: (ok: boolean) => void): void {
    attempt.state = 'waiting';
    const n = this.calls.length;
    const fanOut = n === 1 ? 'sequence' : this.config.fanOut ?? 'sequence';
    if (fanOut === 'split') {
      this.makeCall(attempt, this.splitPick(attempt), done, true);
    } else if (fanOut === 'parallel') {
      let pending = n;
      let allOk = true;
      for (let i = 0; i < n; i++) {
        this.makeCall(attempt, i, (ok) => {
          allOk &&= ok;
          if (--pending === 0) done(allOk);
        });
      }
    } else {
      const next = (i: number): void =>
        this.makeCall(attempt, i, (ok) => {
          if (!ok || i + 1 === n) done(ok);
          else this.sim.schedule(this.sim.now, () => next(i + 1));
        });
      next(0);
    }
  }

  /**
   * Call number `i` (in `callsOf` order) for an attempt.
   *
   * Its tries are keyed by a path branched per call, so that two calls of one attempt never share
   * random values (e.g. two branches that both reach the same database would otherwise draw the
   * same service time there). Call 0 keeps the attempt's own path, so a tier with a single call
   * draws exactly the values it always has (chain configs give byte-identical results). Calls
   * 1, 2, … branch with hashPath(path, −i): retries use positive attempt numbers and a queue's
   * consumers use 0, so the branches never coincide with either.
   *
   * `elsewhere` (a split): each retry goes to another of the tier's calls (see retryPick).
   */
  private makeCall(attempt: Attempt, i: number, done: (ok: boolean) => void, elsewhere = false): void {
    const path = i === 0 ? attempt.pathHash : hashPath(attempt.pathHash, -i);
    let current = i; // the call this try goes along
    callWithRetries(
      this.sim,
      this.calls[i],
      this.targets[i],
      attempt.requestId,
      path,
      {
        stats: this.metrics,
        budget: this.callBudgets[i],
        ...(elsewhere && this.calls.length > 1
          ? { targetFor: (attemptNo: number) => this.targets[(current = attemptNo === 1 ? i : this.retryPick(current, attempt.requestId, hashPath(path, attemptNo)))] }
          : {}),
        prepare: (sent) => this.metrics.callSent(this.calls[current].target, this.sim.now, sent.isRetry),
        fromRepeat: attempt.isRetry || attempt.fromRepeat,
      },
      done,
    );
  }

  /**
   * With fanOut 'split': where the tier's own retry goes. Like a real load balancer (nginx's
   * proxy_next_upstream, Envoy's retry host predicate), it picks again by the calls' shares among
   * the calls other than the one that just failed (`previous`), keyed by the try's path.
   * ASSUMPTION: every try keeps the first pick's policy (timeout, retries, backoff) and retry
   * budget; only where it goes changes. There are no health checks: a pool that is down still
   * gets its share of first tries.
   */
  private retryPick(previous: number, requestId: number, tryPath: number): number {
    const others = this.calls.map((c, i) => ({ i, share: shareWeight(c.share) })).filter((c) => c.i !== previous);
    const total = others.reduce((a, c) => a + c.share, 0);
    let u = uniform(this.sim.seed, Stream.Split, requestId, tryPath, this.index) * total;
    for (const c of others.slice(0, -1)) {
      u -= c.share;
      if (u < 0) return c.i;
    }
    return others[others.length - 1].i;
  }

  /**
   * With fanOut 'split': which call an attempt makes. Shares (default 1) are normalised, and a
   * uniform keyed by (request, attempt path, tier) picks the call whose cumulative share covers it.
   * ASSUMPTION: the pick is random per attempt (independent thinning, like a load balancer choosing
   * a pool at random by weight), not round-robin across the pools.
   * The tier's own retries go to another pool (see retryPick; review 3: sending them back to the
   * same pool, as before 2026-10-25, failed a request three times over on a pool that was down). A
   * retry by whoever calls this tier is a new attempt with its own path, so it is split afresh
   * and may land on any pool.
   */
  private splitPick(attempt: Attempt): number {
    const shares = this.calls.map((c) => shareWeight(c.share));
    const total = shares.reduce((a, b) => a + b, 0);
    let u = uniform(this.sim.seed, Stream.Split, attempt.requestId, attempt.pathHash, this.index) * total;
    for (let i = 0; i < shares.length - 1; i++) {
      u -= shares[i];
      if (u < 0) return i;
    }
    return shares.length - 1;
  }

  private finish(attempt: Attempt, instance: Instance, state: FinalState): void {
    this.metrics.response(this.sim.now, attempt, state);
    attempt.respond(state);
    instance.freeWorker();
  }
}
