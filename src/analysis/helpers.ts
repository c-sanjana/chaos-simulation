import type { RunConfig, TierConfig } from '../engine/config';
import { serviceTimeMoments } from '../engine/distributions';

/** Who calls `tierId` and with what timeout: the client, or the tier whose downstream/cacheAside targets it. */
export function callerOf(config: RunConfig, tierId: string): { id: string; timeoutMs: number | null } | null {
  if (config.client.call.target === tierId) return { id: 'client', timeoutMs: config.client.call.timeoutMs };
  for (const t of config.tiers) {
    for (const policy of [t.downstream, t.cacheAside]) {
      if (policy?.target === tierId) return { id: t.id, timeoutMs: policy.timeoutMs };
    }
  }
  return null;
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
