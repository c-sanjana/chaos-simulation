import { Client } from './client';
import type { RunConfig } from './config';
import { Buckets, ClientMetrics, TierMetrics } from './metrics';
import type { RunResult } from './result';
import { Simulation } from './simulation';
import { Tier } from './tier';
import { validateConfig } from './validate';

/** Runs one simulation to completion. Pure: the same config always gives the same result. */
export function runSimulation(config: RunConfig): RunResult {
  validateConfig(config);
  const sim = new Simulation(config.seed);
  const buckets = new Buckets(config.durationMs, config.bucketMs ?? 1000);

  const tiers = new Map<string, Tier>();
  config.tiers.forEach((tc, i) => tiers.set(tc.id, new Tier(sim, tc, i, new TierMetrics(buckets))));
  for (const tier of tiers.values()) {
    const target = tier.config.downstream?.target;
    if (target) tier.connect(tiers.get(target)!);
  }

  const clientMetrics = new ClientMetrics(buckets);
  new Client(sim, config.client, tiers.get(config.client.call.target)!, clientMetrics, config.durationMs).start();
  sim.run(config.durationMs);

  const series: RunResult['tiers'] = {};
  for (const [id, tier] of tiers) series[id] = tier.series();
  return {
    durationMs: config.durationMs,
    bucketMs: buckets.bucketMs,
    tiers: series,
    client: clientMetrics.toSeries(),
    eventsProcessed: sim.eventsProcessed,
  };
}
