import { allCallEdges, callersOf, capitalise, heaviestCallerInto, formatMs, leafCapacityRps, listed, nameOf, percent, spokenName, strictestCallerInto, tierOf, times, type CallEdge } from '../analysis/helpers';
import type { SignalName, Signals } from '../analysis/signals';
import { callsOf, type CallPolicy, type RunConfig, type TierConfig } from '../engine/config';
import type { RunResult } from '../engine/result';
import { acrossTheStack } from './amplification';
import { FIX_CATALOG, FIX_SETTINGS, type FixDefinition, type Refutation } from './catalog';

export interface FixCandidate {
  id: string;
  /** Full name with where it applies, e.g. "Bound the queue (load shedding): DB, at most 93 queued per instance". */
  title: string;
  /** The catalogue's name, e.g. "Bound the queue (load shedding)". */
  name: string;
  /** Tab label, e.g. "Bound queue". */
  short: string;
  /** What changes, in one plain sentence with this config's numbers. */
  what: string;
  /** How the change breaks the retry-storm loop (or why it may not), with this config's names. */
  how: string;
  why: string;
  pros: string[];
  cons: string[];
  /** Pros and cons a run can contradict (from the catalogue): shown only once measured, and only if not contradicted. */
  refutable?: Record<string, Refutation>;
  /** Retry fixes: made by one caller ('layer') or by every layer that retries ('stack'). */
  scope?: 'layer' | 'stack';
  /** Retry fixes: the end-to-end retry multiplication into the struggling part, before and with the fix (see acrossTheStack). */
  acrossStack?: string;
  config: RunConfig;
}

/** `why` for the fixes tried because people reach for them, not because a signal pointed at them. */
export const COMMON_INSTINCT = "it is a common first instinct, so it's worth checking whether it actually helps";

/**
 * Fixes worth trying for this run: each is the original config with one change (one setting; for
 * "retry at one layer only", the retries of every other call). `why` quotes the triggering signal
 * with its number, e.g. "retries made up 74% of DB's load". Common instincts get why =
 * COMMON_INSTINCT. In catalog order; fixes that cannot be applied to this config (or would change
 * nothing) are left out.
 *
 * `run` (optional): the run the signals came from. With fan-in (several callers into the
 * overloaded part) it picks the caller that sent it the most; without it, the caller with the
 * largest share of user traffic (see analysis/helpers' heaviestCallerInto). Chains have one
 * caller per part, so it changes nothing there.
 */
export function candidateFixes(config: RunConfig, signals: Signals, labels: Record<string, string>, run?: RunResult): FixCandidate[] {
  const name = (id: string) => nameOf(id, labels);
  const candidates: FixCandidate[] = [];
  for (const def of FIX_CATALOG) {
    if (def.signal !== null && signals[def.signal] === null) continue;
    const plan = planFix(def, config, signals, name, run);
    if (plan === null) continue;
    const target = bottleneck(signals);
    const acrossStack = def.scope && target !== null ? acrossTheStack(config, plan.config, target, def.scope, labels) : null;
    candidates.push({
      id: def.id,
      title: `${def.title}: ${plan.where}`,
      name: def.title,
      short: def.short,
      what: plan.what,
      how: fillNames(plan.how ?? def.how, plan.caller, plan.target, labels),
      why: def.signal === null ? COMMON_INSTINCT : describeSignal(def.signal, def.scope === 'layer' ? aimedAt(def.signal, signals, plan.target) : signals, config, name),
      pros: def.pros,
      cons: def.cons,
      ...(def.refutable ? { refutable: def.refutable } : {}),
      ...(def.scope ? { scope: def.scope } : {}),
      ...(acrossStack ? { acrossStack } : {}),
      config: plan.config,
    });
  }
  return candidates;
}

/** The config with `def` applied, or null when it does not apply to this config. Never mutates `config`. */
export function applyFix(def: FixDefinition, config: RunConfig, signals: Signals, run?: RunResult): RunConfig | null {
  return planFix(def, config, signals, (id) => id, run)?.config ?? null;
}

