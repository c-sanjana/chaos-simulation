import { callsOf, type CallPolicy, type Fault, type RunConfig, type TierConfig } from '../engine/config';
import type { RunResult } from '../engine/result';
import type { Analysis } from './analyze';
import {
  admittedIn,
  callersInFront,
  callersOf,
  callFraction,
  callsFrom,
  formatMs,
  formatSeconds,
  leafCapacityRps,
  pathsTo,
  percent,
  reachableFrom,
  reachableLeaves,
  spokenName,
  sumRange,
  topologicalOrder,
  type CallEdge,
} from './helpers';

/** What kind of moment a story step is, for its picture in the infographic. */
export type StoryKind = 'fault' | 'giveup' | 'back' | 'overload' | 'waste' | 'cache' | 'backlog' | 'recovered' | 'stuck' | 'info';

/**
 * One step of a run's story, shown once the replay reaches `tMs`: a full sentence (`text`, for
 * reading and screen readers) and the same moment as a picture: a headline of a few words, its key
 * number, and optionally a meter (load against capacity) or the retry cascade.
 */
export interface StoryStep {
  tMs: number;
  text: string;
  tone: 'fault' | 'bad' | 'good' | 'info';
  kind: StoryKind;
  /** Two to four words, e.g. "Database 8× slower". */
  headline: string;
  /** The key number, e.g. "5 s", "1 s", "98%". */
  figure?: string;
  /** Load as a multiple of capacity (1 = exactly full), drawn as a meter. */
  meter?: number;
  /** Each retrying caller's retries, front to back, e.g. users' apps 5, gateway 3, API 1. */
  cascade?: Array<{ who: string; retries: number }>;
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
  if (faults.length === 0) return [notInRunStep(config, run), { tMs: 0, text: 'Nothing went wrong.', tone: 'good', kind: 'recovered', headline: 'Nothing went wrong' }];

  const ctx: Context = { run, config, analysis, say, bucketMs: run.bucketMs };
  const main = faults[0];
  const pressure = pressureTier(ctx, main);
  // Any layer asking again makes the pile one of repeated requests: retries further up arrive
  // further down as new requests.
  const retries = askingAgain(ctx, main.tier).length;
  const hadPile = [pressure, main.tier].some((id) => id !== null && queueAtEnd(ctx, id, r.lastFaultEndMs) >= 1);

  const steps: StoryStep[] = [];
  for (const f of faults) {
    const what = f.kind === 'slow' ? `${f.factor}× slower` : f.flushAtEnd ? 'down, then empty' : 'down';
    const figure = f.endMs >= run.durationMs ? 'to the end' : formatSeconds(f.endMs - f.startMs);
    steps.push({ tMs: f.startMs, text: faultStartText(f, ctx), tone: 'fault', kind: 'fault', headline: `${partName(f, ctx)} ${what}`, figure });
  }
  const cause = causeStep(main, ctx);
  if (cause) steps.push(cause);
  for (const f of faults) {
    if (f.endMs >= run.durationMs) continue; // still going on at the end: nothing to tell
    // Only the last failure to end leads into how it all ended.
    const suffix = f.endMs === r.lastFaultEndMs ? afterTheFailure(f, ctx, retries, hadPile) : '.';
    const back = f.kind === 'slow' ? 'back to speed' : f.flushAtEnd ? 'back, empty' : 'back up';
    const pile = r.verdict === 'stuck' && f.endMs === r.lastFaultEndMs ? 'pile remains' : undefined;
    steps.push({ tMs: f.endMs, text: faultEndText(f, ctx) + suffix, tone: 'info', kind: 'back', headline: `${partName(f, ctx)} ${back}`, figure: pile });
  }
  // After the end steps, so that an overload starting as the failure ends is told after it ends.
  const overload = pressure === null ? null : overloadStep(pressure, main, ctx, retries > 0);
  if (overload) steps.push(overload);

