import type { CallPolicy, Fault, RunConfig, TierConfig } from '../engine/config';
import type { RunResult } from '../engine/result';
import type { Analysis } from './analyze';
import { callPolicyInto, formatMs, formatSeconds, leafCapacityRps, percent, spokenName, sumRange } from './helpers';

/** One sentence (or two) of a run's story, shown once the replay reaches `tMs`. */
export interface StoryStep {
  tMs: number;
  text: string;
  tone: 'fault' | 'bad' | 'good' | 'info';
}

/** Above this, the wasted-work and cache steps are told as one. */
const MAX_STEPS = 6;

/**
 * A plain-language, step-by-step account of a run for someone new to distributed systems: what
 * failed, why that caused trouble, and how it ended. Each step carries the run time at which the
 * replay has shown what it says (the start of the second it is based on, as in the timeline), so
 * the UI can reveal it when playback reaches that time. Every number comes from the run or its
 * config. Sorted by time.
 *
 * Words are chosen for newcomers: "gives up on an answer after 1 s" rather than "timeout", "asks
 * again" rather than "retry", "more requests than it can handle" rather than "over capacity".
 */
export function buildStory(run: RunResult, config: RunConfig, analysis: Analysis, labels: Record<string, string>): StoryStep[] {
  const r = analysis.recovery;
  const say = (id: string) => spokenName(id, labels);
  const faults = (config.faults ?? []).filter((f) => f.startMs < run.durationMs).sort((a, b) => a.startMs - b.startMs);
  if (faults.length === 0) return [notInRunStep(config, run), { tMs: 0, text: 'Nothing went wrong.', tone: 'good' }];

  const ctx: Context = { run, config, analysis, say, bucketMs: run.bucketMs };
  const main = faults[0];
  const pressure = pressureTier(config, main);
  const retries = callPolicyInto(config, pressure ?? main.tier)?.policy.retries ?? 0;
  const hadPile = queueAtEnd(ctx, pressure ?? main.tier, r.lastFaultEndMs) >= 1;

  const steps: StoryStep[] = [];
  for (const f of faults) steps.push({ tMs: f.startMs, text: faultStartText(f, ctx), tone: 'fault' });
  const cause = causeStep(main, ctx);
  if (cause) steps.push(cause);
  const overload = pressure === null ? null : overloadStep(pressure, main, ctx);
  if (overload) steps.push(overload);
  for (const f of faults) {
    if (f.endMs >= run.durationMs) continue; // still going on at the end: nothing to tell
    // Only the last failure to end leads into how it all ended.
    const suffix = f.endMs === r.lastFaultEndMs ? afterTheFailure(f, ctx, retries, hadPile) : '.';
    steps.push({ tMs: f.endMs, text: faultEndText(f, ctx) + suffix, tone: 'info' });
  }

  const wasteS = r.verdict === 'stuck' && pressure !== null ? wasteSecond(pressure, ctx) : null;
  const cache = cacheStep(faults, ctx);
  const verdict = verdictStep(ctx, pressure, hadPile);
  const count = steps.length + Number(wasteS !== null) + Number(cache !== null) + 1;
  if (wasteS !== null && cache !== null && count > MAX_STEPS) {
    // Told together, once the replay has shown both.
    const tMs = Math.max(wasteS * ctx.bucketMs, cache.tMs);
    steps.push({ tMs, text: `${wasteText(pressure!, wasteS, tMs / ctx.bucketMs, retries, ctx)} ${cache.text}`, tone: 'bad' });
  } else {
    if (wasteS !== null) steps.push({ tMs: wasteS * ctx.bucketMs, text: wasteText(pressure!, wasteS, wasteS, retries, ctx), tone: 'bad' });
    if (cache) steps.push(cache);
  }
  steps.push(verdict);
  return steps.sort((a, b) => a.tMs - b.tMs);
}

