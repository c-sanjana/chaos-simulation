import { callsOf, type CallPolicy, type RunConfig, type ServiceTime, type TierConfig } from './config';

/** Throws a descriptive error if the config cannot be simulated. */
export function validateConfig(config: RunConfig): void {
  const fail = (msg: string): never => {
    throw new Error(`Invalid config: ${msg}`);
  };
  const positive = (v: number, what: string) => {
    if (!(Number.isFinite(v) && v > 0)) fail(`${what} must be a positive number (got ${v})`);
  };
  const positiveInt = (v: number, what: string) => {
    if (!(Number.isInteger(v) && v > 0)) fail(`${what} must be a positive integer (got ${v})`);
  };

  if (!Number.isInteger(config.seed)) fail(`seed must be an integer (got ${config.seed})`);
  positive(config.durationMs, 'durationMs');
  if (config.bucketMs !== undefined) positive(config.bucketMs, 'bucketMs');
  positive(config.client.rps, 'client.rps');
  if (config.tiers.length === 0) fail('at least one tier is required');

  const byId = new Map<string, TierConfig>();
  for (const tier of config.tiers) {
    if (byId.has(tier.id)) fail(`duplicate tier id "${tier.id}"`);
    byId.set(tier.id, tier);
  }

  const checkCall = (call: CallPolicy, owner: string) => {
    if (!byId.has(call.target)) fail(`${owner} calls unknown tier "${call.target}"`);
    if (call.timeoutMs !== null) positive(call.timeoutMs, `${owner} timeoutMs`);
    if (!(Number.isInteger(call.retries) && call.retries >= 0)) fail(`${owner} retries must be a non-negative integer`);
    if (!(call.backoffBaseMs >= 0)) fail(`${owner} backoffBaseMs must be >= 0`);
    if (call.retryBudget !== undefined) positive(call.retryBudget, `${owner} retryBudget`);
    if (call.share !== undefined) positive(call.share, `${owner} share`);
  };
  const checkService = (s: ServiceTime, owner: string) => {
    if (s.kind === 'exponential') positive(s.meanMs, `${owner} service meanMs`);
    else if (s.kind === 'fixed') positive(s.ms, `${owner} service ms`);
    else {
      positive(s.medianMs, `${owner} service medianMs`);
      if (!(s.p99Ms > s.medianMs)) fail(`${owner} service p99Ms must exceed medianMs`);
    }
  };

  checkCall(config.client.call, 'client');
  if (byId.get(config.client.call.target)?.cache) fail('the client cannot call a cache tier directly');
  for (const tier of config.tiers) {
    positiveInt(tier.instances, `${tier.id} instances`);
    positiveInt(tier.workersPerInstance, `${tier.id} workersPerInstance`);
    positiveInt(tier.coresPerInstance, `${tier.id} coresPerInstance`);
    if (tier.queueLimit !== null && !(Number.isInteger(tier.queueLimit) && tier.queueLimit >= 0)) {
      fail(`${tier.id} queueLimit must be null or a non-negative integer`);
    }
    checkService(tier.service, tier.id);
    const calls = callsOf(tier);
    if (!tier.downstream && (tier.moreDownstream?.length ?? 0) > 0) fail(`${tier.id} has further calls (moreDownstream) but no first call (downstream)`);
    if (tier.fanOut !== undefined && !['sequence', 'parallel', 'split'].includes(tier.fanOut)) fail(`${tier.id} fanOut must be sequence, parallel or split (got ${tier.fanOut})`);
    const targets = new Set<string>();
    for (const call of calls) {
      checkCall(call, tier.id);
      if (targets.has(call.target)) fail(`${tier.id} calls "${call.target}" more than once`);
      targets.add(call.target);
      // (A queue's own message, below, explains its case better.)
      if (byId.get(call.target)!.cache && !tier.cache && !tier.queue) fail(`${tier.id} calls cache tier "${call.target}" as a downstream; use cacheAside`);
    }
    // ASSUMPTION: fanOut 'split' with a single call is simply that call (a chain), not an error:
    // a load balancer whose other arrows were deleted still works.
    if (tier.cache) {
      const c = tier.cache;
      if (calls.length > 0 || tier.cacheAside) fail(`cache tier ${tier.id} cannot call other tiers`);
      positiveInt(c.capacity, `${tier.id} cache capacity`);
      positiveInt(c.keys, `${tier.id} cache keys`);
      if (!(c.skew >= 0)) fail(`${tier.id} cache skew must be >= 0`);
      if (c.ttlMs !== null) positive(c.ttlMs, `${tier.id} cache ttlMs`);
    }
    if (tier.queue) {
      const q = tier.queue;
      if (tier.cache || tier.cacheAside) fail(`queue tier ${tier.id} cannot be a cache or use cacheAside`);
      const target = tier.downstream?.target;
      if (target === undefined) fail(`queue tier ${tier.id} needs a downstream for its consumers to call`);
      else if (byId.get(target)!.cache) fail(`queue tier ${tier.id} cannot hand messages to cache tier "${target}"`);
      if (calls.length > 1) fail(`queue tier ${tier.id} must hand its messages to exactly one tier (it has ${calls.length} calls)`);
      positiveInt(q.maxDepth, `${tier.id} queue maxDepth`);
      positiveInt(q.consumers, `${tier.id} queue consumers`);
    }
    if (tier.cacheAside) {
      checkCall(tier.cacheAside, `${tier.id} cacheAside`);
      if (!byId.get(tier.cacheAside.target)!.cache) fail(`${tier.id} cacheAside target "${tier.cacheAside.target}" is not a cache tier`);
      if (!tier.downstream) fail(`${tier.id} uses cacheAside but has no downstream to read from on a miss`);
    } else if (tier.coalesceMisses) {
      fail(`${tier.id} coalesceMisses needs cacheAside`);
    }
  }

  for (const f of config.faults ?? []) {
    const target = byId.get(f.tier);
    if (!target) fail(`fault targets unknown tier "${f.tier}"`);
    if (!(f.startMs >= 0 && f.endMs > f.startMs)) fail(`fault on ${f.tier} needs 0 <= startMs < endMs`);
    if (f.kind === 'slow') positive(f.factor ?? NaN, `fault on ${f.tier} factor`);
    if (f.instance !== undefined && !(Number.isInteger(f.instance) && f.instance >= 0 && f.instance < target!.instances)) {
      fail(`fault on ${f.tier} targets instance ${f.instance}, which does not exist`);
    }
  }

  // The calls must form a directed acyclic graph (fan-out and fan-in are fine), or a single request
  // would recurse forever. Depth-first search over every call; cache lookups lead to cache tiers,
  // which call nothing, so they cannot close a cycle.
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (id: string): void => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'visiting') fail(`call cycle through tier "${id}"`);
    state.set(id, 'visiting');
    for (const call of callsOf(byId.get(id)!)) visit(call.target);
    state.set(id, 'done');
  };
  for (const tier of config.tiers) visit(tier.id);
}