interface FixPlan {
  config: RunConfig;
  /** Where the change goes, for the candidate's title (e.g. "API → DB"). */
  where: string;
  /** What changes, as a sentence (e.g. "API stops retrying DB once retries reach 10% of first attempts."). */
  what: string;
  /** For the catalog's {caller} and {target}: the caller and the called tier the change is about. */
  caller: string;
  target: string;
  /** Replaces the catalog's `how` where it would not be true of this config. */
  how?: string;
}

/** The catalog's `how` with {caller}/{target} ({Caller}/{Target} capitalised) replaced by spoken names. */
export function fillNames(how: string, caller: string, target: string, labels: Record<string, string>): string {
  const names: Record<string, string> = { caller: spokenName(caller, labels), target: spokenName(target, labels) };
  return how.replace(/\{(caller|target|Caller|Target)\}/g, (_, key: string) => {
    const spoken = names[key.toLowerCase()];
    return key === key.toLowerCase() ? spoken : spoken.charAt(0).toUpperCase() + spoken.slice(1);
  });
}

function planFix(def: FixDefinition, config: RunConfig, signals: Signals, name: (id: string) => string, run?: RunResult): FixPlan | null {
  const callName = (ref: CallRef) => `${name(ref.owner)} → ${name(ref.policy.target)}`;
  const [caller, target] = [(ref: CallRef) => name(ref.owner), (ref: CallRef) => name(ref.policy.target)];
  /** A tier's own call (singular: "the API asks"), as opposed to users' apps or cache lookups (plural). */
  const singular = (ref: CallRef) => ref.field === 'downstream' || ref.field === 'more';
  /**
   * Who makes a call: "users' apps" (the client), "the API", "the API's Cache lookups" (plural
   * except a tier's own call), or, for a tier with several calls, "the API's calls to the DB".
   */
  const maker = (ref: CallRef) => {
    if (ref.owner === 'client') return "users' apps";
    if (ref.field === 'cacheAside') return `the ${name(ref.owner)}'s ${name(ref.policy.target)} lookups`;
    return callsMadeBy(config, ref.owner) > 1 ? `the ${name(ref.owner)}'s calls to ${name(ref.policy.target)}` : `the ${name(ref.owner)}`;
  };
  const callInto = (id: string) => heaviestCallInto(config, id, run);
  const retryCallFor = (applies: (ref: CallRef) => boolean) => retryCallTowards(config, signals, applies, run);
  switch (def.kind) {
    // Retry fixes change one call: see retryCallFor for which.
    case 'retryBudget': {
      const ratio = FIX_SETTINGS.retryBudgetRatio;
      const ref = retryCallFor((r) => (r.policy.retryBudget ?? Infinity) > ratio);
      if (ref === null) return null;
      return {
        config: withCall(config, ref, { retryBudget: ratio }),
        ...ends(ref),
        where: callName(ref),
        what: `${caller(ref)} stops retrying ${target(ref)} once retries reach ${percent(ratio)} of first attempts.`,
      };
    }
    case 'retryBudgetEveryLayer': {
      const ratio = FIX_SETTINGS.retryBudgetRatio;
      const retrying = allCalls(config).filter((r) => r.policy.retries > 0);
      const unbudgeted = retrying.filter((r) => (r.policy.retryBudget ?? Infinity) > ratio);
      // With a single retrying call this is the one-layer budget; nothing to budget, nothing to try.
      if (retrying.length < 2 || unbudgeted.length === 0 || bottleneck(signals) === null) return null;
      let fixed = config;
      for (const r of unbudgeted) fixed = withCall(fixed, r, { retryBudget: ratio });
      const makers = unbudgeted.map(maker);
      const plural = unbudgeted.length > 1 || !singular(unbudgeted[0]);
      return {
        config: fixed,
        ...ends(retryCallFor(() => true) ?? retrying[retrying.length - 1]),
        where: 'every layer that retries',
        what: `${capitalise(listed(makers))} ${plural ? 'each stop' : 'stops'} retrying once retries reach ${percent(ratio)} of ${plural ? 'their' : 'its'} first attempts.`,
      };
    }
    case 'capRetries': {
      const n = FIX_SETTINGS.maxRetries;
      const ref = retryCallFor((r) => r.policy.retries > n);
      if (ref === null) return null;
      return {
        config: withCall(config, ref, { retries: n }),
        ...ends(ref),
        where: callName(ref),
        what: `${caller(ref)} retries a failed call to ${target(ref)} at most ${times(n)} (instead of ${times(ref.policy.retries)}).`,
      };
    }
    case 'jitterBackoff': {
      const ref = retryCallFor((r) => !(r.policy.jitter && r.policy.backoffBaseMs > 0));
      if (ref === null) return null;
      // A call that retries immediately has no backoff to jitter, so it gets a base delay too.
      const patch = ref.policy.backoffBaseMs > 0 ? { jitter: true } : { jitter: true, backoffBaseMs: FIX_SETTINGS.jitterBaseMs };
      return {
        config: withCall(config, ref, patch),
        ...ends(ref),
        where: callName(ref),
        what: `${caller(ref)} waits a random, growing delay before each retry to ${target(ref)}, so retries spread out instead of arriving together.`,
      };
    }
    case 'retryOneLayer': {
      const retrying = allCalls(config).filter((r) => r.policy.retries > 0);
      if (retrying.length < 2 || bottleneck(signals) === null) return null;
      // The call into the bottleneck if it retries, else the nearest retrying call in front of it;
      // failing both, the innermost retrying call.
      const keep = retryCallFor(() => true) ?? retrying[retrying.length - 1];
      const others = retrying.filter((r) => !sameCall(r, keep));
      let fixed = config;
      for (const r of others) fixed = withCall(fixed, r, { retries: 0 });
      const makers = others.map(maker);
      const n = keep.policy.retries;
      const plural = others.length > 1 || !singular(others[0]) || callsMadeBy(config, others[0].owner) > 1;
      const only = singular(keep) && callsMadeBy(config, keep.owner) === 1 ? `Only ${maker(keep)} retries` : `Only ${maker(keep)} retry`;
      return {
        config: fixed,
        ...ends(keep),
        // The kept caller's other calls stop retrying too: the catalog's "every other layer" would leave them out.
        how: callsMadeBy(config, keep.owner) > 1 ? '{Caller} retries {target} and nothing else does: its other calls and every other layer pass errors straight back, so retries no longer multiply from layer to layer.' : undefined,
        where: callName(keep),
        what: `${only} the ${target(keep)} (${n === 1 ? 'once' : `up to ${n} times`}); ${listed(makers)} no longer ${plural ? 'retry' : 'retries'}.`,
      };
    }
    case 'boundQueue': {
      // ASSUMPTION: with several callers, sized for the least patient one (the shortest timeout),
      // so that whatever is let in can be served before any caller gives up. That is also the
      // caller the signal quotes.
      const id = signals.queueWaitOverTimeout?.tier;
      const strictest = id === undefined ? null : strictestCallInto(config, id);
      const timeoutMs = strictest?.policy.timeoutMs ?? null;
      if (id === undefined || strictest === null || timeoutMs === null) return null;
      const tier = tierOf(config, id);
      const limit = queueLimitFor(tier, timeoutMs);
      if (tier.queueLimit !== null && tier.queueLimit <= limit) return null;
      return {
        config: withTier(config, id, { queueLimit: limit }),
        ...ends(strictest),
        // A limit of 0 (a caller too impatient for any wait) means no queue at all.
        where: limit === 0 ? `${name(id)}, no queue` : `${name(id)}, at most ${limit} queued per instance`,
        what: limit === 0 ? `${name(id)} turns away every request it can't start at once, instead of letting it wait.` : `${name(id)} lets at most ${limit} requests wait per instance and turns the rest away immediately.`,
      };
    }
    case 'dropExpired': {
      const id = signals.wastedShare?.tier;
      const ref = id === undefined ? null : callInto(id);
      // A tier nothing calls has no caller to give up on it.
      if (id === undefined || ref === null || tierOf(config, id).dropExpired) return null;
      return {
        config: withTier(config, id, { dropExpired: true }),
        ...ends(ref),
        // With several callers it skips work for any of them that gave up, not just one.
        how: callersOf(config, id).length > 1 ? '{Target} skips requests whose caller has already given up on them, so its time goes to requests someone is still waiting for.' : undefined,
        where: name(id),
        what: `${name(id)} skips requests whose caller has already timed out, instead of doing work nobody will use.`,
      };
    }
    case 'coalesceMisses': {
      const cacheId = signals.cacheHitDrop?.tier;
      const users = config.tiers.filter((t) => t.cacheAside !== undefined && t.cacheAside.target === cacheId && !t.coalesceMisses);
      const tier = users[0];
      if (tier === undefined) return null;
      if (users.length > 1) {
        // Every part that looks things up in the cache coalesces (review 3: only the first one did).
        let fixed = config;
        for (const u of users) fixed = withTier(fixed, u.id, { coalesceMisses: true });
        const names = listed(users.map((u) => name(u.id)));
        return {
          config: fixed,
          caller: tier.id,
          target: tier.downstream!.target,
          how: 'When requests miss the cache for the same entry at once, one of them makes the reads behind it and the rest share its answer.',
          where: names,
          what: `When several requests miss the cache for the same key at once, ${names} each make one read and share the result.`,
        };
      }
      return {
        config: withTier(config, tier.id, { coalesceMisses: true }),
        caller: tier.id,
        target: tier.downstream!.target, // validation: cacheAside needs a downstream
        // With several calls behind the cache, a miss reads from all of them (or one, when split).
        how: callsMadeBy(config, tier.id) > 1 ? 'When requests miss the cache for the same entry at once, one of them makes the reads behind it and the rest share its answer.' : undefined,
        where: name(tier.id),
        what: `When several requests miss the cache for the same key at once, ${name(tier.id)} makes one read and shares the result.`,
      };
    }
    case 'moreConsumers': {
      const id = signals.queueBacklog?.tier;
      const tier = id === undefined ? undefined : tierOf(config, id);
      if (!tier?.queue || !tier.downstream) return null;
      const consumers = tier.queue.consumers * FIX_SETTINGS.consumerFactor;
      return {
        config: withTier(config, tier.id, { queue: { ...tier.queue, consumers } }),
        caller: tier.id,
        target: tier.downstream.target,
        where: `${name(tier.id)}, ${tier.queue.consumers} → ${consumers} consumers`,
        what: `${name(tier.id)} hands out ${consumers} messages at once instead of ${tier.queue.consumers}.`,
      };
    }
    case 'longerTimeout': {
      const id = bottleneck(signals);
      const ref = id === null ? null : callInto(id);
      if (ref === null || ref.policy.timeoutMs === null) return null;
      const timeoutMs = ref.policy.timeoutMs * FIX_SETTINGS.timeoutFactor;
      return {
        config: withCall(config, ref, { timeoutMs }),
        ...ends(ref),
        where: `${callName(ref)}, ${formatMs(ref.policy.timeoutMs)} → ${formatMs(timeoutMs)}`,
        what: `${caller(ref)} waits up to ${formatMs(timeoutMs)} for ${target(ref)} before giving up (instead of ${formatMs(ref.policy.timeoutMs)}).`,
      };
    }
    case 'addInstances': {
      // The instinct is to scale the tier calling the bottleneck (its threads are the ones seen
      // exhausted). Scale the bottleneck itself when that caller is the client, a load balancer
      // splitting over pools, or a part that was barely busy (review 3: a load balancer at 7%
      // workers was scaled while the app server pool behind it was the one overloaded).
      const id = bottleneck(signals);
      if (id === null) return null;
      const caller = callInto(id);
      const scaleCaller = caller !== null && caller.owner !== 'client' && tierOf(config, caller.owner).fanOut !== 'split' && !(run && barelyBusy(run, caller.owner));
      const target = scaleCaller ? caller.owner : id;
      const before = tierOf(config, target).instances;
      const instances = Math.ceil(before * FIX_SETTINGS.instanceFactor);
      return {
        config: withTier(config, target, { instances }),
        caller: target,
        target: id,
        // Scaling the overloaded tier itself does add room for the work.
        how: target === id ? '{Target} gets more servers, so it can handle more work at once.' : undefined,
        where: `${name(target)}, ${before} → ${instances} instances`,
        what: `${name(target)} runs ${instances} instances instead of ${before}.`,
      };
    }
  }
}

