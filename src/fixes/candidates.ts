import { formatMs, leafCapacityRps, nameOf, percent } from '../analysis/helpers';
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
  why: string;
  pros: string[];
  cons: string[];
  config: RunConfig;
}

/**
 * Fixes worth trying for this run: each is the original config with one setting change. `why`
 * quotes the triggering signal with its number, e.g. "retries made up 74% of DB's load". Common
 * instincts get why = "it is a common first instinct". In catalog order; fixes that cannot be applied to
 * this config (or would change nothing) are left out.
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
      why: def.signal === null ? 'it is a common first instinct' : describeSignal(def.signal, signals, config, name),
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
}

function planFix(def: FixDefinition, config: RunConfig, signals: Signals, name: (id: string) => string): FixPlan | null {
  const callName = (ref: CallRef) => `${name(ref.owner)} → ${name(ref.policy.target)}`;
  const [caller, target] = [(ref: CallRef) => name(ref.owner), (ref: CallRef) => name(ref.policy.target)];
  switch (def.kind) {
    // Retry fixes change the call whose retries showed up: retries arriving at a tier were sent by
    // its caller (retries further up arrive there as first attempts).
    case 'retryBudget': {
      const ref = retryingCall(config, signals);
      const ratio = FIX_SETTINGS.retryBudgetRatio;
      if (ref === null || (ref.policy.retryBudget ?? Infinity) <= ratio) return null;
      return {
        config: withCall(config, ref, { retryBudget: ratio }),
        where: callName(ref),
        what: `${caller(ref)} stops retrying ${target(ref)} once retries reach ${percent(ratio)} of first attempts.`,
      };
    }
    case 'capRetries': {
      const ref = retryingCall(config, signals);
      if (ref === null || ref.policy.retries <= FIX_SETTINGS.maxRetries) return null;
      const n = FIX_SETTINGS.maxRetries;
      return {
        config: withCall(config, ref, { retries: n }),
        where: callName(ref),
        what: `${caller(ref)} retries a failed call to ${target(ref)} at most ${times(n)} (instead of ${times(ref.policy.retries)}).`,
      };
    }
    case 'jitterBackoff': {
      const ref = retryingCall(config, signals);
      if (ref === null || (ref.policy.jitter && ref.policy.backoffBaseMs > 0)) return null;
      // A call that retries immediately has no backoff to jitter, so it gets a base delay too.
      const patch = ref.policy.backoffBaseMs > 0 ? { jitter: true } : { jitter: true, backoffBaseMs: FIX_SETTINGS.jitterBaseMs };
      return {
        config: withCall(config, ref, patch),
        where: callName(ref),
        what: `${caller(ref)} waits a random, growing delay before each retry to ${target(ref)}, so retries spread out instead of arriving together.`,
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
        where: `${name(id)}, at most ${limit} queued per instance`,
        what: `${name(id)} lets at most ${limit} requests wait per instance and turns the rest away immediately.`,
      };
    }
    case 'dropExpired': {
      const id = signals.wastedShare?.tier;
      if (id === undefined || tierById(config, id).dropExpired) return null;
      return {
        config: withTier(config, id, { dropExpired: true }),
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
        where: name(tier.id),
        what: `When several requests miss the cache for the same key at once, ${name(tier.id)} makes one read and shares the result.`,
      };
    }
    case 'longerTimeout': {
      const id = bottleneck(signals);
      const ref = id === null ? null : callInto(config, id);
      if (ref === null || ref.policy.timeoutMs === null) return null;
      const timeoutMs = ref.policy.timeoutMs * FIX_SETTINGS.timeoutFactor;
      return {
        config: withCall(config, ref, { timeoutMs }),
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
  }
}

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

/** The call whose retries the retryShare signal measured, if it retries at all. */
function retryingCall(config: RunConfig, signals: Signals): CallRef | null {
  const ref = signals.retryShare === null ? null : callInto(config, signals.retryShare.tier);
  return ref !== null && ref.policy.retries > 0 ? ref : null;
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
