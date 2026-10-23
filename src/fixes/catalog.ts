import type { Signals } from '../analysis/signals';

/**
 * Candidate fixes, as data. Each is one setting change, interpreted by `applyFix` (candidates.ts),
 * which works out where in a given config the change goes and with what value.
 */
export type FixKind =
  | 'retryBudget'
  | 'capRetries'
  | 'jitterBackoff'
  | 'boundQueue'
  | 'dropExpired'
  | 'coalesceMisses'
  | 'longerTimeout'
  | 'addInstances';

export interface FixDefinition {
  id: string;
  kind: FixKind;
  title: string;
  caveat: string;
  /** which signal makes it relevant; null = a common instinct that is always tried */
  signal: keyof Signals | null;
}

/** Settings the fixes apply. */
export const FIX_SETTINGS = {
  /** Retries may be at most 10% of first attempts. */
  retryBudgetRatio: 0.1,
  maxRetries: 1,
  /**
   * Backoff base used when adding jittered backoff to a call that retries immediately.
   * ASSUMPTION: 100 ms, a typical base delay for request retries.
   */
  jitterBaseMs: 100,
  timeoutFactor: 3,
  instanceFactor: 1.5,
} as const;

/** In display and tie-break order. */
export const FIX_CATALOG: FixDefinition[] = [
  {
    id: 'retry-budget',
    kind: 'retryBudget',
    title: 'Retry budget of 10%',
    caveat: 'Once retries reach 10% of first attempts the rest are refused, so callers see errors sooner during a real outage.',
    signal: 'retryShare',
  },
  {
    id: 'cap-retries',
    kind: 'capRetries',
    title: 'Cap retries at 1',
    caveat: 'Fewer retries also means a genuinely transient error reaches the user more often.',
    signal: 'retryShare',
  },
  {
    id: 'jitter-backoff',
    kind: 'jitterBackoff',
    title: 'Exponential backoff with full jitter',
    caveat: 'Spreads retries out in time but sends just as many; full jitter also halves the average wait before a retry.',
    signal: 'retryShare',
  },
  {
    id: 'bound-queue',
    kind: 'boundQueue',
    title: 'Bound the queue (load shedding)',
    caveat: 'Requests beyond the limit are rejected at once instead of waiting, so callers must handle the errors.',
    signal: 'queueWaitOverTimeout',
  },
  {
    id: 'drop-expired',
    kind: 'dropExpired',
    title: 'Drop requests whose caller gave up',
    caveat: "Needs each request to carry its caller's deadline (e.g. a deadline header) for the server to check.",
    signal: 'wastedShare',
  },
  {
    id: 'coalesce-misses',
    kind: 'coalesceMisses',
    title: 'Coalesce concurrent cache misses',
    caveat: 'Only merges reads of the same key that overlap in time, and every waiter shares that read’s failure.',
    signal: 'cacheHitDrop',
  },
  {
    id: 'longer-timeout',
    kind: 'longerTimeout',
    title: 'Longer timeout (×3)',
    caveat: 'Each request holds its worker up to three times longer, and an upstream timeout may now fire first.',
    signal: null,
  },
  {
    id: 'add-instances',
    kind: 'addInstances',
    title: 'Add instances (+50%)',
    caveat: 'Costs more, and extra capacity in front of a bottleneck can send it even more load.',
    signal: null,
  },
];