/**
 * Per-instance queue limit for "bound the queue", chosen so that anything admitted to the queue
 * can still be served before its caller gives up.
 *
 * Leaf tier: a newly queued request waits behind the queue plus every request already holding a
 * worker (computing, or waiting for a core), and that backlog drains at the instance's capacity
 * (usable concurrency ÷ mean service time). It is served in time if
 *   queue + workers ≤ capacity per instance × caller timeout,
 * so limit = floor(capacity × timeout) − workers, and at least 0 (then a request is accepted only
 * when a worker is free).
 *
 * Non-leaf tier: its throughput depends on downstream latency, so there is no fixed capacity to
 * use; the limit is workersPerInstance (at most one queued request per worker).
 */
export function queueLimitFor(tier: TierConfig, callerTimeoutMs: number): number {
  const capacityRps = leafCapacityRps(tier);
  if (capacityRps === null) return tier.workersPerInstance;
  const perInstanceRps = capacityRps / tier.instances;
  return Math.max(0, Math.floor((perInstanceRps * callerTimeoutMs) / 1000) - tier.workersPerInstance);
}

/**
 * The most overloaded tier, where the common instincts are aimed: the part still over what it can
 * handle after the failure ended (the story's and the explanations' part, see analysis/helpers'
 * strugglingPart); failing that, where queued work most outlasted its caller's patience, where
 * the most work was wasted, or where retries piled up. Null when none of these showed up, i.e.
 * nothing was overloaded.
 * (Review 3: a short timeout on the failing part's call inflated its queue-wait ratio, so every
 * fix aimed at a part that sat idle while the database before it drowned.)
 */
