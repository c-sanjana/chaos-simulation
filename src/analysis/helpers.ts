import type { CallPolicy, RunConfig, TierConfig } from '../engine/config';
import type { TierSeries } from '../engine/result';
import { serviceTimeMoments } from '../engine/distributions';

/** The call into `tierId`: who makes it ('client' or a tier id) and its policy, or null if nothing calls it. */
export function callPolicyInto(config: RunConfig, tierId: string): { id: string; policy: CallPolicy } | null {
  if (config.client.call.target === tierId) return { id: 'client', policy: config.client.call };
  for (const t of config.tiers) {
    for (const policy of [t.downstream, t.cacheAside]) {
      if (policy?.target === tierId) return { id: t.id, policy };
    }
  }
  return null;
}

/** Who calls `tierId` and with what timeout: the client, or the tier whose downstream/cacheAside targets it. */
export function callerOf(config: RunConfig, tierId: string): { id: string; timeoutMs: number | null } | null {
  const call = callPolicyInto(config, tierId);
  return call && { id: call.id, timeoutMs: call.policy.timeoutMs };
}

/**
 * Requests per second a leaf tier (no downstream) can complete when busy: instances × the usable
 * concurrency (cores or workers, whichever is fewer) ÷ mean compute time. Null for tiers that call
 * others, whose throughput also depends on downstream latency.
 */
export function leafCapacityRps(tier: TierConfig): number | null {
  if (tier.downstream || tier.cacheAside) return null;
  const concurrency = Math.min(tier.coresPerInstance, tier.workersPerInstance);
  return (tier.instances * concurrency * 1000) / serviceTimeMoments(tier.service).mean;
}

/**
 * Attempts a tier took on in bucket s: arrivals minus those turned away at once because its queue
 * was full. Load against capacity uses this: a request refused on arrival costs (almost) no work,
 * and counting it made a bounded queue look like it multiplied the load 5× (review 2).
 */
export function admittedIn(t: TierSeries, s: number): number {
  return t.arrivalsFirst[s] + t.arrivalsRetry[s] - t.rejected[s];
}

export function sumRange(xs: number[], from: number, to: number): number {
  let s = 0;
  for (let i = Math.max(0, from); i < Math.min(xs.length, to); i++) s += xs[i];
  return s;
}

export function formatMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1).replace(/\.0$/, '')} s`;
  return `${Math.round(ms)} ms`;
}

export function formatSeconds(ms: number): string {
  return `${Math.round(ms / 1000)} s`;
}

export const percent = (x: number) => `${Math.round(x * 100)}%`;

/** Display name for a tier id ("client" → "Client", otherwise the label or the id). */
export function nameOf(id: string, labels: Record<string, string>): string {
  return labels[id] ?? (id === 'client' ? 'Client' : id);
}

/**
 * How a newcomer would say a tier's name: "the database" for DB, acronyms as they are ("the
 * API"), anything else in lower case ("the cache", "the gateway").
 */
export function spokenName(id: string, labels: Record<string, string>): string {
  const label = nameOf(id, labels);
  if (id === 'client') return 'the client';
  if (label === 'DB') return 'the database';
  return /^[A-Z0-9]{2,4}$/.test(label) ? `the ${label}` : `the ${label.toLowerCase()}`;
}
