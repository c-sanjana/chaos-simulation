import { buildRunConfig, type ScenarioOverrides } from '../data/buildConfig';
import { retryStorm } from '../data/scenarios';
import { webChain } from '../data/topologies';
import type { RunConfig } from '../engine/config';
import { runSimulation } from '../engine/run';
import { analyzeRun } from './analyze';
import { controlConfig } from './recovery';

/** Test helper: run a config and its control, and analyse the pair. Memoised per config. */
const cache = new Map<string, ReturnType<typeof runAndAnalyze>>();

function runAndAnalyze(config: RunConfig) {
  const run = runSimulation(config);
  const control = runSimulation(controlConfig(config));
  const labels = Object.fromEntries(Object.entries(webChain.layout).map(([id, l]) => [id, l.label]));
  return { config, run, control, analysis: analyzeRun(run, control, config, labels) };
}

export function analyzed(config: RunConfig) {
  const key = JSON.stringify(config);
  if (!cache.has(key)) cache.set(key, runAndAnalyze(config));
  return cache.get(key)!;
}

/**
 * The retry-storm failure with a single retrying layer: the API retries the DB `retries` times and
 * no other call retries (the preset before per-layer retries). Mechanism tests use it because one
 * retrying layer gives a clean stuck/recovered contrast (0 retries recovers, 3 gets stuck).
 */
export const retryStormRun = ({ retries = 0, ...overrides }: Omit<ScenarioOverrides, 'retries'> & { retries?: number }) =>
  analyzed(buildRunConfig(webChain, retryStorm, { ...overrides, retries: { client: 0, lb: 0, api: retries } }));
