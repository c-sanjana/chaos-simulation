import type { ScenarioPreset } from './types';

const TRAFFIC = { param: 'rps' as const, label: 'traffic (requests/s)', values: [60, 80, 100, 120, 140, 160, 180, 200, 220, 240] };

/** A short DB slowdown; retries at every layer pile up and can keep the system down afterwards. */
export const retryStorm: ScenarioPreset = {
  id: 'retry-storm',
  title: 'Retry storm',
  blurb: 'A short DB slowdown; retries pile up at every layer.',
  topology: 'web-chain',
  rps: 200,
  durationMs: 120_000,
  retries: 3,
  faults: [{ tier: 'db', kind: 'slow', factor: 8, startMs: 30_000, endMs: 35_000 }],
  map: { x: TRAFFIC, y: { param: 'retries', label: 'retries per layer', values: [5, 4, 3, 2, 1, 0] } },
};

export const scenarios: Record<string, ScenarioPreset> = { [retryStorm.id]: retryStorm };
