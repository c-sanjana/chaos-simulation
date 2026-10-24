import { formatMs, leafCapacityRps, nameOf, percent, spokenName } from '../analysis/helpers';
import type { Signals } from '../analysis/signals';
import type { CallPolicy, RunConfig, TierConfig } from '../engine/config';
import { FIX_CATALOG, FIX_SETTINGS, type FixDefinition } from './catalog';

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
 */
export function candidateFixes(config: RunConfig, signals: Signals, labels: Record<string, string>): FixCandidate[] {
  const name = (id: string) => nameOf(id, labels);
  const candidates: FixCandidate[] = [];
  for (const def of FIX_CATALOG) {
    if (def.signal !== null && signals[def.signal] === null) continue;
    const plan = planFix(def, config, signals, name);
    if (plan === null) continue;
    candidates.push({
      id: def.id,
      title: `${def.title}: ${plan.where}`,
      name: def.title,
      short: def.short,
      what: plan.what,
      how: fillNames(plan.how ?? def.how, plan.caller, plan.target, labels),
      why: def.signal === null ? COMMON_INSTINCT : describeSignal(def.signal, signals, config, name),
      pros: def.pros,
      cons: def.cons,
      config: plan.config,
    });
  }
  return candidates;
}

/** The config with `def` applied, or null when it does not apply to this config. Never mutates `config`. */
export function applyFix(def: FixDefinition, config: RunConfig, signals: Signals): RunConfig | null {
  return planFix(def, config, signals, (id) => id)?.config ?? null;
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

function planFix(def: FixDefinition, config: RunConfig, signals: Signals, name: (id: string) => string): FixPlan | null {
  const callName = (ref: CallRef) => `${name(ref.owner)} → ${name(ref.policy.target)}`;
  const [caller, target] = [(ref: CallRef) => name(ref.owner), (ref: CallRef) => name(ref.policy.target)];
  /** Who makes a call: "users' apps" (the client), "the API", or "the API's Cache lookups" (plural except a tier's main call). */
  const maker = (ref: CallRef) =>
    ref.owner === 'client' ? "users' apps" : ref.field === 'cacheAside' ? `the ${name(ref.owner)}'s ${name(ref.policy.target)} lookups` : `the ${name(ref.owner)}`;
  switch (def.kind) {
    // Retry fixes change one call: see retryCallFor for which.
    case 'retryBudget': {
      const ratio = FIX_SETTINGS.retryBudgetRatio;
      const ref = retryCallFor(config, signals, (r) => (r.policy.retryBudget ?? Infinity) > ratio);
      if (ref === null) return null;
      return {
        config: withCall(config, ref, { retryBudget: ratio }),
        ...ends(ref),
        where: callName(ref),
        what: `${caller(ref)} stops retrying ${target(ref)} once retries reach ${percent(ratio)} of first attempts.`,
      };
    }
    case 'capRetries': {
      const n = FIX_SETTINGS.maxRetries;
      const ref = retryCallFor(config, signals, (r) => r.policy.retries > n);
      if (ref === null) return null;
      return {
        config: withCall(config, ref, { retries: n }),
        ...ends(ref),
        where: callName(ref),
        what: `${caller(ref)} retries a failed call to ${target(ref)} at most ${times(n)} (instead of ${times(ref.policy.retries)}).`,
      };
    }
    case 'jitterBackoff': {
      const ref = retryCallFor(config, signals, (r) => !(r.policy.jitter && r.policy.backoffBaseMs > 0));
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
      const keep = retryCallFor(config, signals, () => true) ?? retrying[retrying.length - 1];
      const others = retrying.filter((r) => r.owner !== keep.owner || r.field !== keep.field);
      let fixed = config;
      for (const r of others) fixed = withCall(fixed, r, { retries: 0 });
      const makers = others.map(maker);
      const n = keep.policy.retries;
      const plural = others.length > 1 || others[0].field !== 'downstream';
      const only = keep.field === 'downstream' ? `Only ${maker(keep)} asks` : `Only ${maker(keep)} ask`;
      return {
        config: fixed,
        ...ends(keep),
        where: callName(keep),
        what: `${only} the ${target(keep)} again (${n === 1 ? 'once' : `up to ${n} times`}); ${listed(makers)} no longer ${plural ? 'retry' : 'retries'}.`,
      };
    }
    case 'boundQueue': {
      const id = signals.queueWaitOverTimeout?.tier;
      const timeoutMs = id === undefined ? null : callInto(config, id)?.policy.timeoutMs ?? null;
      if (id === undefined || timeoutMs === null) return null;
      const tier = tierById(config, id);
      const limit = queueLimitFor(tier, timeoutMs);
      if (tier.queueLimit !== null && tier.queueLimit <= limit) return null;
      return {
        config: withTier(config, id, { queueLimit: limit }),
        ...ends(callInto(config, id)!),
        where: `${name(id)}, at most ${limit} queued per instance`,
        what: `${name(id)} lets at most ${limit} requests wait per instance and turns the rest away immediately.`,
      };
    }
    case 'dropExpired': {
      const id = signals.wastedShare?.tier;
      const ref = id === undefined ? null : callInto(config, id);
      // A tier nothing calls has no caller to give up on it.
      if (id === undefined || ref === null || tierById(config, id).dropExpired) return null;
      return {
        config: withTier(config, id, { dropExpired: true }),
        ...ends(ref),
        where: name(id),
        what: `${name(id)} skips requests whose caller has already timed out, instead of doing work nobody will use.`,
      };
    }
    case 'coalesceMisses': {
      const cacheId = signals.cacheHitDrop?.tier;
      const tier = config.tiers.find((t) => t.cacheAside !== undefined && t.cacheAside.target === cacheId);
      if (tier === undefined || tier.coalesceMisses) return null;
      return {
        config: withTier(config, tier.id, { coalesceMisses: true }),
        caller: tier.id,
        target: tier.downstream!.target, // validation: cacheAside needs a downstream

        where: name(tier.id),
        what: `When several requests miss the cache for the same key at once, ${name(tier.id)} makes one read and shares the result.`,
      };
    }
    case 'moreConsumers': {
      const id = signals.queueBacklog?.tier;
      const tier = id === undefined ? undefined : tierById(config, id);
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
      const ref = id === null ? null : callInto(config, id);
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
      // exhausted). When the bottleneck is the entry tier, the caller is the client, so scale the
      // bottleneck itself.
      const id = bottleneck(signals);
      if (id === null) return null;
      const caller = callInto(config, id);
      const target = caller === null || caller.owner === 'client' ? id : caller.owner;
      const before = tierById(config, target).instances;
      const instances = Math.ceil(before * FIX_SETTINGS.instanceFactor);
      return {
        config: withTier(config, target, { instances }),
        caller: target,
        target: id,
        // Scaling the overloaded tier itself does add room for the work.
        how: target === id ? '{Target} gets more servers, so it can handle more work. That helps only if the extra room keeps up with the repeats as well.' : undefined,
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
 * The most overloaded tier, where the common instincts are aimed: where queued work most outlasted
 * its caller's patience; failing that, where the most work was wasted, or where retries piled up.
 * Null when none of these showed up, i.e. nothing was overloaded.
 */
function bottleneck(signals: Signals): string | null {
  return (signals.queueWaitOverTimeout ?? signals.wastedShare ?? signals.retryShare)?.tier ?? null;
}

/** One line quoting a signal and its number, e.g. "retries made up 74% of DB's load". */
export function describeSignal(signal: keyof Signals, s: Signals, config: RunConfig, name: (id: string) => string): string {
  switch (signal) {
    case 'retryShare':
      return `retries made up ${percent(s.retryShare!.value)} of ${name(s.retryShare!.tier)}'s load`;
    case 'wastedShare':
      return `${percent(s.wastedShare!.value)} of ${name(s.wastedShare!.tier)} work was for requests whose caller had already given up`;
    case 'queueWaitOverTimeout': {
      const { tier, value } = s.queueWaitOverTimeout!;
      const caller = callInto(config, tier)!;
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

/** "a", "a and b", "a, b and c". */
const listed = (items: string[]) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

const times = (n: number) => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`);

const formatRatio = (x: number) => `${x >= 10 ? Math.round(x) : x.toFixed(1)}×`;

/** A call policy in the config: the client's call, or a tier's downstream or cacheAside call. */
interface CallRef {
  /** 'client' or the calling tier's id. */
  owner: string;
  field: 'call' | 'downstream' | 'cacheAside';
  policy: CallPolicy;
}

/** The call into `tierId` (the same caller as analysis/helpers' callerOf), or null. */
function callInto(config: RunConfig, tierId: string): CallRef | null {
  if (config.client.call.target === tierId) return { owner: 'client', field: 'call', policy: config.client.call };
  for (const t of config.tiers) {
    for (const field of ['downstream', 'cacheAside'] as const) {
      const policy = t[field];
      if (policy?.target === tierId) return { owner: t.id, field, policy };
    }
  }
  return null;
}

/** The two ends of a call, for the catalog's {caller} and {target}. */
const ends = (ref: CallRef) => ({ caller: ref.owner, target: ref.policy.target });

/**
 * The calls that lead to `tierId`: the call into it, then the call into that caller, and so on
 * out to the client's call (innermost first). Empty when nothing calls it.
 */
function callsTowards(config: RunConfig, tierId: string): CallRef[] {
  const path: CallRef[] = [];
  const seen = new Set<string>();
  // Validation forbids loops; `seen` makes sure a bad config cannot hang this.
  for (let ref = callInto(config, tierId); ref !== null && !seen.has(ref.owner); ref = ref.owner === 'client' ? null : callInto(config, ref.owner)) {
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
 * the three presets at their default settings (retries: users' apps 5, Gateway 3, API 1). No
 * single-call change made a stuck run recover. Changing the call nearest the bottleneck never
 * failed more requests than doing nothing, while changing users' apps (the call with the most
 * retries, whose repeats are what the retryShare signal sees at the Gateway) often did: capping
 * them failed 24–45% more requests, a budget up to 9% more, because users' own repeats are what
 * rescue a request once the layers behind them have given up. Moving outwards from the bottleneck
 * lets "cap retries" reach the Gateway when the API already retries only once.
 */
function retryCallFor(config: RunConfig, signals: Signals, applies: (ref: CallRef) => boolean): CallRef | null {
  const id = bottleneck(signals);
  if (id === null) return null;
  return callsTowards(config, id).find((ref) => ref.policy.retries > 0 && applies(ref)) ?? null;
}

/** Every call in the config, front to back: the client's, then each tier's cache-aside and downstream calls. */
function allCalls(config: RunConfig): CallRef[] {
  const calls: CallRef[] = [{ owner: 'client', field: 'call', policy: config.client.call }];
  for (const t of config.tiers) {
    for (const field of ['cacheAside', 'downstream'] as const) {
      const policy = t[field];
      if (policy) calls.push({ owner: t.id, field, policy });
    }
  }
  return calls;
}

function tierById(config: RunConfig, id: string): TierConfig {
  return config.tiers.find((t) => t.id === id)!;
}

/** Copies of the config with one change; everything untouched is shared, nothing is mutated. */
function withTier(config: RunConfig, id: string, patch: Partial<TierConfig>): RunConfig {
  return { ...config, tiers: config.tiers.map((t) => (t.id === id ? { ...t, ...patch } : t)) };
}

function withCall(config: RunConfig, ref: CallRef, patch: Partial<CallPolicy>): RunConfig {
  const policy = { ...ref.policy, ...patch };
  if (ref.owner === 'client') return { ...config, client: { ...config.client, call: policy } };
  return withTier(config, ref.owner, { [ref.field]: policy });
}
