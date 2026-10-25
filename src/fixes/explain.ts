/**
 * Why a fix worked or didn't, in this run: one plain sentence computed from the two runs (without
 * and with the fix, at the viewer's settings), and which of the catalogue's pros and cons the run
 * contradicts. The catalogue says how a fix works in general; this says what it did here, so the
 * text never contradicts the measured result next to it (REVIEW2 1.5).
 *
 * Every number quoted is measured. "What it can handle" is a tier's capacity (leafCapacityRps);
 * its load is every request sent to it in a second, repeats included, less those its full queue
 * turned away at once (a bounded queue turns most of a flood away; counting those as work made the
 * fix look like it multiplied the load, REVIEW2 1.6). See analysis/helpers' peakLoad.
 */
import type { Analysis } from '../analysis/analyze';
import { capitalise, formatMs, incidentWindow, listed, peakLoad as peakLoadIn, spokenName, strugglingPart } from '../analysis/helpers';
import { callsOf, type CallPolicy, type RunConfig } from '../engine/config';
import type { RunResult } from '../engine/result';
import type { FixKind, Refutation } from './catalog';

/** A run with its no-failure control and analysis (the shape of the worker's AnalyzeResult). */
export interface MeasuredRun {
  run: RunResult;
  control: RunResult;
  analysis: Analysis;
}

export interface FixExplanation {
  /** "Why it worked" or "Why it didn't help here". */
  title: string;
  text: string;
  /** Claims this run contradicts (see Refutation in catalog.ts). */
  refuted: Refutation[];
}

const RETRY_KINDS: ReadonlySet<FixKind> = new Set(['retryBudget', 'retryBudgetEveryLayer', 'capRetries', 'jitterBackoff', 'retryOneLayer']);

/**
 * Explains one fix from the run without it (`before`) and with it (`after`), both at the same
 * settings. `helped` is the ranking's verdict (fixes/rank.ts), so the title always agrees with the
 * tab's mark.
 */
export function explainFix(
  kind: FixKind,
  helped: boolean,
  before: { config: RunConfig; result: MeasuredRun },
  after: { config: RunConfig; result: MeasuredRun },
  labels: Record<string, string>,
): FixExplanation {
  const say = (id: string) => (id === 'client' ? "users' apps" : spokenName(id, labels));
  const pressure = pressureTier(before.config, before.result);
  const refuted = refutations(pressure, before, after);
  const text = helped ? workedText(kind, pressure, before, after, say) : notHelpedText(kind, pressure, before, after, say);
  return { title: helped ? 'Why it worked' : "Why it didn't help here", text, refuted };
}

// ---------- what was measured ----------

/** Seconds [from, to) of a run: from the end of the last failure to the end of what is judged. */
function afterFailure(r: MeasuredRun): [number, number] {
  const { lastFaultEndMs, judgedUntilMs } = r.analysis.recovery;
  const b = r.run.bucketMs;
  return [Math.ceil(lastFaultEndMs / b), Math.floor(judgedUntilMs / b)];
}

/** Seconds [from, to) of a run: from the first failure to the end of what is judged (the incident). */
function incident(config: RunConfig, r: MeasuredRun): [number, number] {
  const starts = (config.faults ?? []).map((f) => f.startMs);
  const b = r.run.bucketMs;
  return [Math.floor((starts.length ? Math.min(...starts) : 0) / b), Math.floor(r.analysis.recovery.judgedUntilMs / b)];
}

/** Requests per second sent to a tier in second s, repeats included. */
function rps(run: RunResult, id: string, s: number): number {
  const t = run.tiers[id];
  return ((t.arrivalsFirst[s] + t.arrivalsRetry[s]) * 1000) / run.bucketMs;
}

/** Most work a tier took on in a second over seconds [from, to), as a multiple of its capacity in `config`. */
function peakLoad(config: RunConfig, run: RunResult, id: string, [from, to]: [number, number]): number {
  return peakLoadIn(config, run, id, from, to);
}

