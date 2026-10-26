import { formatMs, percent } from '../analysis/helpers';
import { callsOf, type CallPolicy, type RunConfig, type TierConfig } from '../engine/config';

/** One setting a fix changed, worded short enough to label the diagram with. */
export interface ConfigChange {
  /** tier whose own settings changed */
  tier?: string;
  /** call whose policy changed: from 'client' or a tier id, to a tier id */
  call?: { from: string; to: string };
  text: string;
}

/**
 * What changed between two configs of the same system, e.g. a config and the same config with a
 * fix applied: each tier's own settings (queue limit, skipping abandoned work, sharing cache
 * refills, instances, workers, cores, a message queue's consumers), then each call's policy (the client's call, each tier's
 * cache-aside call and every one of its downstream calls: retries, retry budget, timeout, retry
 * delays). Texts are short and plain, e.g. "6 instances (was 4)", "max 1 retry (was 3)".
 *
 * Tiers are matched by id and calls by who makes them and what they call; a tier or call present
 * in only one of the two configs is not compared (fixes never add or remove one).
 */
export function configChanges(before: RunConfig, after: RunConfig): ConfigChange[] {
  const changes: ConfigChange[] = [];
  for (const b of before.tiers) {
    const a = after.tiers.find((t) => t.id === b.id);
    if (a) for (const text of tierChanges(b, a)) changes.push({ tier: b.id, text });
  }
  for (const [from, b, a] of callPairs(before, after)) {
    for (const text of callChanges(b, a)) changes.push({ call: { from, to: a.target }, text });
  }
  return changes;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function tierChanges(b: TierConfig, a: TierConfig): string[] {
  const texts: string[] = [];
  if (a.queueLimit !== b.queueLimit) {
    const was = b.queueLimit === null ? '' : ` (was ${b.queueLimit})`;
    texts.push(a.queueLimit === null ? `no queue limit${was}` : `queue limit ${a.queueLimit}${was}`);
  }
  if (a.dropExpired !== b.dropExpired) texts.push(a.dropExpired ? 'skips abandoned work' : 'no longer skips abandoned work');
  if (Boolean(a.coalesceMisses) !== Boolean(b.coalesceMisses)) texts.push(a.coalesceMisses ? 'shares cache refills' : 'no longer shares cache refills');
  if (a.instances !== b.instances) texts.push(`${plural(a.instances, 'instance', 'instances')} (was ${b.instances})`);
  if (a.workersPerInstance !== b.workersPerInstance) texts.push(`${plural(a.workersPerInstance, 'worker', 'workers')} each (was ${b.workersPerInstance})`);
  if (a.coresPerInstance !== b.coresPerInstance) texts.push(`${plural(a.coresPerInstance, 'core', 'cores')} each (was ${b.coresPerInstance})`);
  if (a.queue && b.queue && a.queue.consumers !== b.queue.consumers) texts.push(`${plural(a.queue.consumers, 'consumer', 'consumers')} (was ${b.queue.consumers})`);
  return texts;
}

/** Calls present in both configs, by who makes them and what they call: [caller, before, after]. */
function callPairs(before: RunConfig, after: RunConfig): Array<[string, CallPolicy, CallPolicy]> {
  const pairs: Array<[string, CallPolicy, CallPolicy]> = [['client', before.client.call, after.client.call]];
  for (const b of before.tiers) {
    const a = after.tiers.find((t) => t.id === b.id);
    if (!a) continue;
    if (b.cacheAside && a.cacheAside) pairs.push([b.id, b.cacheAside, a.cacheAside]);
    for (const pb of callsOf(b)) {
      const pa = callsOf(a).find((c) => c.target === pb.target);
      if (pa) pairs.push([b.id, pb, pa]);
    }
  }
  return pairs;
}

function callChanges(b: CallPolicy, a: CallPolicy): string[] {
  const texts: string[] = [];
  if (a.retries !== b.retries) texts.push(`${a.retries === 0 ? 'no retries' : `max ${plural(a.retries, 'retry', 'retries')}`} (was ${b.retries})`);
  if (a.retryBudget !== b.retryBudget) {
    const was = b.retryBudget === undefined ? '' : ` (was ${percent(b.retryBudget)})`;
    texts.push(a.retryBudget === undefined ? `no retry budget${was}` : `retry budget ${percent(a.retryBudget)}${was}`);
  }
  if (a.timeoutMs !== b.timeoutMs) {
    const was = ` (was ${b.timeoutMs === null ? 'none' : formatMs(b.timeoutMs)})`;
    texts.push(a.timeoutMs === null ? `no timeout${was}` : `timeout ${formatMs(a.timeoutMs)}${was}`);
  }
  const baseChanged = a.backoffBaseMs !== b.backoffBaseMs;
  if (a.jitter !== b.jitter) {
    // Full jitter: the first retry waits a random time up to the base delay.
    const first = baseChanged ? ` (first up to ${formatMs(a.backoffBaseMs)})` : '';
    texts.push(a.jitter ? `random retry delays${first}` : 'fixed retry delays');
  } else if (baseChanged) {
    texts.push(`retry delay ${formatMs(a.backoffBaseMs)} (was ${formatMs(b.backoffBaseMs)})`);
  }
  return texts;
}
