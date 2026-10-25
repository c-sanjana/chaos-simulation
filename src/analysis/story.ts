import { callsOf, type CallPolicy, type Fault, type RunConfig, type TierConfig } from '../engine/config';
import type { RunResult } from '../engine/result';
import type { Analysis } from './analyze';
import {
  admittedIn,
  callersInFront,
  callersOf,
  callFraction,
  callsFrom,
  callsLeadingTo,
  capitalise,
  doesWork,
  failureReaches,
  incidentWindow,
  formatMs,
  formatSeconds,
  leafCapacityRps,
  listed,
  overByRepeats,
  peakLoad as peakLoadIn,
  percent,
  reachableFrom,
  spokenName,
  sentAlong,
  strugglingPart,
  sumRange,
  tierOf,
  tiersLeadingTo,
  times,
  topologicalOrder,
  wholeTierDown,
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
  /** Each retrying caller's retries, front to back, e.g. users' apps 5, load balancer 3, API 1. */
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
 * Words are chosen for newcomers: "gives up on an answer after 1 s" rather than "timeout", "more
 * requests than it can handle" rather than "over capacity"; "retries" (user decision, 2026-10-25).
 */
export function buildStory(run: RunResult, config: RunConfig, analysis: Analysis, labels: Record<string, string>): StoryStep[] {
  const r = analysis.recovery;
  const say = (id: string) => spokenName(id, labels);
  const faults = (config.faults ?? []).filter((f) => f.startMs < run.durationMs).sort((a, b) => a.startMs - b.startMs);
  if (faults.length === 0) return [notInRunStep(config, run), { tMs: 0, text: 'Nothing went wrong.', tone: 'good', kind: 'recovered', headline: 'Nothing went wrong' }];

  const ctx: Context = { run, config, analysis, say, bucketMs: run.bucketMs };
  const main = faults[0];
  const pressure = pressureTier(ctx, main);
  // Any layer retrying makes the pile one of repeated requests: retries further up arrive
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

const noun = (spoken: string) => spoken.replace(/^the /, '');
/** Whether a name ends in a number ("Database 2"). */
const numbered = (name: string) => /\s\d+$/.test(name);
/** "about 160", "about 20": round to two significant figures, which is all a newcomer needs. */
const about = (x: number) => `about ${x >= 100 ? Math.round(x / 10) * 10 : Math.round(x)}`;

/**
 * The tier whose load explains the trouble: the part that struggled (see strugglingPart, the rule
 * the fix explanations, the fixes and the load chart share), and when no part went over what it can
 * handle, the failed tier if it does the work itself (the story can then still tell that, slowed
 * down, it could not keep up), or, when a cache failed, the tier it protects (with several, the one
 * that got the most work for what it can handle). Null otherwise.
 *
 * The part that struggled need not be the failed one. Repeats sent because of the failed part go
 * back through whatever their senders call: a load balancer splits them afresh over the other
 * pools, and a server that calls a database before the failed part sends every repeat to that
 * database first (measured: Database 2 slowing overloaded Database, which the app server calls
 * first, while Database 2 itself then got nothing).
 */
function pressureTier(ctx: Context, fault: Fault): string | null {
  const { config, run } = ctx;
  const struggling = strugglingPart(config, run, incidentWindow(config, ctx.analysis.recovery));
  if (struggling) return struggling.id;
  const tier = tierOf(config, fault.tier);
  if (tier.cache) {
    const behind = behindCache(config, fault.tier).filter((id) => doesWork(tierOf(config, id)));
    if (behind.length <= 1) return behind[0] ?? null;
    return behind.map((id) => ({ id, peak: peakLoad(ctx, id, fault.startMs) })).sort((a, b) => b.peak - a.peak)[0].id;
  }
  return doesWork(tier) ? fault.tier : null;
}

/** The tiers a miss in `cacheId` is read from: every downstream call of every tier that looks things up in it. */
function behindCache(config: RunConfig, cacheId: string): string[] {
  const users = config.tiers.filter((t) => t.cacheAside?.target === cacheId);
  return [...new Set(users.flatMap((t) => callsOf(t).map((c) => c.target)))];
}

/**
 * Highest load on a tier that calls nothing, as a multiple of what it can handle, from the second
 * `fromMs` falls in to the end of the judged range (see helpers' peakLoad).
 */
function peakLoad(ctx: Context, id: string, fromMs: number): number {
  return peakLoadIn(ctx.config, ctx.run, id, Math.floor(fromMs / ctx.bucketMs), Math.floor(ctx.analysis.recovery.judgedUntilMs / ctx.bucketMs));
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
    // Behind a queue the pile is of messages, whatever retried in front of it; but only a queue
    // still backed up when judging ended is what stayed stuck (review 3: a queue that drained
    // soon after was blamed while a database on another branch kept the run stuck).
    const backlog = ctx.analysis.signals.queueBacklog;
    const stillBacked = backlog && backlog.value.atEnd >= 1 ? backlog.tier : null;
    const queue = ctx.config.tiers.find((t) => t.id === stillBacked && ctx.run.tiers[t.id].backlogAvg[Math.floor(f.endMs / ctx.bucketMs)] >= 1);
    if (queue) return ` — ${but} the pile of messages in ${ctx.say(queue.id)} was still there.`;
    return ` — ${but} the pile of ${retries > 0 ? 'retried' : 'waiting'} requests was still there.`;
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

/** What a caller does after giving up: "retries up to 3 times". */
function askAgain(policy: CallPolicy, callerId: string, ctx: Context): string {
  const { verb } = callerWords(callerId, ctx);
  if (policy.retries === 0) return `${verb('does', 'do')} not retry, so those users ${callerId === 'client' ? 'saw' : 'got'} an error`;
  const ask = verb('retries', 'retry');
  const again = policy.retries === 1 ? `${ask} once` : `${ask} up to ${policy.retries} times`;
  return policy.retryBudget === undefined ? again : `${again}, as long as retries stay under ${percent(policy.retryBudget)} of ${verb('its', 'their')} requests`;
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
    callsLeadingTo(config, anchor).forEach(add);
    for (const id of [anchor, ...reachableFrom(config, anchor)]) callsFrom(config, id).forEach(add);
  }
  const order = ['client', ...topologicalOrder(config)];
  return [...keep].sort((a, b) => order.indexOf(a.from) - order.indexOf(b.from) || a.index - b.index);
}

/**
 * Who retries around this failure, one layer per caller, front to back: callers whose calls on
 * the paths through the failing part (see pathCalls) retry and sent at least one retry from the
 * failure's start to the end of the judged range (review 2: "everyone retries" in runs where
 * nobody did), counted for that call itself (see helpers' sentAlong; review 3, F7: with fan-in, a
 * caller that never retried was listed because another caller of the same part did). A layer's
 * policy is its call with the most retries.
 *
 * A call in front of a message queue that sits between it and the failing part is left out: the
 * queue answered it as soon as it stored the message, so it never saw the failure (review 2: queue
 * stories listed users' apps and the load balancer as retrying when they couldn't). With
 * branches, a call is left out only if every path from it to the failing part passes a queue.
 */
function askingAgain(ctx: Context, faultTier: string): Array<{ id: string; policy: CallPolicy }> {
  const from = Math.floor(Math.min(...(ctx.config.faults ?? []).map((f) => f.startMs)) / ctx.bucketMs);
  const to = Math.floor(ctx.analysis.recovery.judgedUntilMs / ctx.bucketMs);
  const retriesSent = (c: CallEdge) => sumRange(sentAlong(ctx.config, ctx.run, c, 'retries'), from, to);
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
 * Whether a message queue shields a call from the failing part: on every way from the call to it,
 * a queue tier sits after the call and before the failing part (the queue's own consumer call is
 * not shielded). Calls not on any way to it are not shielded. One pass over the tiers, without
 * listing the ways (see helpers' tiersLeadingTo).
 */
function queueShielded(config: RunConfig, faultTier: string): (c: CallEdge) => boolean {
  const key = (e: CallEdge) => `${e.from}|${e.kind}|${e.index}`;
  const onWay = new Set(callsLeadingTo(config, faultTier).map(key));
  // Where the failing part can be reached from without passing a queue (itself included).
  const open = tiersLeadingTo(config, faultTier, (id) => tierOf(config, id).queue === undefined);
  return (c) => onWay.has(key(c)) && !open.has(c.policy.target);
}

/**
 * Retrying layers grouped where they are alternatives: pools one load balancer splits over (a
 * request goes through one of them, not all), front to back. Every other layer is a group of its
 * own (review 3: siblings read as seven multiplying layers).
 */
function alternatives<T extends { id: string }>(config: RunConfig, layers: T[]): T[][] {
  const splitter = (id: string) => config.tiers.find((t) => t.fanOut === 'split' && callsOf(t).length > 1 && callsOf(t).some((c) => c.target === id))?.id;
  const groups: T[][] = [];
  for (const l of layers) {
    const parent = splitter(l.id);
    const group = parent === undefined ? undefined : groups.find((g) => splitter(g[0].id) === parent);
    if (group) group.push(l);
    else groups.push([l]);
  }
  return groups;
}

/** How many layers make calls on the paths through the failing part (see pathCalls). */
function layerCount(config: RunConfig, faultTier: string): number {
  return new Set(pathCalls(config, faultTier).map((c) => c.from)).size;
}

/**
 * Who retries, when that is more than what the caller that noticed does (or '' if not): with
 * several layers, how their repeats multiply ("Every layer retries when it gives up: users'
 * apps up to 5 times, the load balancer 3 times, the API once. One slow answer can come back as many
 * requests."); with one layer in front of the noticing caller, that layer ("Users' apps retry
 * when they give up, up to 5 times."). Only layers that retry are listed; a retry budget gets a
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
      return ` ${capitalise(name)} ${verb('stops', 'stop')} retrying once retries reach ${percent(policy.retryBudget!)} of ${verb('its', 'their')} requests.`;
    })
    .join('');
  if (calls.length === 1) {
    const { name, verb } = callerWords(calls[0].id, ctx);
    const n = calls[0].policy.retries;
    return ` ${capitalise(name)} ${verb('retries', 'retry')} when ${verb('it gives', 'they give')} up, ${n === 1 ? 'once' : `up to ${n} times`}.${budgets}`;
  }
  const every = calls.length === layerCount(ctx.config, f.tier);
  const list = alternatives(ctx.config, calls).map((group, i) => {
    const each = group.map(({ id, policy }) => `${callerWords(id, ctx).name} ${i === 0 && policy.retries > 1 ? 'up to ' : ''}${times(policy.retries)}`);
    // Pools a load balancer splits over are alternatives, not stacked layers: "the app server or App server 2 once".
    const same = group.every((l) => l.policy.retries === group[0].policy.retries);
    return same && group.length > 1 ? `${listed(group.map(({ id }) => callerWords(id, ctx).name), 'or')} ${i === 0 && group[0].policy.retries > 1 ? 'up to ' : ''}${times(group[0].policy.retries)}` : listed(each, 'or');
  });
  const answer = f.kind === 'dead' && !tierOf(ctx.config, f.tier).cache ? 'failed' : 'slow';
  return ` ${every ? 'Every layer retries when it gives' : 'Several layers retry when they give'} up: ${list.join(', ')}.${budgets} One ${answer} answer can come back as many requests.`;
}

/**
 * Why the failure matters to the caller: it gives up waiting (a slowdown) or gets an error at
 * once (an outage), and retries or passes the error on. For a failed cache: lookups go to the
 * tier behind it instead. When other layers retry too, who does follows (see cascadeText),
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
  const layers = others === '' ? undefined : alternatives(ctx.config, asking).map((group) => ({ who: listed(group.map(({ id }) => shortCaller(id, ctx)), 'or'), retries: Math.max(...group.map((l) => l.policy.retries)) }));
  const everyone = asking.length === layerCount(ctx.config, f.tier);
  const headline = `${capitalise(shortCaller(call.id, ctx))} ${verb('gives', 'give')} up`;
  const figure = call.policy.timeoutMs === null ? undefined : formatMs(call.policy.timeoutMs);
  // `fig` null: no figure. (An outage or a cache going down is noticed at once, not after a
  // timeout; review 3: passing undefined fell back to the timeout.)
  const step = (tMs: number | null, text: string, head = headline, fig: string | null = figure ?? null): StoryStep | null =>
    tMs === null ? null : { tMs, text: text + cascade, tone: 'info', kind: 'giveup', headline: layers ? `${head}, ${everyone ? 'everyone retries' : 'others retry'}` : head, figure: fig ?? undefined, ...(layers ? { cascade: layers } : {}) };

  const callerTier = call.id === 'client' ? null : tierOf(ctx.config, call.id);
  if (tierOf(ctx.config, f.tier).cache && edge.kind === 'cacheAside' && callerTier?.downstream) {
    // What a miss reads from: one part, or all of a fan-out ("the database and the search
    // service"), or one of a split ("the database or the search service").
    const targets = callsOf(callerTier).map((c) => c.target);
    const or = callerTier.fanOut === 'split' && targets.length > 1 ? 'or' : 'and';
    const behind = listed(targets.map(ctx.say), or);
    const toBehind = `Lookups go to ${listed(targets.map((id) => noun(ctx.say(id))), or)}`;
    // Every part that looks things up in it does the same (review 3: a second app server sharing
    // the cache was left out); with several, the parts behind any of them.
    const users = ctx.config.tiers.filter((t) => t.cacheAside?.target === f.tier);
    if (f.kind === 'dead' && users.length > 1) {
      const all = behindCache(ctx.config, f.tier);
      const text = `Without ${ctx.say(f.tier)}, ${listed(users.map((t) => ctx.say(t.id)))} sent every lookup to ${listed(all.map(ctx.say))} instead.`;
      return step(f.startMs, text, `Lookups go to ${listed(all.map((id) => noun(ctx.say(id))))}`, null);
    }
    if (f.kind === 'dead') return step(f.startMs, `Without ${ctx.say(f.tier)}, ${caller} sent every lookup to ${behind} instead.`, toBehind, null);
    return step(firstSlow(call.policy), `${capitalise(caller)} gives up on ${ctx.say(f.tier)} after ${formatMs(call.policy.timeoutMs!)} and asks ${behind} instead.`, toBehind);
  }

  // When other layers retry, the cascade says what each one does.
  const again = others === '' ? ` and ${askAgain(call.policy, call.id, ctx)}` : '';
  if (f.kind === 'dead') {
    const from = f.instance === undefined ? `from ${ctx.say(f.tier)}` : 'for requests sent to that instance';
    return step(f.startMs, `${capitalise(caller)} ${verb('gets', 'get')} an error ${from} straight away${again}.`, `${capitalise(shortCaller(call.id, ctx))} ${verb('gets', 'get')} errors`, null);
  }
  const article = /^[aeiou]/i.test(target) ? 'an' : 'a';
  // A numbered name reads badly as an adjective ("a database 2 answer"): "an answer from Database 2".
  const answer = numbered(target) ? `an answer from ${target}` : `${article} ${target} answer`;
  return step(firstSlow(call.policy), `${capitalise(caller)} ${verb('gives', 'give')} up on ${answer} after ${formatMs(call.policy.timeoutMs!)}${again}.`);
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
 * even at full speed (the retried requests, or a cache that stopped helping, did that); failing
 * that, more than it could handle while the failure slowed it (or took an instance down).
 */
function overloadStep(id: string, main: Fault, ctx: Context, retries: boolean): StoryStep | null {
  const tier = tierOf(ctx.config, id);
  const capacity = leafCapacityRps(tier)!;
  const t = ctx.run.tiers[id];
  const load = (s: number) => (admittedIn(t, s) * 1000) / ctx.bucketMs;
  const r = ctx.analysis.recovery;
  const from = Math.floor(main.startMs / ctx.bucketMs);
  // Nothing after the run was back to normal: an overload told after "back to normal" never
  // happened as far as users could tell (review 3: a busy part's noise was told last).
  const to = Math.floor((r.verdict === 'recovered' ? Math.min(r.recoveredAtMs!, r.judgedUntilMs) : r.judgedUntilMs) / ctx.bucketMs);
  const name = ctx.say(id);
  // While the whole tier is down it refuses everything at once, so its load says nothing.
  const down = (s: number) => wholeTierDown(ctx.config, ctx.run, id, s);
  // A part the failure does not reach directly got more work only through repeats: it counts as
  // overloaded only in a second when they pushed it over (see helpers' overByRepeats), and then
  // the repeats did land on it.
  const viaRepeats = !failureReaches(ctx.config, id);
  const failureEndS = Math.ceil(ctx.analysis.recovery.lastFaultEndMs / ctx.bucketMs);
  // A failed tier in front of this one (the load balancer, say) held a pile while it was slow or down.
  const passedOn = main.tier !== id && !tierOf(ctx.config, main.tier).cache && reachableFrom(ctx.config, main.tier).includes(id) && queueAtEnd(ctx, main.tier, main.endMs) >= 1;
  for (let s = from; s < to; s++) {
    if (load(s) > capacity && !down(s) && (!viaRepeats || overByRepeats(ctx.config, ctx.run, id, s))) {
      const full = `even at full speed (${about(capacity)} a second)`;
      // Another part than the failed one: say how the trouble reached it.
      const landed = viaRepeats ? ` Retries land on it too, not only on ${ctx.say(main.tier)}.` : '';
      const text = s < failureEndS
        ? `So ${name} got more requests than it can handle, ${full}.${landed}`
        : passedOn
          ? `Then ${ctx.say(main.tier)} passed its pile of requests on all at once, more than ${name} can handle (${about(capacity)} a second).`
          : retries
            ? `Then the retried requests pushed ${name} past what it can handle, ${full}.${landed}`
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
  return `${most} ${ctx.say(id)}'s work was for requests nobody was waiting for any more, so new ones were given up on${retries > 0 ? ' and retried' : ''} too.`;
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