function bottleneck(signals: Signals): string | null {
  const sustained = signals.overloaded?.value.sustained ? signals.overloaded : null;
  return (sustained ?? signals.queueWaitOverTimeout ?? signals.wastedShare ?? signals.retryShare)?.tier ?? null;
}

/**
 * The signals as a one-call fix's "why" should quote them: the retry share of the part the fix's
 * call goes to, when retries reached it, rather than of whichever part had the highest share
 * (review 3: a fix on the database call quoted the load balancer's share). Fixes on every layer
 * keep quoting the highest share anywhere: they change all the calls.
 */
function aimedAt(signal: SignalName, signals: Signals, target: string): Signals {
  const share = signals.retryShareOf?.[target];
  if (signal !== 'retryShare' || share === undefined || !(share > 0)) return signals;
  return { ...signals, retryShare: { tier: target, value: share } };
}

/** One line quoting a signal and its number, e.g. "retries made up 74% of DB's load". */
export function describeSignal(signal: SignalName, s: Signals, config: RunConfig, name: (id: string) => string): string {
  switch (signal) {
    case 'overloaded':
      return `${name(s.overloaded!.tier)} got ${s.overloaded!.value.sustained ? 'on average' : 'up to'} ${formatRatio(s.overloaded!.value.load)} the work it can handle${s.overloaded!.value.sustained ? ' after the failure ended' : ''}`;
    case 'retryShare':
      return `retries made up ${percent(s.retryShare!.value)} of ${name(s.retryShare!.tier)}'s load`;
    case 'wastedShare':
      return `${percent(s.wastedShare!.value)} of ${name(s.wastedShare!.tier)} work was for requests whose caller had already given up`;
    case 'queueWaitOverTimeout': {
      const { tier, value } = s.queueWaitOverTimeout!;
      // The least patient caller: the one the signal measured against (see computeSignals).
      const caller = strictestCallInto(config, tier)!;
      return `requests waited in ${name(tier)}'s queue up to ${formatRatio(value)} longer than the ${name(caller.owner)}'s ${formatMs(caller.policy.timeoutMs!)} timeout`;
    }
    case 'idleSaturation':
      return `${name(s.idleSaturation!.tier)} workers were all occupied but mostly idle for ${s.idleSaturation!.value} s`;
    case 'cacheHitDrop': {
      const { tier, value } = s.cacheHitDrop!;
      return `${name(tier)} hit rate fell from ${percent(value.before)} to ${percent(value.during)}`;
    }
    case 'queueBacklog': {
      const { tier, value } = s.queueBacklog!;
      const busy = value.consumersBusy >= 0.99 ? ', with every consumer busy' : '';
      return `up to ${Math.round(value.peak).toLocaleString('en-US')} messages waited in ${name(tier)}${busy}`;
    }
  }
}