  const wasteS = r.verdict === 'stuck' && pressure !== null ? wasteSecond(pressure, ctx) : null;
  const cache = cacheStep(faults, ctx);
  const verdict = verdictStep(ctx, pressure, hadPile);
  const count = steps.length + Number(wasteS !== null) + Number(cache !== null) + 1;
  if (wasteS !== null && cache !== null && count > MAX_STEPS) {
    // Told together, once the replay has shown both.
    const tMs = Math.max(wasteS * ctx.bucketMs, cache.tMs);
    const share = wastedShare(pressure!, wasteS, tMs / ctx.bucketMs, ctx);
    steps.push({ tMs, text: `${wasteText(pressure!, wasteS, tMs / ctx.bucketMs, retries, ctx)} ${cache.text}`, tone: 'bad', kind: 'waste', headline: 'Wasted work, cache empty', figure: wasteFigure(share) });
  } else {
    if (wasteS !== null) {
      const share = wastedShare(pressure!, wasteS, wasteS, ctx);
      steps.push({ tMs: wasteS * ctx.bucketMs, text: wasteText(pressure!, wasteS, wasteS, retries, ctx), tone: 'bad', kind: 'waste', headline: 'Work for nobody', figure: wasteFigure(share) });
    }
    if (cache) steps.push(cache);
  }
  const backlog = backlogStep(ctx);
  if (backlog) steps.push(backlog);
  steps.push(verdict);
  return steps.sort((a, b) => a.tMs - b.tMs);
}

/**
 * Messages piling up in a queue, told once more wait than its consumers can hold at once. Its
 * senders are answered as soon as a message is stored, so users don't notice: this step is how
 * the viewer learns that work is falling behind.
 */
function backlogStep(ctx: Context): StoryStep | null {
  const signal = ctx.analysis.signals.queueBacklog;
  if (!signal) return null;
  const t = ctx.run.tiers[signal.tier];
  const from = Math.floor(Math.min(...(ctx.config.faults ?? []).map((f) => f.startMs)) / ctx.bucketMs);
  const s = t.backlogAvg.findIndex((b, i) => i >= from && b > t.consumers);
  if (s < 0) return null;
  const peak = Math.round(signal.value.peak).toLocaleString('en-US');
  const dropped = Math.round(signal.value.deadLettered);
  const lost = dropped === 1 ? ' One message kept failing and was dropped.' : dropped > 1 ? ` ${dropped.toLocaleString('en-US')} messages kept failing and were dropped.` : '';
  const text = `Messages piled up in ${ctx.say(signal.tier)}: up to ${peak} waiting. The people sending them didn't notice: it answers as soon as it stores a message.${lost}`;
  return { tMs: s * ctx.bucketMs, text, tone: 'bad', kind: 'backlog', headline: `${capitalise(noun(ctx.say(signal.tier)))} backing up`, figure: `${peak} waiting` };
}

