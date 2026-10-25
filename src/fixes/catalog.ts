import type { SignalName } from '../analysis/signals';

/**
 * Candidate fixes, as data. Each is one change (one setting; for 'retryOneLayer' the retries of
 * every call but one; for 'retryBudgetEveryLayer' a budget on every call that retries),
 * interpreted by `applyFix` (candidates.ts), which works out where in a given config the change
 * goes and with what value.
 */
export type FixKind =
  | 'retryBudget'
  | 'retryBudgetEveryLayer'
  | 'capRetries'
  | 'jitterBackoff'
  | 'retryOneLayer'
  | 'boundQueue'
  | 'dropExpired'
  | 'coalesceMisses'
  | 'moreConsumers'
  | 'longerTimeout'
  | 'addInstances';

/**
 * Something a run can show that makes a pro or con untrue for that run (see fixes/explain.ts,
 * which measures it):
 * - 'loadOverDouble': the struggling part got more than twice its normal load with the fix;
 * - 'noFailures': no request failed with the fix;
 * - 'failedMore': more requests failed with the fix than without.
 */
export type Refutation = 'loadOverDouble' | 'noFailures' | 'failedMore';

export interface FixDefinition {
  id: string;
  kind: FixKind;
  title: string;
  /** Tab label, e.g. "Bound the queue": a full name (the tab wraps rather than cutting it off). */
  short: string;
  /**
   * How the change works: the mechanism only, never the outcome, in one or two plain sentences
   * (whether it worked in this run is said separately, from what was measured: see
   * fixes/explain.ts). May use {caller} and {target} ({Caller}/{Target} at the start of a
   * sentence): the caller and the called tier the change is about, filled in by candidateFixes
   * with this config's names ("the API", "the database").
   */
  how: string;
  /** Benefits, in plain words; cost is called out where it matters. */
  pros: string[];
  /** Drawbacks and caveats; the first is the most important. */
  cons: string[];
  /**
   * Pros and cons (by their exact text) that a run can contradict, and what would contradict them.
   * They are shown only once the run with the fix has been measured, and only if it didn't.
   */
  refutable?: Record<string, Refutation>;
  /** which signal makes it relevant; null = a common instinct that is always tried */
  signal: SignalName | null;
  /**
   * Retry fixes only: whether the change is made by one caller ('layer': what one service team
   * can ship on its own) or agreed across every layer that retries ('stack'). Retries multiply
   * from layer to layer, so the panel shows the end-to-end multiplication before and after.
   */
  scope?: 'layer' | 'stack';
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
  consumerFactor: 2,
} as const;

const AT_MOST_DOUBLE = 'Retries from this layer can at most double its calls to the struggling service';
const ONE_LAYER_HIDES = 'One layer still retries, so brief errors stay hidden from users';
const USERS_STILL_ERRORS = 'The caller may now wait longer than its own caller waits for it, so users still get errors while it keeps working for nobody';