/**
 * The part whose load explains the trouble, chosen in the run without the fix so both runs are
 * measured on the same part: the part that struggled (analysis/helpers' strugglingPart, the rule
 * the story, the fixes and the load chart share: highest average load after the failure ended,
 * else highest peak during it, only parts that do the work themselves). Null when none went over.
 */
function pressureTier(config: RunConfig, r: MeasuredRun): string | null {
  return strugglingPart(config, r.run, incidentWindow(config, r.analysis.recovery))?.id ?? null;
}

function sum(xs: number[], [from, to]: [number, number] = [0, xs.length]): number {
  let n = 0;
  for (let i = Math.max(0, from); i < Math.min(to, xs.length); i++) n += xs[i];
  return n;
}

/** Every retry any layer sent in the run. */
function retriesSent(run: RunResult): number {
  return Object.values(run.tiers).reduce((n, t) => n + sum(t.arrivalsRetry), 0);
}

/**
 * Every layer's calls (the client's call and every downstream call of each tier, in config order;
 * cache lookups left out). In a chain: the calls along the chain, front to back.
 */
function layerCalls(config: RunConfig): Array<{ owner: string; policy: CallPolicy }> {
  return [{ owner: 'client', policy: config.client.call }, ...config.tiers.flatMap((t) => callsOf(t).map((policy) => ({ owner: t.id, policy })))];
}

function refutations(pressure: string | null, before: { result: MeasuredRun }, after: { config: RunConfig; result: MeasuredRun }): Refutation[] {
  const out: Refutation[] = [];
  const failedAfter = after.result.analysis.recovery.failedRequests;
  if (failedAfter === 0) out.push('noFailures');
  if (failedAfter > before.result.analysis.recovery.failedRequests) out.push('failedMore');
  if (pressure !== null) {
    // Normal load: the average sent to that part in the no-failure control over the same seconds.
    const window = incident(after.config, after.result);
    const seconds = Math.max(1, window[1] - window[0]);
    let normal = 0;
    let peak = 0;
    for (let s = window[0]; s < window[1]; s++) {
      normal += rps(after.result.control, pressure, s) / seconds;
      peak = Math.max(peak, rps(after.result.run, pressure, s));
    }
    if (normal > 0 && peak > 2 * normal) out.push('loadOverDouble');
  }
  return out;
}

// ---------- the sentences ----------

/** A load as a multiple of capacity: "2.3×", "14×". */
const multiple = (x: number) => `${x >= 10 ? Math.round(x) : x.toFixed(1)}×`;
const count = (n: number) => {
  try {
    return Math.round(n).toLocaleString('en-US');
  } catch {
    return String(Math.round(n));
  }
};

/**
 * "Users' apps (5×) and the load balancer (3×) still retry", or null when no layer retries. A layer whose
 * calls retry different numbers of times shows the range ("the API (1–3×)"); one whose calls all
 * have a retry budget says so ("the API (1×, 10% budget)"), since its repeats are then capped.
 */
function stillRetrying(config: RunConfig, say: (id: string) => string): string | null {
  const layers = new Map<string, CallPolicy[]>();
  for (const c of layerCalls(config)) if (c.policy.retries > 0) layers.set(c.owner, [...(layers.get(c.owner) ?? []), c.policy]);
  if (layers.size === 0) return null;
  const owners = [...layers.keys()];
  const plural = owners.length > 1 || owners[0] === 'client';
  const retries = (calls: CallPolicy[]) => {
    const n = calls.map((c) => c.retries);
    const range = Math.min(...n) === Math.max(...n) ? `${n[0]}×` : `${Math.min(...n)}–${Math.max(...n)}×`;
    const budgets = calls.map((c) => c.retryBudget ?? Infinity);
    return Math.max(...budgets) < Infinity ? `${range}, ${Math.round(Math.max(...budgets) * 100)}% budget` : range;
  };
  return `${capitalise(listed(owners.map((owner) => `${say(owner)} (${retries(layers.get(owner)!)})`)))} still ${plural ? 'retry' : 'retries'}`;
}

