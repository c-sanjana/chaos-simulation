import type { Signals } from '../analysis/signals';

/**
 * Candidate fixes, as data. Each is one change (one setting, or for 'retryOneLayer' the retries of
 * every call but one), interpreted by `applyFix` (candidates.ts), which works out where in a given
 * config the change goes and with what value.
 */
export type FixKind =
  | 'retryBudget'
  | 'capRetries'
  | 'jitterBackoff'
  | 'retryOneLayer'
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
  /**
   * How the change breaks the retry-storm loop (the mechanism, not the benefit), in one or two
   * plain sentences; for fixes that usually don't break it, what they change and why that may not
   * be enough. May use {caller} and {target} ({Caller}/{Target} at the start of a sentence): the
   * caller and the called tier the change is about, filled in by candidateFixes with this config's
   * names ("the API", "the database").
   */
  how: string;
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
    how: 'Once repeats reach 10% of first tries, {caller} stops asking {target} again. A slowdown then adds only a little extra work, so the pile drains.',
    pros: [
      'Stops retries from multiplying load while a dependency is struggling',
      'Retries still happen as normal while things are healthy',
      'Cheap: a client setting, no new servers',
    ],
    cons: [
      'Once the budget is spent, callers see errors sooner during a real outage',
      'The calling code must count its retries (many libraries can)',
    ],
    signal: 'retryShare',
  },
  {
    id: 'cap-retries',
    kind: 'capRetries',
    title: 'Cap retries at 1',
    short: 'Cap retries',
    how: "Each request tries {target} at most twice, so repeats add less work. Sometimes that's enough for the pile to drain; near the limit it isn't.",
    pros: [
      'The simplest change: one number',
      'Repeats can at most double the calls to the struggling service',
    ],
    cons: [
      'A genuinely brief error reaches the user more often',
      'Still doubles the calls at exactly the wrong moment',
      'Load can still climb further if the cache empties meanwhile',
    ],
    signal: 'retryShare',
  },
  {
    id: 'jitter-backoff',
    kind: 'jitterBackoff',
    title: 'Exponential backoff with full jitter',
    short: 'Jitter',
    how: '{Caller} waits a random, growing pause before asking again, so repeats arrive spread out. But every repeat is still sent, so the pile usually keeps growing.',
    pros: [
      'Spreads retries out so they stop arriving in synchronised waves',
      'Cheap: a client library setting',
    ],
    cons: [
      'Sends just as many retries, so total load is the same',
      'Helps only when repeats arrive in bursts, not when they pile up steadily',
    ],
    signal: 'retryShare',
  },
  {
    id: 'retry-one-layer',
    kind: 'retryOneLayer',
    title: 'Retry at one layer only',
    short: 'One layer',
    how: '{Caller} is the only one that asks {target} again; every other layer passes errors straight back. Repeats no longer multiply from layer to layer, so a slowdown adds a little extra work instead of many times more.',
    pros: [
      'Repeats no longer multiply from layer to layer',
      'One layer still retries, so brief errors stay hidden from users',
      'Cheap: a setting on each caller, no new servers',
    ],
    cons: [
      "Users see an error sooner when one layer's retries aren't enough",
      'Every team must agree which layer retries',
      'Does not help when the extra load comes from elsewhere, such as an emptied cache',
    ],
    signal: 'retryShare',
  },
  {
    id: 'bound-queue',
    kind: 'boundQueue',
    title: 'Bound the queue (load shedding)',
    short: 'Bound queue',
    how: '{Target} turns requests away when its short queue is full instead of letting them wait, so it rarely works on requests nobody is waiting for, and no pile builds up.',
    pros: [
      'At normal speed, anything it accepts is served before the caller gives up',
      'The backlog can no longer grow without limit',
      'Cheap: a server setting, no new servers',
    ],
    cons: [
      'Requests over the limit are turned away immediately, so callers must handle the errors',
      'During a slowdown some accepted requests still take longer than the caller waits',
      'Set too low, it also turns away normal bursts, so the limit needs tuning',
    ],
    signal: 'queueWaitOverTimeout',
  },
  {
    id: 'drop-expired',
    kind: 'dropExpired',
    title: 'Drop requests whose caller gave up',
    short: 'Drop expired',
    how: '{Target} skips requests {caller} has already given up on, so its time goes to requests someone still wants and it catches up instead of being buried.',
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
    how: 'When requests miss the cache for the same entry at once, one goes to {target} and the rest share its answer. Repeats still happen, so the loop usually goes on.',
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
    how: '{Caller} waits three times longer before giving up and asking again, so a shorter slowdown causes few repeats. A longer one starts the same pile-up.',
    pros: [
      'Fewer requests are given up on during a short slowdown',
      'One setting to change',
    ],
    cons: [
      'Only helps if the slowdown is shorter than the new wait',
      'The caller may now wait longer than its own caller waits for it, so users still get errors while it keeps working for nobody',
      'Each request holds its worker up to three times longer',
    ],
    signal: null,
  },
  {
    id: 'add-instances',
    kind: 'addInstances',
    title: 'Add instances (+50%)',
    short: 'Scale out',
    how: '{Caller} gets more servers, but {target} can handle no more than before, so the repeats still pile up there and the loop usually goes on.',
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
