/*
 * Field limits shared by the builder's settings panel and the settings drawer, so the same setting
 * accepts the same values in both. ASSUMPTION: generous ranges that keep runs meaningful and the
 * simulator fast; the validators still check combinations (e.g. the slowest 1% vs the typical time).
 */
import { MAX_RETRIES } from '../engine/config';

export const FIELD_LIMITS = {
  maxInstances: 100,
  maxWorkers: 10_000,
  maxCores: 256,
  minServiceMs: 0.01,
  maxServiceMs: 60_000,
  maxP99Ms: 600_000,
  maxQueue: 100_000,
  maxKeys: 10_000_000,
  maxTimeoutMs: 600_000,
  maxRetries: MAX_RETRIES,
  maxBackoffMs: 60_000,
  minTtlS: 0.1,
  maxTtlS: 86_400,
  maxSkew: 3,
} as const;

/** The message under "Slowest 1% take" when it isn't above the typical time. */
export const p99Message = (medianMs: number) => `Must take longer than the typical time (${medianMs} ms)`;