interface Context {
  run: RunResult;
  config: RunConfig;
  analysis: Analysis;
  say: (id: string) => string;
  bucketMs: number;
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** "a", "a and b", "a, b and c" (or "a or b"). */
const listed = (items: string[], and = 'and') => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} ${and} ${items[items.length - 1]}`);
const noun = (spoken: string) => spoken.replace(/^the /, '');
const tierOf = (config: RunConfig, id: string): TierConfig => config.tiers.find((t) => t.id === id)!;
/** "about 160", "about 20": round to two significant figures, which is all a newcomer needs. */
const about = (x: number) => `about ${x >= 100 ? Math.round(x / 10) * 10 : Math.round(x)}`;

/**
 * The tier whose load explains the trouble: the failed tier if it does the work itself (it calls
 * nothing), or, when a cache fails, the tier that cache protects (with several, e.g. a cache in
 * front of a fan-out, the one that got the most work for what it can handle). When a tier that
 * calls others fails (the Gateway, say), the tier it relies on that got the most work for what it
 * can handle, if that ever went over. Null otherwise.
 */
function pressureTier(ctx: Context, fault: Fault): string | null {
  const { config } = ctx;
  const tier = tierOf(config, fault.tier);
  if (tier.cache) {
    const behind = behindCache(config, fault.tier).filter((id) => leafCapacityRps(tierOf(config, id)) !== null);
    if (behind.length <= 1) return behind[0] ?? null;
    return behind.map((id) => ({ id, peak: peakLoad(ctx, id, fault.startMs) })).sort((a, b) => b.peak - a.peak)[0].id;
  }
  if (leafCapacityRps(tier) !== null) {
    // When a load balancer splits traffic over the failed part and others, repeats split afresh
    // and can land on the others, overloading them instead: tell the one that got the most work
    // for what it can handle, if it got more than the failed part and more than it can handle.
    const own = peakLoad(ctx, fault.tier, fault.startMs);
    const others = splitSiblings(config, fault.tier).map((id) => ({ id, peak: peakLoad(ctx, id, fault.startMs) }));
    const worst = others.sort((a, b) => b.peak - a.peak)[0];
    return worst !== undefined && worst.peak > 1 && worst.peak > own ? worst.id : fault.tier;
  }
  const peaks = reachableLeaves(config, fault.tier).map((id) => ({ id, peak: peakLoad(ctx, id, fault.startMs) }));
  const worst = peaks.sort((a, b) => b.peak - a.peak)[0];
  return worst !== undefined && worst.peak > 1 ? worst.id : null;
}

/**
 * The tiers doing the work themselves behind the other branches of every split that includes
 * `id` (a load balancer's other pools), not `id` itself. Empty in a chain.
 */
function splitSiblings(config: RunConfig, id: string): string[] {
  const out = new Set<string>();
  for (const caller of config.tiers) {
    const calls = callsOf(caller);
    if (caller.fanOut !== 'split' || calls.length < 2 || !calls.some((c) => c.target === id)) continue;
    for (const c of calls) {
      if (c.target === id) continue;
      for (const leaf of [c.target, ...reachableFrom(config, c.target)]) if (leaf !== id && leafCapacityRps(tierOf(config, leaf)) !== null) out.add(leaf);
    }
  }
  return [...out];
}

/** The tiers a miss in `cacheId` is read from: every downstream call of every tier that looks things up in it. */
function behindCache(config: RunConfig, cacheId: string): string[] {
  const users = config.tiers.filter((t) => t.cacheAside?.target === cacheId);
  return [...new Set(users.flatMap((t) => callsOf(t).map((c) => c.target)))];
}

/** Highest load on a tier that calls nothing, as a multiple of what it can handle, from `fromMs` to the end of the judged range. */
function peakLoad(ctx: Context, id: string, fromMs: number): number {
  const capacity = leafCapacityRps(tierOf(ctx.config, id))!;
  const t = ctx.run.tiers[id];
  let peak = 0;
  for (let s = Math.floor(fromMs / ctx.bucketMs); s < Math.floor(ctx.analysis.recovery.judgedUntilMs / ctx.bucketMs); s++) {
    peak = Math.max(peak, (admittedIn(t, s) * 1000) / ctx.bucketMs / capacity);
  }
  return peak;
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
    // Behind a queue the pile is of messages, whatever retried in front of it.
    const queue = ctx.config.tiers.find((t) => t.queue && ctx.run.tiers[t.id].backlogAvg[Math.floor(f.endMs / ctx.bucketMs)] >= 1);
    if (queue) return ` — ${but} the pile of messages in ${ctx.say(queue.id)} was still there.`;
    return ` — ${but} the pile of ${retries > 0 ? 'repeated' : 'waiting'} requests was still there.`;
  }
  return hadPile ? ' and started on the requests that had piled up.' : '.';
}

/**
 * Who makes a call, as the story says it: users' apps for the client (plural), otherwise the
 * caller's spoken name. `verb(singular, plural)` picks the matching verb form.
 */
function callerWords(id: string, ctx: Context): { name: string; verb: (singular: string, plural: string) => string } {
  const users = id === 'client';
  return { name: users ? "users' apps" : ctx.say(id), verb: (singular, plural) => (users ? plural : singular) };
}

const times = (n: number) => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`);

/** What a caller does after giving up: "asks again, up to 3 more times". */
function askAgain(policy: CallPolicy, callerId: string, ctx: Context): string {
  const { verb } = callerWords(callerId, ctx);
  if (policy.retries === 0) return `${verb('does', 'do')} not ask again, so those users ${callerId === 'client' ? 'saw' : 'got'} an error`;
  const ask = verb('asks', 'ask');
  const again = policy.retries === 1 ? `${ask} again once` : `${ask} again, up to ${policy.retries} more times`;
  return policy.retryBudget === undefined ? again : `${again}, as long as repeats stay under ${percent(policy.retryBudget)} of ${verb('its', 'their')} requests`;
}

