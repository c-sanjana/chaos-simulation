import type { CallPolicy, RunConfig, ServiceTime, TierConfig } from './config';

/** Builders for small, readable test configurations. Not used by the app. */

export function call(target: string, overrides: Partial<CallPolicy> = {}): CallPolicy {
  return { target, timeoutMs: null, retries: 0, backoffBaseMs: 0, jitter: false, ...overrides };
}

export function tier(id: string, service: ServiceTime, overrides: Partial<TierConfig> = {}): TierConfig {
  return {
    id,
    instances: 1,
    workersPerInstance: 1,
    coresPerInstance: overrides.workersPerInstance ?? 1,
    queueLimit: null,
    service,
    downstream: null,
    dropExpired: false,
    ...overrides,
  };
}

/** A single-tier system: the classic queueing-theory setup. */
export function singleTier(
  rps: number,
  service: ServiceTime,
  durationMs: number,
  tierOverrides: Partial<TierConfig> = {},
  clientCall: Partial<CallPolicy> = {},
): RunConfig {
  return {
    seed: 7,
    durationMs,
    client: { rps, call: call('svc', clientCall) },
    tiers: [tier('svc', service, tierOverrides)],
  };
}