/** In display and tie-break order. */
export const FIX_CATALOG: FixDefinition[] = [
  {
    id: 'retry-budget',
    kind: 'retryBudget',
    title: 'Retry budget of 10%',
    short: 'Budget, one layer',
    how: 'Once retries reach 10% of first tries, {caller} stops retrying {target}, so its retries add at most a tenth more work.',
    pros: [
      "Stops this caller's retries from multiplying load while a dependency is struggling",
      'Retries still happen as normal while things are healthy',
      'Cheap: a client setting, no new servers',
    ],
    cons: [
      'Once the budget is spent, callers see errors sooner during a real outage',
      'The calling code must count its retries (many libraries can)',
      'Other layers that retry are not limited by it',
    ],
    signal: 'retryShare',
    scope: 'layer',
  },
  {
    id: 'retry-budget-every-layer',
    kind: 'retryBudgetEveryLayer',
    title: 'Retry budget of 10% at every layer',
    short: 'Budget, all layers',
    how: 'Every layer that retries stops once its retries reach 10% of its first tries. Each layer then adds at most a tenth more calls, so even multiplied across the stack the retries stay small.',
    pros: [
      'Retries cannot multiply from layer to layer into a storm',
      'Retries still happen as normal while things are healthy',
      'Cheap: a client setting on each caller, no new servers',
    ],
    cons: [
      'Every team that owns a caller must adopt it: it is a decision for the whole system, not one service',
      'Once the budgets are spent, users see errors sooner during a real outage',
      'Each calling library must count its retries (many can)',
    ],
    signal: 'retryShare',
    scope: 'stack',
  },
  {
    id: 'cap-retries',
    kind: 'capRetries',
    title: 'Cap retries at 1',
    short: 'Cap retries at 1',
    how: 'Each request asks {target} at most twice: one try and one more, so this layer adds at most one extra call per request.',
    pros: ['The simplest change: one number', AT_MOST_DOUBLE],
    cons: [
      'A genuinely brief error reaches the user more often',
      'Still doubles the calls at exactly the wrong moment',
      'Load can still climb further if the cache empties meanwhile',
    ],
    refutable: { [AT_MOST_DOUBLE]: 'loadOverDouble' },
    signal: 'retryShare',
    scope: 'layer',
  },
  {
    id: 'jitter-backoff',
    kind: 'jitterBackoff',
    title: 'Exponential backoff with full jitter',
    short: 'Backoff + jitter',
    how: '{Caller} waits a random, growing pause before retrying, so its retries arrive spread out instead of together. Every retry is still sent.',
    pros: [
      'Spreads retries out so they stop arriving in synchronised waves',
      'Cheap: a client library setting',
    ],
    cons: [
      'Every retry is still sent; only their timing changes',
      'Helps only when retries arrive in bursts, not when they pile up steadily',
    ],
    signal: 'retryShare',
    scope: 'layer',
  },
  {
    id: 'retry-one-layer',
    kind: 'retryOneLayer',
    title: 'Retry at one layer only',
    short: 'Retry at one layer',
    how: '{Caller} is the only one that retries {target}; every other layer passes errors straight back, so retries no longer multiply from layer to layer.',
    pros: [
      'Retries no longer multiply from layer to layer',
      ONE_LAYER_HIDES,
      'Cheap: a setting on each caller, no new servers',
    ],
    cons: [
      "Users see an error sooner when one layer's retries aren't enough",
      'Every team must agree which layer retries',
      'Does not help when the extra load comes from elsewhere, such as an emptied cache',
    ],
    refutable: { [ONE_LAYER_HIDES]: 'failedMore' },
    signal: 'retryShare',
    scope: 'stack',
  },
  {
    id: 'bound-queue',
    kind: 'boundQueue',
    title: 'Bound the queue (load shedding)',
    short: 'Bound the queue',
    how: '{Target} turns requests away when its short queue is full instead of letting them wait, so it spends its time on requests it can answer before the caller gives up.',
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
    short: 'Drop expired work',
    how: '{Target} skips requests {caller} has already given up on, so its time goes to requests someone is still waiting for.',
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
    short: 'Merge cache misses',
    how: 'When requests miss the cache for the same entry at once, one goes to {target} and the rest share its answer.',
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
    id: 'more-consumers',
    kind: 'moreConsumers',
    title: 'Twice as many consumers',
    short: 'More consumers',
    how: '{Caller} hands out twice as many messages at once, so up to twice as much work reaches {target} at the same time.',
    pros: [
      'Drains a backlog faster when the consumers were the limit',
      'Senders notice nothing: they are still answered as soon as a message is stored',
    ],
    cons: [
      'No help, and possibly harm, when the part behind the queue is what is slow: it gets more work at once',
      'Costs more: twice the consumers, running all the time',
    ],
    signal: 'queueBacklog',
  },
  {
    id: 'longer-timeout',
    kind: 'longerTimeout',
    title: 'Longer timeout (×3)',
    short: 'Longer timeout ×3',
    how: '{Caller} waits three times longer before giving up and retrying, so an answer slower than before but within the new wait causes no retry.',
    pros: [
      'Fewer requests are given up on during a short slowdown',
      'One setting to change',
    ],
    cons: [
      'Only helps if the slowdown is shorter than the new wait',
      USERS_STILL_ERRORS,
      'Each request holds its worker up to three times longer',
    ],
    refutable: { [USERS_STILL_ERRORS]: 'noFailures' },
    signal: null,
  },
  {
    id: 'add-instances',
    kind: 'addInstances',
    title: 'Add instances (+50%)',
    short: 'Scale out +50%',
    how: '{Caller} gets more servers; {target} can handle no more than before.',
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