const formatRatio = (x: number) => `${x >= 10 ? Math.round(x) : x.toFixed(1)}×`;

/**
 * A call policy in the config, addressed so that a fix can change it:
 * - field 'call': the client's call (owner 'client');
 * - field 'downstream': a tier's first call (`downstream`);
 * - field 'more': a tier's further call `moreDownstream[index]` (branching);
 * - field 'cacheAside': a tier's cache lookups.
 * `index` is 0 except for 'more'.
 */
export interface CallRef {
  /** 'client' or the calling tier's id. */
  owner: string;
  field: 'call' | 'downstream' | 'more' | 'cacheAside';
  index: number;
  policy: CallPolicy;
}

/** The CallRef for a call edge of analysis/helpers (its downstream index 0 is `downstream`, k ≥ 1 is `moreDownstream[k − 1]`). */
export function refOf(edge: CallEdge): CallRef {
  if (edge.kind === 'call') return { owner: 'client', field: 'call', index: 0, policy: edge.policy };
  if (edge.kind === 'cacheAside') return { owner: edge.from, field: 'cacheAside', index: 0, policy: edge.policy };
  return edge.index === 0 ? { owner: edge.from, field: 'downstream', index: 0, policy: edge.policy } : { owner: edge.from, field: 'more', index: edge.index - 1, policy: edge.policy };
}

