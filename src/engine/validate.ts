import type { CallPolicy, RunConfig, ServiceTime, TierConfig } from './config';

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
  for (const tier of config.tiers) {
    positiveInt(tier.instances, `${tier.id} instances`);
    positiveInt(tier.workersPerInstance, `${tier.id} workersPerInstance`);
    positiveInt(tier.coresPerInstance, `${tier.id} coresPerInstance`);
    if (tier.queueLimit !== null && !(Number.isInteger(tier.queueLimit) && tier.queueLimit >= 0)) {
      fail(`${tier.id} queueLimit must be null or a non-negative integer`);
    }
    checkService(tier.service, tier.id);
    if (tier.downstream) checkCall(tier.downstream, tier.id);
  }

  // Calls must form a chain without cycles, or a single request would recurse forever.
  for (const start of config.tiers) {
    const seen = new Set<string>();
    let current: TierConfig | undefined = start;
    while (current?.downstream) {
      if (seen.has(current.id)) fail(`call cycle through tier "${current.id}"`);
      seen.add(current.id);
      current = byId.get(current.downstream.target);
    }
  }
}