/**
 * The calls a request can make on its way through the failing part, front to back: every call on
 * a path from users to it, and every call behind it (what it calls, directly or not). For a failed
 * cache, the paths go through the tiers that look things up in it. In a chain, that is the whole
 * chain: the client's call and each tier's downstream call.
 * ASSUMPTION: cache lookups are a side call, not a layer; they are left out (as in a chain).
 */
function pathCalls(config: RunConfig, faultTier: string): CallEdge[] {
  const fault = config.tiers.find((t) => t.id === faultTier);
  const anchors = fault?.cache ? config.tiers.filter((t) => t.cacheAside?.target === faultTier).map((t) => t.id) : [faultTier];
  const keep = new Set<CallEdge>();
  const all = new Map<string, CallEdge>();
  const key = (e: CallEdge) => `${e.from}|${e.kind}|${e.index}`;
  const add = (e: CallEdge) => {
    if (e.kind === 'cacheAside') return;
    if (!all.has(key(e))) all.set(key(e), e);
    keep.add(all.get(key(e))!);
  };
  for (const anchor of anchors) {
    for (const path of pathsTo(config, anchor)) path.forEach(add);
    for (const id of [anchor, ...reachableFrom(config, anchor)]) callsFrom(config, id).forEach(add);
  }
  const order = ['client', ...topologicalOrder(config)];
  return [...keep].sort((a, b) => order.indexOf(a.from) - order.indexOf(b.from) || a.index - b.index);
}

/**
 * Who asks again around this failure, one layer per caller, front to back: callers whose calls on
 * the paths through the failing part (see pathCalls) retry and sent at least one retry from the
 * failure's start to the end of the judged range (review 2: "everyone asks again" in runs where
 * nobody did). A layer's policy is its call with the most retries.
 *
 * A call in front of a message queue that sits between it and the failing part is left out: the
 * queue answered it as soon as it stored the message, so it never saw the failure (review 2: queue
 * stories listed users' apps and the load balancer as retrying when they couldn't). With
 * branches, a call is left out only if every path from it to the failing part passes a queue.
 */
function askingAgain(ctx: Context, faultTier: string): Array<{ id: string; policy: CallPolicy }> {
  const from = Math.floor(Math.min(...(ctx.config.faults ?? []).map((f) => f.startMs)) / ctx.bucketMs);
  const to = Math.floor(ctx.analysis.recovery.judgedUntilMs / ctx.bucketMs);
  const retriesSent = (c: CallEdge) => sumRange(ctx.run.tiers[c.policy.target].arrivalsRetry, from, to);
  const behindQueue = queueShielded(ctx.config, faultTier);
  const layers: Array<{ id: string; policy: CallPolicy }> = [];
  for (const c of pathCalls(ctx.config, faultTier)) {
    if (c.policy.retries === 0 || retriesSent(c) === 0 || behindQueue(c)) continue;
    const layer = layers.find((l) => l.id === c.from);
    if (!layer) layers.push({ id: c.from, policy: c.policy });
    else if (c.policy.retries > layer.policy.retries) layer.policy = c.policy;
  }
  return layers;
}

/**
 * Whether a message queue shields a call from the failing part: on every path from the call to
 * it, a queue tier sits after the call and before the failing part (the queue's own consumer call
 * is not shielded). Calls not on any path to it are not shielded.
 */
function queueShielded(config: RunConfig, faultTier: string): (c: CallEdge) => boolean {
  const paths = pathsTo(config, faultTier);
  const same = (a: CallEdge, b: CallEdge) => a.from === b.from && a.kind === b.kind && a.index === b.index;
  return (c) => {
    let onPath = false;
    for (const path of paths) {
      const j = path.findIndex((e) => same(e, c));
      if (j < 0) continue;
      onPath = true;
      const between = path.slice(j, -1).map((e) => e.policy.target);
      if (!between.some((id) => tierOf(config, id).queue !== undefined)) return false;
    }
    return onPath;
  };
}

/** How many layers make calls on the paths through the failing part (see pathCalls). */
function layerCount(config: RunConfig, faultTier: string): number {
  return new Set(pathCalls(config, faultTier).map((c) => c.from)).size;
}

