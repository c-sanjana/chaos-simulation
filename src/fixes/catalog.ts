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
  /** Tab label, e.g. "Bound queue". */
  short: string;
  /** Benefits, in plain words; cost is called out where it matters. */
  pros: string[];
  /** Drawbacks and caveats; the first is the most important. */
  cons: string[];
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
    short: 'Retry budget',
    pros: [
      'Stops retries from multiplying load while a dependency is struggling',
      'Retries still happen as normal while things are healthy',
      'Cheap: a client setting, no new servers',
    ],
    cons: [
      'Once the budget is spent, callers see errors sooner during a real outage',
      'Needs retry accounting in the client library (gRPC retry throttling, for example)',
    ],
    signal: 'retryShare',
  },
  {
    id: 'cap-retries',
    kind: 'capRetries',
    title: 'Cap retries at 1',
    short: 'Cap retries',
    pros: [
      'The simplest change: one number',
      'Limits the worst case to twice the normal load',
    ],
    cons: [
      'A genuinely brief error reaches the user more often',
      'Still doubles load at exactly the wrong moment',
    ],
    signal: 'retryShare',
  },
  {
    id: 'jitter-backoff',
    kind: 'jitterBackoff',
    title: 'Exponential backoff with full jitter',
    short: 'Jitter',
    pros: [
      'Spreads retries out so they stop arriving in synchronised waves',
      'Cheap: a client library setting',
    ],
    cons: [
      'Sends just as many retries, so total load is the same',
      'Full jitter also halves the average wait before a retry',
    ],
    signal: 'retryShare',
  },
  {
    id: 'bound-queue',
    kind: 'boundQueue',
    title: 'Bound the queue (load shedding)',
    short: 'Bound queue',
    pros: [
      'Anything accepted is served before its caller gives up',
      'The backlog can no longer grow without limit',
      'Cheap: a server setting, no new servers',
    ],
    cons: [
      'Requests over the limit are turned away immediately, so callers must handle the errors',
      'Set too low, it also turns away normal bursts, so the limit needs tuning',
    ],
    signal: 'queueWaitOverTimeout',
  },
  {
    id: 'drop-expired',
    kind: 'dropExpired',
    title: 'Drop requests whose caller gave up',
    short: 'Drop expired',
    pros: [
      'Stops spending capacity on answers nobody will read',
      'Never drops a request whose caller is still waiting',
    ],
    cons: [
      "Each request must carry its caller's deadline (a deadline header, for example)",
      'Work already under way when the deadline passes is still wasted',
    ],
    signal: 'wastedShare',
  },
  {
    id: 'coalesce-misses',
    kind: 'coalesceMisses',
    title: 'Coalesce concurrent cache misses',
    short: 'Coalesce',
    pros: [
      'One database read per key instead of one per request during a stampede',
      'Invisible to callers',
    ],
    cons: [
      'Only merges reads of the same key that overlap in time',
      'If that one read fails, every waiting request fails with it',
    ],
    signal: 'cacheHitDrop',
  },
  {
    id: 'longer-timeout',
    kind: 'longerTimeout',
    title: 'Longer timeout (×3)',
    short: 'Timeout',
    pros: [
      'Fewer requests time out during a short slowdown',
      'One setting to change',
    ],
    cons: [
      'Each request holds its worker up to three times longer',
      'An upstream timeout may now fire first, and users wait longer for an error',
    ],
    signal: null,
  },
  {
    id: 'add-instances',
    kind: 'addInstances',
    title: 'Add instances (+50%)',
    short: 'Scale out',
    pros: [
      'More headroom for normal peaks too',
      'No code change',
    ],
    cons: [
      'Costs more: 50% more servers for this tier, running all the time',
      'Extra capacity in front of a bottleneck can send it even more load',
    ],
    signal: null,
  },
];