function notHelpedText(kind: FixKind, pressure: string | null, before: { config: RunConfig; result: MeasuredRun }, after: { config: RunConfig; result: MeasuredRun }, say: (id: string) => string): string {
  const a = after.result.analysis.recovery;
  const b = before.result.analysis.recovery;
  if (a.verdict === 'overloaded') return 'With it, the system can’t carry this much traffic even without the failure.';
  if (a.verdict === 'recovered' || a.verdict === 'unaffected') {
    const t = (ms: number | null, v: string) => (v === 'unaffected' ? '0 s' : formatMs(ms ?? 0));
    const failed = `${count(a.failedRequests)} requests failed instead of ${count(b.failedRequests)}`;
    // ASSUMPTION: the ranking may refuse a recovery that fails more users (REVIEW2 1.4); say why.
    if (b.verdict === 'stuck' || b.verdict === 'overloaded') return `It gets back to normal (in ${t(a.recoveryMs, a.verdict)}) where the run without it stays stuck, but ${failed}, so it doesn't count as helping.`;
    // The original recovered too, and the fix was neither faster nor kinder to users.
    return `It recovers in ${t(a.recoveryMs, a.verdict)}, against ${t(b.recoveryMs, b.verdict)} without it, and ${failed}: no improvement.`;
  }
  const load = pressure === null ? 0 : peakLoad(after.config, after.result.run, pressure, afterFailure(after.result));
  const loadPart = pressure !== null && load > 1 ? `${say(pressure)} still had up to ${multiple(load)} the work it can handle after the failure ended` : null;
  const still = stillRetrying(after.config, say);
  const cause = still && loadPart ? `${still}, so ${loadPart}` : loadPart ? capitalise(loadPart) : still;
  const text = (main: string) => main + cacheEmptied(after.result, say);

  if (kind === 'jitterBackoff' && cause) return text(`Every repeat is still sent, only later: ${uncap(cause)}.`);
  if (kind === 'longerTimeout') {
    const changed = changedTimeout(before.config, after.config);
    // Compared only with a failure of the part that call waits for: another part's failure says nothing about this wait.
    const longest = Math.max(0, ...(after.config.faults ?? []).filter((f) => changed && f.tier === changed.target).map((f) => f.endMs - f.startMs));
    if (changed && changed.timeoutMs < longest) {
      return text(`The failure lasted ${formatMs(longest)}, longer than the new ${formatMs(changed.timeoutMs)} wait, so ${say(changed.owner)} still gave up and asked again${cause ? `. ${cause}` : ''}.`);
    }
  }
  if (kind === 'addInstances' && pressure !== null && grew(before.config, after.config) === pressure && loadPart) {
    return text(`Even with more servers, ${say(pressure)} had up to ${multiple(load)} the work it can now handle after the failure ended${still ? `: ${uncap(still)}` : ''}.`);
  }
  if (kind === 'moreConsumers') {
    const q = after.result.analysis.signals.queueBacklog;
    if (q && q.value.atEnd >= 1) return text(`${capitalise(count(q.value.atEnd))} messages were still waiting in ${say(q.tier)} at the end of the run${loadPart ? `, and ${loadPart}` : ''}.`);
  }
  if (cause) return text(`${cause}.`);
  return text(`It still hadn't returned to normal by the end of the run${a.failedRequests > 0 ? `, and ${count(a.failedRequests)} requests failed` : ''}.`);
}

/**
 * " The cache emptied too (hit rate 11%, normally 75%), so more requests went past it." when the
 * run with the fix shows the cache hit rate falling below half of normal (the timeline's rule).
 */
function cacheEmptied(r: MeasuredRun, say: (id: string) => string): string {
  const drop = r.analysis.signals.cacheHitDrop;
  if (!drop || !(drop.value.during < drop.value.before / 2)) return '';
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  return ` ${capitalise(say(drop.tier))} emptied too (hit rate ${pct(drop.value.during)}, normally ${pct(drop.value.before)}), so more requests went past it.`;
}