/**
 * Who asks again, when that is more than what the caller that noticed does (or '' if not): with
 * several layers, how their repeats multiply ("Every layer asks again when it gives up: users'
 * apps up to 5 times, the gateway 3 times, the API once. One slow answer can come back as many
 * requests."); with one layer in front of the noticing caller, that layer ("Users' apps ask
 * again when they give up, up to 5 times."). Only layers that retry are listed; a retry budget gets a
 * sentence of its own.
 */
function cascadeText(f: Fault, callerId: string, ctx: Context): string {
  const calls = askingAgain(ctx, f.tier);
  // One retrying layer matters here only if it is in front of the caller that noticed (its
  // repeats come back to that caller); behind it, it has nothing to do with this failure.
  if (calls.length === 0 || (calls.length === 1 && !callersInFront(ctx.config, callerId).includes(calls[0].id))) return '';
  const budgets = calls
    .filter((c) => c.policy.retryBudget !== undefined)
    .map(({ id, policy }) => {
      const { name, verb } = callerWords(id, ctx);
      return ` ${capitalise(name)} ${verb('stops', 'stop')} asking again once repeats reach ${percent(policy.retryBudget!)} of ${verb('its', 'their')} requests.`;
    })
    .join('');
  if (calls.length === 1) {
    const { name, verb } = callerWords(calls[0].id, ctx);
    const n = calls[0].policy.retries;
    return ` ${capitalise(name)} ${verb('asks', 'ask')} again when ${verb('it gives', 'they give')} up, ${n === 1 ? 'once' : `up to ${n} times`}.${budgets}`;
  }
  const every = calls.length === layerCount(ctx.config, f.tier);
  const list = calls.map(({ id, policy }, i) => `${callerWords(id, ctx).name} ${i === 0 && policy.retries > 1 ? 'up to ' : ''}${times(policy.retries)}`);
  const answer = f.kind === 'dead' && !tierOf(ctx.config, f.tier).cache ? 'failed' : 'slow';
  return ` ${every ? 'Every layer asks again when it gives' : 'Several layers ask again when they give'} up: ${list.join(', ')}.${budgets} One ${answer} answer can come back as many requests.`;
}

/**
 * Why the failure matters to the caller: it gives up waiting (a slowdown) or gets an error at
 * once (an outage), and asks again or passes the error on. For a failed cache: lookups go to the
 * tier behind it instead. When other layers ask again too, who does follows (see cascadeText),
 * since repeats multiply from layer to layer. Null when the caller never noticed (answers stayed
 * within its patience).
 */
