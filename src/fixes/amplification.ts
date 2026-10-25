import { allCallEdges, heaviestPathTo, spokenName, type CallEdge } from '../analysis/helpers';
import type { CallPolicy, RunConfig } from '../engine/config';

/**
 * Retries multiply from layer to layer: if users' apps try 6 times, the load balancer 4 times for each
 * of those and the App server 2 times for each of those, one request can become 6 × 4 × 2 = 48
 * calls to the database while it fails. Service owners tuning one layer see only their own factor;
 * this shows the whole product, before and after a retry fix.
 */
export interface Amplification {
  /** The largest product over the ways into the tier (from the last queue on the way, if any). */
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
 * largest product of call factors along any way from users to it (found in one pass, without
 * listing the ways: a wide diagram has very many; review 3, F8). Null when nothing reaches it.
 * A message queue answers its senders as soon as it stores a message, so retries in front of it
 * never multiply into what is behind it: the product starts again at the queue, with its
 * consumers' call (review 3: users' apps and the load balancer were multiplied in).
 * With `via`, only ways through that call (null if none counts it).
 * ASSUMPTION: every call on the path fails, the worst case a retry storm approaches; timeouts and
 * cache hits are ignored.
 */
export function retryAmplification(config: RunConfig, tierId: string, via?: CallEdge): Amplification | null {
  const isQueue = (id: string) => config.tiers.some((t) => t.id === id && t.queue !== undefined);
  const way = heaviestPathTo(config, tierId, (e) => callFactor(e.policy), isQueue, via);
  return way && { factor: way.product, layers: way.calls.map((e) => ({ owner: e.from, factor: callFactor(e.policy) })) };
}

/** 6 → "6", 1.1 → "1.1", 1.331 → "1.3", 26.4 → "26". */
export function formatFactor(x: number): string {
  if (Number.isInteger(x)) return String(x);
  return x >= 10 ? String(Math.round(x)) : x.toFixed(1);
}

/** The call the fix changed (the first one whose policy differs), or null. */
function changedCall(before: RunConfig, after: RunConfig): CallEdge | null {
  const now = allCallEdges(after);
  return allCallEdges(before).find((e, i) => JSON.stringify(e.policy) !== JSON.stringify(now[i]?.policy)) ?? null;
}

/**
 * The fix panel's "Across the stack" sentence, e.g. "Only one layer changes. If every call fails,
 * retries can multiply the calls reaching the database up to 48× (users' apps 6 × the load balancer 4 ×
 * the app server 2). With this fix: up to 26× (6 × 4 × 1.1)." Null when nothing reaches the tier
 * or nothing on the way retries, before or after.
 *
 * When the fix moves the worst way to another one, the factors after it are named (review 3, F9:
 * "(6 × 3)" read as the orders service going from 4 to 3, while 3 was the reports service's). When
 * a one-layer fix changes a call off the worst way, a sentence says what it does on the ways
 * through that call (review 3: "This fix leaves that at 30×" hid a 12× → 6.6× change).
 */
export function acrossTheStack(before: RunConfig, after: RunConfig, tierId: string, scope: 'layer' | 'stack', labels: Record<string, string>): string | null {
  const [b, a] = [retryAmplification(before, tierId), retryAmplification(after, tierId)];
  if (b === null || a === null || (b.factor === 1 && a.factor === 1)) return null;
  const say = (id: string) => (id === 'client' ? "users' apps" : spokenName(id, labels));
  // A numbered name followed by its factor reads as one number ("the app server 2 4").
  const named = (l: { owner: string; factor: number }) => (/\d$/.test(say(l.owner)) ? `${say(l.owner)} (${formatFactor(l.factor)})` : `${say(l.owner)} ${formatFactor(l.factor)}`);
  const shown = (x: Amplification) => x.layers.filter((l) => l.factor > 1);
  const intro = scope === 'layer' ? 'Only one layer changes.' : 'Every layer that retries changes together.';
  const whole = `If every call fails, retries can multiply the calls reaching ${spokenName(tierId, labels)} up to ${formatFactor(b.factor)}× (${shown(b).map(named).join(' × ')}).`;
  const samePath = b.layers.map((l) => l.owner).join() === a.layers.map((l) => l.owner).join();
  const factors = shown(a).map((l) => (samePath ? formatFactor(l.factor) : named(l)));
  const fixed =
    a.factor === b.factor
      ? (scope === 'layer' ? changedElsewhere(before, after, tierId, a, say, named, labels) : null) ?? `This fix leaves that at ${formatFactor(a.factor)}×.`
      : `With this fix: up to ${formatFactor(a.factor)}×${factors.length > 1 || !samePath ? ` (${factors.join(' × ')})` : ''}.`;
  return `${intro} ${whole} ${fixed}`;
}

/**
 * When the worst way stays as bad but the fix's call does change the ways through it (it is not on
 * the worst way, or the worst way was a tie): "This fix changes the app server's calls to the
 * database: up to 12× → 6.6× through them. The worst way stays at 12× (users' apps 3 × the load
 * balancer 2 × App server 2 (2))." Null otherwise (review 3: "This fix leaves that at 12×" named
 * the very call the fix had changed).
 */
function changedElsewhere(
  before: RunConfig,
  after: RunConfig,
  tierId: string,
  worst: Amplification,
  say: (id: string) => string,
  named: (l: { owner: string; factor: number }) => string,
  labels: Record<string, string>,
): string | null {
  const changed = changedCall(before, after);
  if (changed === null) return null;
  const [was, now] = [retryAmplification(before, tierId, changed), retryAmplification(after, tierId, changed)];
  if (was === null || now === null || was.factor === now.factor) return null;
  const call = changed.from === 'client' ? `users' apps' calls to ${spokenName(changed.policy.target, labels)}` : `${say(changed.from)}'s calls to ${spokenName(changed.policy.target, labels)}`;
  const shown = worst.layers.filter((l) => l.factor > 1).map(named).join(' × ');
  return `This fix changes ${call}: up to ${formatFactor(was.factor)}× → ${formatFactor(now.factor)}× through them. The worst way stays at ${formatFactor(worst.factor)}× (${shown}).`;
}
