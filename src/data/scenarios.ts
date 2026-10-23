import type { ScenarioPreset } from './types';

const TRAFFIC = { param: 'rps' as const, label: 'traffic (requests/s)', values: [60, 80, 100, 120, 140, 160, 180, 200, 220, 240] };

/**
 * A short DB slowdown; the API's retries to the DB pile up and can keep the system down afterwards.
 * The map varies retries on the API → DB call only (other calls don't retry), so each extra retry
 * moves the tipping point visibly: with retries at every layer they multiply, (r+1)³, and every
 * retry count above zero tips at the same traffic (PLAN.md Q4).
 */
export const retryStorm: ScenarioPreset = {
  id: 'retry-storm',
  title: 'Retry storm',
  blurb: 'A short DB slowdown; the API keeps retrying, and the retries pile up.',
  topology: 'web-chain',
  rps: 200,
  durationMs: 120_000,
  retryCall: 'api',
  retries: 3,
  faults: [{ tier: 'db', kind: 'slow', factor: 8, startMs: 30_000, endMs: 35_000 }],
  map: { x: TRAFFIC, y: { param: 'retries', label: 'API → DB retries', values: [5, 4, 3, 2, 1, 0] } },
};

export const scenarios: Record<string, ScenarioPreset> = { [retryStorm.id]: retryStorm };