function workedText(kind: FixKind, pressure: string | null, before: { config: RunConfig; result: MeasuredRun }, after: { config: RunConfig; result: MeasuredRun }, say: (id: string) => string): string {
  const change = changeText(kind, pressure, before, after, say);
  if (pressure === null) return change ? `${change}.` : 'It got back to normal after the failure ended.';
  const now = peakLoad(after.config, after.result.run, pressure, afterFailure(after.result));
  const was = peakLoad(before.config, before.result.run, pressure, afterFailure(before.result));
  const load = `${say(pressure)} had at most ${multiple(now)} the work it can handle, against ${multiple(was)} without the fix`;
  const drained = now <= 1 ? ', so the pile left by the failure could drain' : '';
  return change ? `${change}, so after the failure ended ${load}${drained}.` : `After the failure ended, ${load}${drained}.`;
}

/** What the fix changed, measured: fewer repeats, requests turned away or skipped, fewer reads. */
function changeText(kind: FixKind, pressure: string | null, before: { config: RunConfig; result: MeasuredRun }, after: { config: RunConfig; result: MeasuredRun }, say: (id: string) => string): string | null {
  const window = incident(after.config, after.result);
  if (kind === 'boundQueue' && pressure !== null) {
    const n = sum(after.result.run.tiers[pressure].rejected, window);
    if (n > 0) return `${capitalise(say(pressure))} turned ${count(n)} requests away at once instead of letting them wait`;
  }
  if (kind === 'dropExpired' && pressure !== null) {
    const n = sum(after.result.run.tiers[pressure].dropped, window);
    if (n > 0) return `${capitalise(say(pressure))} skipped ${count(n)} requests nobody was waiting for any more`;
  }
  if (kind === 'coalesceMisses' && pressure !== null) {
    const reads = (r: MeasuredRun, c: RunConfig) => sum(r.run.tiers[pressure].arrivalsFirst, incident(c, r)) + sum(r.run.tiers[pressure].arrivalsRetry, incident(c, r));
    const [x, y] = [reads(before.result, before.config), reads(after.result, after.config)];
    if (y < x) return `Requests reaching ${say(pressure)} during the incident fell from ${count(x)} to ${count(y)}`;
  }
  if (kind === 'moreConsumers') {
    const q = (r: MeasuredRun) => r.analysis.signals.queueBacklog?.value.peak ?? 0;
    if (q(after.result) < q(before.result)) return `At most ${count(q(after.result))} messages waited instead of ${count(q(before.result))}`;
  }
  const [x, y] = [retriesSent(before.result.run), retriesSent(after.result.run)];
  if (y < x && (RETRY_KINDS.has(kind) || kind === 'longerTimeout' || kind === 'addInstances' || kind === 'boundQueue' || kind === 'dropExpired')) {
    return `Retries sent by all layers fell from ${count(x)} to ${count(y)}`;
  }
  return null;
}

const uncap = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** The call whose timeout the fix lengthened, with its new timeout. */
function changedTimeout(before: RunConfig, after: RunConfig): { owner: string; target: string; timeoutMs: number } | null {
  const key = (c: { owner: string; policy: CallPolicy }) => `${c.owner}→${c.policy.target}`;
  const was = new Map(layerCalls(before).map((c) => [key(c), c.policy.timeoutMs]));
  for (const c of layerCalls(after)) {
    const old = was.get(key(c));
    if (c.policy.timeoutMs !== null && old !== undefined && old !== null && c.policy.timeoutMs > old) return { owner: c.owner, target: c.policy.target, timeoutMs: c.policy.timeoutMs };
  }
  return null;
}

/** The tier the fix gave more instances, if any. */
function grew(before: RunConfig, after: RunConfig): string | null {
  return after.tiers.find((t) => (before.tiers.find((x) => x.id === t.id)?.instances ?? t.instances) < t.instances)?.id ?? null;
}