function causeStep(f: Fault, ctx: Context): StoryStep | null {
  const firstSlow = (policy: CallPolicy): number | null => {
    if (policy.timeoutMs === null) return null;
    const t = ctx.run.tiers[f.tier];
    const from = Math.floor(f.startMs / ctx.bucketMs);
    const to = Math.min(Math.ceil(f.endMs / ctx.bucketMs), Math.floor(ctx.analysis.recovery.judgedUntilMs / ctx.bucketMs));
    for (let s = from; s < to; s++) if (t.latencyP99Ms[s] > policy.timeoutMs) return s * ctx.bucketMs;
    return null;
  };
  const edge = noticingCaller(f, ctx, firstSlow);
  if (edge === null) return null;
  const call = { id: edge.from, policy: edge.policy };
  const { name: caller, verb } = callerWords(call.id, ctx);
  const target = noun(ctx.say(f.tier));
  // A load balancer splitting its traffic sends the failed part only some of it: say how much.
  const fraction = callFraction(ctx.config, edge);
  const share = fraction < 1 ? ` ${capitalise(caller)} ${verb('sends', 'send')} ${percent(fraction)} of ${verb('its', 'their')} requests to ${ctx.say(f.tier)}.` : '';
  const others = cascadeText(f, call.id, ctx);
  const cascade = share + others;
  const asking = askingAgain(ctx, f.tier);
  const layers = others === '' ? undefined : asking.map(({ id, policy }) => ({ who: shortCaller(id, ctx), retries: policy.retries }));
  const everyone = asking.length === layerCount(ctx.config, f.tier);
  const headline = `${capitalise(shortCaller(call.id, ctx))} ${verb('gives', 'give')} up`;
  const figure = call.policy.timeoutMs === null ? undefined : formatMs(call.policy.timeoutMs);
  const step = (tMs: number | null, text: string, head = headline, fig = figure): StoryStep | null =>
    tMs === null ? null : { tMs, text: text + cascade, tone: 'info', kind: 'giveup', headline: layers ? `${head}, ${everyone ? 'everyone asks' : 'others ask'} again` : head, figure: fig, ...(layers ? { cascade: layers } : {}) };

  const callerTier = call.id === 'client' ? null : tierOf(ctx.config, call.id);
  if (tierOf(ctx.config, f.tier).cache && edge.kind === 'cacheAside' && callerTier?.downstream) {
    // What a miss reads from: one part, or all of a fan-out ("the database and the search
    // service"), or one of a split ("the database or the search service").
    const targets = callsOf(callerTier).map((c) => c.target);
    const or = callerTier.fanOut === 'split' && targets.length > 1 ? 'or' : 'and';
    const behind = listed(targets.map(ctx.say), or);
    const toBehind = `Lookups go to ${listed(targets.map((id) => noun(ctx.say(id))), or)}`;
    if (f.kind === 'dead') return step(f.startMs, `Without ${ctx.say(f.tier)}, ${caller} sent every lookup to ${behind} instead.`, toBehind, undefined);
    return step(firstSlow(call.policy), `${capitalise(caller)} gives up on ${ctx.say(f.tier)} after ${formatMs(call.policy.timeoutMs!)} and asks ${behind} instead.`, toBehind);
  }

  // When other layers ask again, the cascade says what each one does.
  const again = others === '' ? ` and ${askAgain(call.policy, call.id, ctx)}` : '';
  if (f.kind === 'dead') {
    const from = f.instance === undefined ? `from ${ctx.say(f.tier)}` : 'for requests sent to that instance';
    return step(f.startMs, `${capitalise(caller)} ${verb('gets', 'get')} an error ${from} straight away${again}.`, `${capitalise(shortCaller(call.id, ctx))} ${verb('gets', 'get')} errors`, undefined);
  }
  const article = /^[aeiou]/i.test(target) ? 'an' : 'a';
  return step(firstSlow(call.policy), `${capitalise(caller)} ${verb('gives', 'give')} up on ${article} ${target} answer after ${formatMs(call.policy.timeoutMs!)}${again}.`);
}

/**
 * Which caller of the failed part the story follows. In a chain there is one. With several (two
 * tiers calling the same database): for an outage, the first (users' apps, else the first tier in
 * the config), since every caller gets errors at once; for a slowdown, the one that gave up first
 * (the first answer over its timeout; the first caller on a tie). Null when no caller gave up.
 */