const sameCall = (a: CallRef, b: CallRef) => a.owner === b.owner && a.field === b.field && a.index === b.index;

/**
 * Whether a tier's workers were barely busy in a run: never more than a quarter of them busy on
 * average in any second. More servers for such a part change nothing.
 */
function barelyBusy(run: RunResult, id: string): boolean {
  const t = run.tiers[id];
  return t !== undefined && Math.max(0, ...t.busyWorkersAvg) < 0.25 * t.workers;
}

/** How many downstream calls a tier makes (cache lookups not counted); 0 for users' apps ('client'). */
function callsMadeBy(config: RunConfig, owner: string): number {
  const tier = config.tiers.find((t) => t.id === owner);
  return tier ? callsOf(tier).length : 0;
}

/**
 * The call into `tierId` a fix aimed at that tier changes, or null if nothing calls it. In a chain,
 * the one caller. With fan-in, the caller sending it the most (from the run if given, else by
 * share of user traffic; see analysis/helpers' heaviestCallerInto), the first on a tie.
 */
function heaviestCallInto(config: RunConfig, tierId: string, run?: RunResult): CallRef | null {
  const edge = heaviestCallerInto(config, tierId, run);
  return edge && refOf(edge);
}

/** The least patient call into `tierId` (shortest timeout; see strictestCallerInto), or null. */
function strictestCallInto(config: RunConfig, tierId: string): CallRef | null {
  const edge = strictestCallerInto(config, tierId);
  return edge && refOf(edge);
}