interface Context {
  run: RunResult;
  config: RunConfig;
  analysis: Analysis;
  say: (id: string) => string;
  bucketMs: number;
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const noun = (spoken: string) => spoken.replace(/^the /, '');
const tierOf = (config: RunConfig, id: string): TierConfig => config.tiers.find((t) => t.id === id)!;
/** "about 160", "about 20": round to two significant figures, which is all a newcomer needs. */
const about = (x: number) => `about ${x >= 100 ? Math.round(x / 10) * 10 : Math.round(x)}`;

/**
 * The tier whose load explains the trouble: the failed tier if it does the work itself (it calls
 * nothing), or, when a cache fails, the tier that cache protects. Null when neither applies (for
 * example a failed tier that calls others: its throughput depends on what it calls).
 */
function pressureTier(config: RunConfig, fault: Fault): string | null {
  const tier = tierOf(config, fault.tier);
  if (tier.cache) {
    const user = config.tiers.find((t) => t.cacheAside?.target === fault.tier);
    const behind = user?.downstream?.target;
    return behind !== undefined && leafCapacityRps(tierOf(config, behind)) !== null ? behind : null;
  }
  return leafCapacityRps(tier) === null ? null : fault.tier;
}

/** Who a fault hits: the tier, or "one of the 4 API instances". */
function who(f: Fault, ctx: Context): string {
  const instances = tierOf(ctx.config, f.tier).instances;
  return f.instance === undefined || instances === 1 ? ctx.say(f.tier) : `one of the ${instances} ${noun(ctx.say(f.tier))} instances`;
}

function lasting(ms: number): string {
  if (ms % 1000 !== 0) return formatMs(ms);
  return ms === 1000 ? '1 second' : `${ms / 1000} seconds`;
}

function faultStartText(f: Fault, ctx: Context): string {
  const howLong = f.endMs >= ctx.run.durationMs ? 'and stayed that way until the run ended' : `for ${lasting(f.endMs - f.startMs)}`;
  const what = f.kind === 'slow' ? `became ${f.factor}× slower` : 'went down';
  return `At ${formatSeconds(f.startMs)} ${who(f, ctx)} ${what} ${howLong}.`;
}

function faultEndText(f: Fault, ctx: Context): string {
  const back = f.kind === 'slow' ? 'back to normal speed' : 'back up';
  return `At ${formatSeconds(f.endMs)} ${who(f, ctx)} was ${back}${f.flushAtEnd ? ', but empty' : ''}`;
}

/** How the last failure's end sentence continues: was there a pile left, and did it stay? */
function afterTheFailure(f: Fault, ctx: Context, retries: number, hadPile: boolean): string {
  if (ctx.analysis.recovery.verdict === 'stuck') {
    const but = f.flushAtEnd ? 'and' : 'but'; // "back up, but empty" already has a "but"
    return ` — ${but} the pile of ${retries > 0 ? 'repeated' : 'waiting'} requests was still there.`;
  }
  return hadPile ? ' and started on the requests that had piled up.' : '.';
}

/** What a caller does after giving up: "asks again, up to 3 more times". */
function askAgain(policy: CallPolicy, callerId: string): string {
  if (policy.retries === 0) return callerId === 'client' ? 'does not ask again, so those users saw an error' : 'does not ask again, so those users got an error';
  const times = policy.retries === 1 ? 'asks again once' : `asks again, up to ${policy.retries} more times`;
  return policy.retryBudget === undefined ? times : `${times}, as long as repeats stay under ${percent(policy.retryBudget)} of its requests`;
}

/**
 * Why the failure matters to the caller: it gives up waiting (a slowdown) or gets an error at
 * once (an outage), and asks again or passes the error on. For a failed cache: lookups go to the
 * tier behind it instead. Null when the caller never noticed (answers stayed within its patience).
 */
function causeStep(f: Fault, ctx: Context): StoryStep | null {
  const call = callPolicyInto(ctx.config, f.tier);
  if (call === null) return null;
  const caller = ctx.say(call.id);
  const target = noun(ctx.say(f.tier));
  const firstSlow = (): number | null => {
    if (call.policy.timeoutMs === null) return null;
    const t = ctx.run.tiers[f.tier];
    const from = Math.floor(f.startMs / ctx.bucketMs);
    const to = Math.min(Math.ceil(f.endMs / ctx.bucketMs), Math.floor(ctx.analysis.recovery.judgedUntilMs / ctx.bucketMs));
    for (let s = from; s < to; s++) if (t.latencyP99Ms[s] > call.policy.timeoutMs) return s * ctx.bucketMs;
    return null;
  };

  const callerTier = call.id === 'client' ? null : tierOf(ctx.config, call.id);
  if (tierOf(ctx.config, f.tier).cache && callerTier?.cacheAside?.target === f.tier && callerTier.downstream) {
    const behind = ctx.say(callerTier.downstream.target);
    if (f.kind === 'dead') return { tMs: f.startMs, text: `Without ${ctx.say(f.tier)}, ${caller} sent every lookup to ${behind} instead.`, tone: 'info' };
    const tMs = firstSlow();
    return tMs === null ? null : { tMs, text: `${capitalise(caller)} gives up on ${ctx.say(f.tier)} after ${formatMs(call.policy.timeoutMs!)} and asks ${behind} instead.`, tone: 'info' };
  }

  const again = askAgain(call.policy, call.id);
  if (f.kind === 'dead') {
    const from = f.instance === undefined ? `from ${ctx.say(f.tier)}` : 'for requests sent to that instance';
    return { tMs: f.startMs, text: `${capitalise(caller)} gets an error ${from} straight away and ${again}.`, tone: 'info' };
  }
  const tMs = firstSlow();
  if (tMs === null) return null;
  const article = /^[aeiou]/i.test(target) ? 'an' : 'a';
  return { tMs, text: `${capitalise(caller)} gives up on ${article} ${target} answer after ${formatMs(call.policy.timeoutMs!)} and ${again}.`, tone: 'info' };
}

/** Share of the tier's usual speed left during a fault: slowed or down, the whole tier or one instance. */
function speedLeft(f: Fault, tier: TierConfig): number {
  const one = f.kind === 'slow' ? 1 / (f.factor ?? 1) : 0;
  if (f.instance === undefined) return one;
  return (tier.instances - 1 + one) / tier.instances;
}

/**
 * The moment the tier got more requests than it can handle. Preferably more than it can handle
 * even at full speed (the requests asked again, or a cache that stopped helping, did that); failing
 * that, more than it could handle while the failure slowed it (or took an instance down).
 */
function overloadStep(id: string, main: Fault, ctx: Context): StoryStep | null {
  const tier = tierOf(ctx.config, id);
  const capacity = leafCapacityRps(tier)!;
  const t = ctx.run.tiers[id];
  const load = (s: number) => ((t.arrivalsFirst[s] + t.arrivalsRetry[s]) * 1000) / ctx.bucketMs;
  const from = Math.floor(main.startMs / ctx.bucketMs);
  const to = Math.floor(ctx.analysis.recovery.judgedUntilMs / ctx.bucketMs);
  const name = ctx.say(id);
  // While the whole tier is down it refuses everything at once, so its load says nothing.
  const down = (s: number) => (ctx.config.faults ?? []).some((f) => f.tier === id && f.kind === 'dead' && f.instance === undefined && f.startMs < (s + 1) * ctx.bucketMs && f.endMs > s * ctx.bucketMs);
  const failureEndS = Math.ceil(ctx.analysis.recovery.lastFaultEndMs / ctx.bucketMs);
  const retries = (callPolicyInto(ctx.config, id)?.policy.retries ?? 0) > 0;
  for (let s = from; s < to; s++) {
    if (load(s) > capacity && !down(s)) {
      const full = `even at full speed (${about(capacity)} a second)`;
      const text = s < failureEndS
        ? `So ${name} got more requests than it can handle, ${full}.`
        : retries
          ? `Then the requests asked again pushed ${name} past what it can handle, ${full}.`
          : `Then ${name} got more requests than it can handle, ${full}.`;
      return { tMs: s * ctx.bucketMs, text, tone: 'bad' };
    }
  }

  const left = main.tier === id ? speedLeft(main, tier) : 0;
  if (left === 0) return null; // nothing to compare with: it refused everything
  const reduced = capacity * left;
  const how = main.instance === undefined || tier.instances === 1 ? 'Slowed down' : main.kind === 'slow' ? 'With one instance slowed' : 'With one instance down';
  const end = Math.min(Math.ceil(main.endMs / ctx.bucketMs), to);
  for (let s = from; s < end; s++) {
    if (load(s) > reduced) {
      return { tMs: s * ctx.bucketMs, text: `${how}, ${name} could serve only ${about(reduced)} requests a second, but it got ${Math.round(load(s))}.`, tone: 'bad' };
    }
  }
  return null;
}

/** Average queue in the second just before `atMs`. */
function queueAtEnd(ctx: Context, id: string, atMs: number): number {
  const s = Math.min(Math.floor(atMs / ctx.bucketMs), ctx.run.tiers[id].queueAvg.length) - 1;
  return s >= 0 ? ctx.run.tiers[id].queueAvg[s] : 0;
}

/** Share of the tier's compute spent on abandoned requests, over seconds [from, to]. */
function wastedShare(id: string, from: number, to: number, ctx: Context): number {
  const t = ctx.run.tiers[id];
  const busy = sumRange(t.busyCoresAvg, from, to + 1) * ctx.bucketMs;
  return busy > 0 ? sumRange(t.wastedMs, from, to + 1) / busy : 0;
}

/** First second after the failure ended in which most of the tier's work was for abandoned requests. */
function wasteSecond(id: string, ctx: Context): number | null {
  const r = ctx.analysis.recovery;
  const from = Math.floor(r.lastFaultEndMs / ctx.bucketMs) + 1;
  const to = Math.floor(r.judgedUntilMs / ctx.bucketMs);
  for (let s = from; s < to; s++) if (wastedShare(id, s, s, ctx) >= 0.5) return s;
  return null;
}

/**
 * Wasted work over seconds [fromS, untilS]. Wasted time is booked when an abandoned request
 * finishes, so over a short window it can exceed the time measured busy: above 95% it is "almost
 * all", without a number.
 */
function wasteText(id: string, fromS: number, untilS: number, retries: number, ctx: Context): string {
  const share = wastedShare(id, fromS, untilS, ctx);
  const most = share >= 0.95 ? 'Almost all' : `${percent(share)} of`;
  return `${most} ${ctx.say(id)}'s work was for requests nobody was waiting for any more, so new ones were given up on${retries > 0 ? ' and asked again' : ''} too.`;
}

/**
 * The cache stopped helping: its hit rate fell below half of normal (same rule as the timeline).
 * Not told when the cache itself is what failed: the failure step already says so.
 */
function cacheStep(faults: Fault[], ctx: Context): StoryStep | null {
  const drop = ctx.analysis.signals.cacheHitDrop;
  if (drop === null || faults.some((f) => f.tier === drop.tier)) return null;
  const owner = ctx.config.tiers.find((t) => t.cacheAside?.target === drop.tier);
  if (!owner?.downstream) return null;
  const t = ctx.run.tiers[drop.tier];
  const from = Math.floor(faults[0].startMs / ctx.bucketMs);
  const to = Math.floor(ctx.analysis.recovery.judgedUntilMs / ctx.bucketMs);
  for (let s = from; s < to; s++) {
    const rate = t.hits[s] / Math.max(1, t.arrivalsFirst[s] + t.arrivalsRetry[s]);
    if (rate < drop.value.before / 2) {
      const text = `${capitalise(noun(ctx.say(drop.tier)))} entries ran out and weren't refilled, sending even more requests to ${ctx.say(owner.downstream.target)}.`;
      return { tMs: s * ctx.bucketMs, text, tone: 'bad' };
    }
  }
  return null;
}

function notInRunStep(config: RunConfig, run: RunResult): StoryStep {
  const starts = (config.faults ?? []).map((f) => f.startMs);
  if (starts.length === 0) return { tMs: 0, text: 'Nothing is set to fail in this run.', tone: 'info' };
  return { tMs: 0, text: `The failure is set to start at ${formatSeconds(Math.min(...starts))}, but this run ends at ${formatSeconds(run.durationMs)}, so it never happens.`, tone: 'info' };
}

/** How it ended, at the moment that became known. */
function verdictStep(ctx: Context, pressure: string | null, hadPile: boolean): StoryStep {
  const r = ctx.analysis.recovery;
  switch (r.verdict) {
    case 'recovered': {
      const text = r.recoveryMs === 0
        ? 'It was back to normal as soon as the failure ended.'
        : `${hadPile ? 'It worked through the backlog and was' : 'It was'} back to normal ${formatSeconds(r.recoveryMs!)} after the failure ended.`;
      return { tMs: r.recoveredAtMs!, text, tone: 'good' };
    }
    case 'unaffected':
      return { tMs: Math.min(r.lastFaultEndMs, ctx.run.durationMs), text: 'It coped: requests did just as well as they would have without the failure.', tone: 'good' };
    case 'overloaded':
      return { tMs: 0, text: 'Even without the failure, this much traffic is more than the system can handle, so requests fail anyway.', tone: 'bad' };
    case 'stuck': {
      if (r.lastFaultEndMs >= r.judgedUntilMs) return { tMs: r.judgedUntilMs, text: 'The failure was still going on when the run ended, so there was no time to recover.', tone: 'bad' };
      return { tMs: r.judgedUntilMs, text: `It never recovered: still failing at the end of the run${peakAfter(ctx, pressure)}.`, tone: 'bad' };
    }
  }
}

/** ", with the database getting up to 4.8× the work it can handle", measured after the failure ended; '' if never over. */
function peakAfter(ctx: Context, id: string | null): string {
  if (id === null) return '';
  const { lastFaultEndMs, judgedUntilMs } = ctx.analysis.recovery;
  const capacity = leafCapacityRps(tierOf(ctx.config, id))!;
  const t = ctx.run.tiers[id];
  let peak = 0;
  for (let s = Math.floor(lastFaultEndMs / ctx.bucketMs); s < Math.floor(judgedUntilMs / ctx.bucketMs); s++) {
    peak = Math.max(peak, ((t.arrivalsFirst[s] + t.arrivalsRetry[s]) * 1000) / ctx.bucketMs / capacity);
  }
  return peak > 1 ? `, with ${ctx.say(id)} getting up to ${peak.toFixed(1)}× the work it can handle` : '';
}