function noticingCaller(f: Fault, ctx: Context, firstSlow: (policy: CallPolicy) => number | null): CallEdge | null {
  const callers = callersOf(ctx.config, f.tier);
  if (callers.length <= 1 || f.kind === 'dead') return callers[0] ?? null;
  let best: { edge: CallEdge; at: number } | null = null;
  for (const edge of callers) {
    const at = firstSlow(edge.policy);
    if (at !== null && (best === null || at < best.at)) best = { edge, at };
  }
  return best?.edge ?? null;
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
function overloadStep(id: string, main: Fault, ctx: Context, retries: boolean): StoryStep | null {
  const tier = tierOf(ctx.config, id);
  const capacity = leafCapacityRps(tier)!;
  const t = ctx.run.tiers[id];
  const load = (s: number) => (admittedIn(t, s) * 1000) / ctx.bucketMs;
  const from = Math.floor(main.startMs / ctx.bucketMs);
  const to = Math.floor(ctx.analysis.recovery.judgedUntilMs / ctx.bucketMs);
  const name = ctx.say(id);
  // While the whole tier is down it refuses everything at once, so its load says nothing.
  const down = (s: number) => (ctx.config.faults ?? []).some((f) => f.tier === id && f.kind === 'dead' && f.instance === undefined && f.startMs < (s + 1) * ctx.bucketMs && f.endMs > s * ctx.bucketMs);
  const failureEndS = Math.ceil(ctx.analysis.recovery.lastFaultEndMs / ctx.bucketMs);
  // A failed tier in front of this one (the Gateway, say) held a pile while it was slow or down.
  const passedOn = main.tier !== id && !tierOf(ctx.config, main.tier).cache && queueAtEnd(ctx, main.tier, main.endMs) >= 1;
  for (let s = from; s < to; s++) {
    if (load(s) > capacity && !down(s)) {
      const full = `even at full speed (${about(capacity)} a second)`;
      const text = s < failureEndS
        ? `So ${name} got more requests than it can handle, ${full}.`
        : passedOn
          ? `Then ${ctx.say(main.tier)} passed its pile of requests on all at once, more than ${name} can handle (${about(capacity)} a second).`
          : retries
            ? `Then the requests asked again pushed ${name} past what it can handle, ${full}.`
            : `Then ${name} got more requests than it can handle, ${full}.`;
      return { tMs: s * ctx.bucketMs, text, tone: 'bad', kind: 'overload', headline: `${capitalise(noun(name))} overloaded`, meter: load(s) / capacity, figure: `${(load(s) / capacity).toFixed(1)}×` };
    }
  }

  const left = main.tier === id ? speedLeft(main, tier) : 0;
  if (left === 0) return null; // nothing to compare with: it refused everything
  const reduced = capacity * left;
  const how = main.instance === undefined || tier.instances === 1 ? 'Slowed down' : main.kind === 'slow' ? 'With one instance slowed' : 'With one instance down';
  const end = Math.min(Math.ceil(main.endMs / ctx.bucketMs), to);
  for (let s = from; s < end; s++) {
    if (load(s) > reduced) {
      return {
        tMs: s * ctx.bucketMs,
        text: `${how}, ${name} could serve only ${about(reduced)} requests a second, but it got ${Math.round(load(s))}.`,
        tone: 'bad',
        kind: 'overload',
        headline: `${capitalise(noun(name))} swamped`,
        meter: load(s) / reduced,
        figure: `${(load(s) / reduced).toFixed(1)}×`,
      };
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
  const behind = behindCache(ctx.config, drop.tier);
  if (behind.length === 0) return null;
  const t = ctx.run.tiers[drop.tier];
  const from = Math.floor(faults[0].startMs / ctx.bucketMs);
  const to = Math.floor(ctx.analysis.recovery.judgedUntilMs / ctx.bucketMs);
  for (let s = from; s < to; s++) {
    const rate = t.hits[s] / Math.max(1, t.arrivalsFirst[s] + t.arrivalsRetry[s]);
    if (rate < drop.value.before / 2) {
      const text = `${capitalise(noun(ctx.say(drop.tier)))} entries ran out and weren't refilled, sending even more requests to ${listed(behind.map(ctx.say))}.`;
      return { tMs: s * ctx.bucketMs, text, tone: 'bad', kind: 'cache', headline: `${capitalise(noun(ctx.say(drop.tier)))} emptied`, figure: `${percent(rate)} hits` };
    }
  }
  return null;
}

function notInRunStep(config: RunConfig, run: RunResult): StoryStep {
  const starts = (config.faults ?? []).map((f) => f.startMs);
  if (starts.length === 0) return { tMs: 0, text: 'Nothing is set to fail in this run.', tone: 'info', kind: 'info', headline: 'No failure set' };
  return {
    tMs: 0,
    text: `The failure is set to start at ${formatSeconds(Math.min(...starts))}, but this run ends at ${formatSeconds(run.durationMs)}, so it never happens.`,
    tone: 'info',
    kind: 'info',
    headline: 'Failure never happens',
  };
}

/** How it ended, at the moment that became known. */
function verdictStep(ctx: Context, pressure: string | null, hadPile: boolean): StoryStep {
  const r = ctx.analysis.recovery;
  switch (r.verdict) {
    case 'recovered': {
      const text = r.recoveryMs === 0
        ? 'It was back to normal as soon as the failure ended.'
        : `${hadPile ? 'It worked through the backlog and was' : 'It was'} back to normal ${formatSeconds(r.recoveryMs!)} after the failure ended.`;
      return { tMs: r.recoveredAtMs!, text, tone: 'good', kind: 'recovered', headline: 'Back to normal', figure: r.recoveryMs === 0 ? 'at once' : `in ${formatSeconds(r.recoveryMs!)}` };
    }
    case 'unaffected':
      return { tMs: Math.min(r.lastFaultEndMs, ctx.run.durationMs), text: 'It coped: requests did just as well as they would have without the failure.', tone: 'good', kind: 'recovered', headline: 'Coped fine' };
    case 'overloaded': {
      // Behind a queue, too much traffic fails no request: the work just falls further behind.
      // Chosen by why the no-failure run is overloaded, not by this run's failures (review 2: "so
      // requests fail anyway" while the no-failure run failed nothing).
      const behind = ctx.analysis.signals.queueBacklog ?? null;
      const text =
        r.overloadedBy === 'queue'
          ? `Even without the failure, this much traffic is more than the system can handle: work piles up${behind ? ` in ${ctx.say(behind.tier)}` : ''} faster than it gets done.`
          : 'Even without the failure, this much traffic is more than the system can handle, so requests fail anyway.';
      return { tMs: 0, text, tone: 'bad', kind: 'stuck', headline: 'Too much traffic anyway' };
    }
    case 'stuck': {
      if (r.lastFaultEndMs >= r.judgedUntilMs) {
        return { tMs: r.judgedUntilMs, text: 'The failure was still going on when the run ended, so there was no time to recover.', tone: 'bad', kind: 'stuck', headline: 'Still failing at the end' };
      }
      if (r.catchingUpMs !== undefined) {
        // Draining steadily when even the longest run ended (see settle.ts): not stuck for good.
        const more = formatSeconds(r.catchingUpMs);
        return { tMs: r.judgedUntilMs, text: `It was still catching up when the run ended: working through the backlog steadily, about ${more} more to go.`, tone: 'bad', kind: 'stuck', headline: 'Still catching up', figure: `~${more} more` };
      }
      const peak = pressure === null ? 0 : peakLoad(ctx, pressure, r.lastFaultEndMs);
      const backlog = ctx.analysis.signals.queueBacklog;
      if (backlog && backlog.value.atEnd >= 1 && (r.failedRequests === 0 || peak <= 1)) {
        // Users were answered all along; what never recovered is the work behind the queue.
        const left = Math.round(backlog.value.atEnd).toLocaleString('en-US');
        return { tMs: r.judgedUntilMs, text: `It never caught up: ${left} messages were still waiting in ${ctx.say(backlog.tier)} at the end of the run.`, tone: 'bad', kind: 'stuck', headline: 'Never caught up', figure: `${left} waiting` };
      }
      return {
        tMs: r.judgedUntilMs,
        text: `It never recovered: still failing at the end of the run${peakAfter(ctx, pressure)}.`,
        tone: 'bad',
        kind: 'stuck',
        headline: 'Still stuck',
        ...(peak > 1 ? { meter: peak, figure: `${peak.toFixed(1)}× peak` } : {}),
      };
    }
  }
}

/** ", with the database getting up to 4.8× the work it can handle", measured after the failure ended; '' if never over. */
function peakAfter(ctx: Context, id: string | null): string {
  if (id === null) return '';
  const peak = peakLoad(ctx, id, ctx.analysis.recovery.lastFaultEndMs);
  return peak > 1 ? `, with ${ctx.say(id)} getting up to ${peak.toFixed(1)}× the work it can handle` : '';
}

/** "Database", "API", "One of 4 API servers": the failed part, for a headline. */
function partName(f: Fault, ctx: Context): string {
  const instances = tierOf(ctx.config, f.tier).instances;
  const name = capitalise(noun(ctx.say(f.tier)));
  return f.instance === undefined || instances === 1 ? name : `1 of ${instances} ${name} servers`;
}

/** A caller in a headline: "users' apps" for the client, else "the API". */
function shortCaller(id: string, ctx: Context): string {
  return id === 'client' ? "users' apps" : ctx.say(id);
}

/** Wasted share as a figure; "almost all" above 95% (see wasteText). */
function wasteFigure(share: number): string {
  return share >= 0.95 ? '~100%' : percent(share);
}