/** The two ends of a call, for the catalog's {caller} and {target}. */
const ends = (ref: CallRef) => ({ caller: ref.owner, target: ref.policy.target });

/**
 * The calls that lead to `tierId`: the call into it, then the call into that caller, and so on
 * out to the client's call (innermost first). With fan-in, each step follows the caller sending
 * the most (see heaviestCallInto). Empty when nothing calls it.
 * It stops at a message queue: its consumers' call is the outermost one. The queue answers its
 * senders as soon as it stores a message, so nobody in front of it retries because of what is
 * behind it (review 3: "cap retries" was aimed at users' apps, and changed nothing).
 */
function callsTowards(config: RunConfig, tierId: string, run?: RunResult): CallRef[] {
  const path: CallRef[] = [];
  const seen = new Set<string>();
  const isQueue = (id: string) => config.tiers.some((t) => t.id === id && t.queue !== undefined);
  // Validation forbids loops; `seen` makes sure a bad config cannot hang this.
  for (let ref = heaviestCallInto(config, tierId, run); ref !== null && !seen.has(ref.owner); ref = ref.owner === 'client' || isQueue(ref.owner) ? null : heaviestCallInto(config, ref.owner, run)) {
    seen.add(ref.owner);
    path.push(ref);
  }
  return path;
}

/**
 * The call a retry fix changes, or null if none fits: the first call, starting from the call into
 * the bottleneck and moving out towards users, that retries and that the fix would change
 * (`applies`).
 *
 * Why there? With one retrying layer this is the call whose retries arrive at the overloaded tier
 * (as before). With several, every layer's repeats end up there, and the choice was measured on
 * the three presets at their default settings (retries: users' apps 5, Load balancer 3, API 1). No
 * single-call change made a stuck run recover. Changing the call nearest the bottleneck never
 * failed more requests than doing nothing, while changing users' apps (the call with the most
 * retries, whose repeats are what the retryShare signal sees at the load balancer) often did: capping
 * them failed 24–45% more requests, a budget up to 9% more, because users' own repeats are what
 * rescue a request once the layers behind them have given up. Moving outwards from the bottleneck
 * lets "cap retries" reach the load balancer when the API already retries only once.
 */
function retryCallTowards(config: RunConfig, signals: Signals, applies: (ref: CallRef) => boolean, run?: RunResult): CallRef | null {
  const id = bottleneck(signals);
  if (id === null) return null;
  return callsTowards(config, id, run).find((ref) => ref.policy.retries > 0 && applies(ref)) ?? null;
}

/**
 * Every call in the config, front to back: the client's, then each tier's cache-aside call and
 * downstream calls (`downstream`, then each of `moreDownstream`), in config order.
 */
export function allCalls(config: RunConfig): CallRef[] {
  return allCallEdges(config).map(refOf);
}

/** Copies of the config with one change; everything untouched is shared, nothing is mutated. */
function withTier(config: RunConfig, id: string, patch: Partial<TierConfig>): RunConfig {
  return { ...config, tiers: config.tiers.map((t) => (t.id === id ? { ...t, ...patch } : t)) };
}

/** A copy of the config with one call's policy patched (any call: see CallRef). Never mutates `config`. */
export function withCall(config: RunConfig, ref: CallRef, patch: Partial<CallPolicy>): RunConfig {
  const policy = { ...ref.policy, ...patch };
  if (ref.field === 'call') return { ...config, client: { ...config.client, call: policy } };
  if (ref.field === 'more') {
    const more = tierOf(config, ref.owner).moreDownstream ?? [];
    return withTier(config, ref.owner, { moreDownstream: more.map((c, i) => (i === ref.index ? policy : c)) });
  }
  return withTier(config, ref.owner, { [ref.field]: policy });
}
