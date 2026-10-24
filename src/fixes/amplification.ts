import { pathsTo, spokenName } from '../analysis/helpers';
import type { CallPolicy, RunConfig } from '../engine/config';

/**
 * Retries multiply from layer to layer: if users' apps try 6 times, the Gateway 4 times for each
 * of those and the App server 2 times for each of those, one request can become 6 × 4 × 2 = 48
 * calls to the database while it fails. Service owners tuning one layer see only their own factor;
 * this shows the whole product, before and after a retry fix.
 */
export interface Amplification {
  /** The largest product over the paths into the tier. */
  factor: number;
  /** The calls along that path, front to back, each with its factor. */
  layers: Array<{ owner: string; factor: number }>;
}

/**
 * How many times one call can be sent while every try fails: 1 + its retries, or 1 + its retry
 * budget when that is smaller. A budget caps repeats at a share of first tries across all
 * requests, so with a budget the factor is an average over requests, not a per-request worst case.
 */
export function callFactor(policy: CallPolicy): number {
  return 1 + Math.min(policy.retries, policy.retryBudget ?? Infinity);
}

/**
 * The most that retries can multiply the calls reaching `tierId` while every call fails: the
 * largest product of call factors along any path from users to it. Null when nothing reaches it.
 * ASSUMPTION: every call on the path fails, the worst case a retry storm approaches; timeouts and
 * cache hits are ignored.
 */
export function retryAmplification(config: RunConfig, tierId: string): Amplification | null {
  let best: Amplification | null = null;
  for (const path of pathsTo(config, tierId)) {
    const layers = path.map((e) => ({ owner: e.from, factor: callFactor(e.policy) }));
    const factor = layers.reduce((p, l) => p * l.factor, 1);
    if (best === null || factor > best.factor) best = { factor, layers };
  }
  return best;
}

/** 6 → "6", 1.1 → "1.1", 1.331 → "1.3", 26.4 → "26". */
export function formatFactor(x: number): string {
  if (Number.isInteger(x)) return String(x);
  return x >= 10 ? String(Math.round(x)) : x.toFixed(1);
}

/**
 * The fix panel's "Across the stack" sentence, e.g. "Only one layer changes. If every call fails,
 * retries can multiply the calls reaching the database up to 48× (users' apps 6 × the gateway 4 ×
 * the app server 2). With this fix: up to 26× (6 × 4 × 1.1)." Null when nothing reaches the tier
 * or nothing on the way retries, before or after.
 */
export function acrossTheStack(before: RunConfig, after: RunConfig, tierId: string, scope: 'layer' | 'stack', labels: Record<string, string>): string | null {
  const [b, a] = [retryAmplification(before, tierId), retryAmplification(after, tierId)];
  if (b === null || a === null || (b.factor === 1 && a.factor === 1)) return null;
  const say = (id: string) => (id === 'client' ? "users' apps" : spokenName(id, labels));
  const shown = (x: Amplification) => x.layers.filter((l) => l.factor > 1);
  const intro = scope === 'layer' ? 'Only one layer changes.' : 'Every layer that retries changes together.';
  const whole = `If every call fails, retries can multiply the calls reaching ${spokenName(tierId, labels)} up to ${formatFactor(b.factor)}× (${shown(b).map((l) => `${say(l.owner)} ${formatFactor(l.factor)}`).join(' × ')}).`;
  const fixed =
    a.factor === b.factor
      ? `This fix leaves that at ${formatFactor(a.factor)}×.`
      : `With this fix: up to ${formatFactor(a.factor)}×${shown(a).length > 1 ? ` (${shown(a).map((l) => formatFactor(l.factor)).join(' × ')})` : ''}.`;
  return `${intro} ${whole} ${fixed}`;
}
