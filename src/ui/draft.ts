import { callsOf, type CallPolicy, type Fault, type TierConfig } from '../engine/config';
import { JUDGE_AFTER_FAILURE_S, LIMITS, runSizeProblem } from '../data/limits';
import { buildRunConfig } from '../data/buildConfig';
import { callsPerRequest } from '../analysis/helpers';
import type { ScenarioPreset, TopologyPreset } from '../data/types';

/** What the viewer can edit: a topology and a scenario, starting from the presets. Plain data. */
export interface Draft {
  topology: TopologyPreset;
  scenario: ScenarioPreset;
}

export function updateTier(d: Draft, id: string, change: (t: TierConfig) => TierConfig): Draft {
  return { ...d, topology: { ...d.topology, tiers: d.topology.tiers.map((t) => (t.id === id ? change(t) : t)) } };
}

export function updateScenario(d: Draft, change: Partial<ScenarioPreset>): Draft {
  return { ...d, scenario: { ...d.scenario, ...change } };
}

/** Edits one of the scenario's faults (the first by default). */
export function updateFault(d: Draft, change: Partial<Fault>, index = 0): Draft {
  return updateScenario(d, { faults: d.scenario.faults.map((f, i) => (i === index ? { ...f, ...change } : f)) });
}

/** Replaces one of the scenario's faults outright (e.g. after changing its kind, so no stale fields remain). */
export function setFault(d: Draft, fault: Fault, index: number): Draft {
  return updateScenario(d, { faults: d.scenario.faults.map((f, i) => (i === index ? fault : f)) });
}

/**
 * Adds a failure: a slowdown of a part that isn't failing yet (front to back), at the same time and
 * for as long as the first failure. ASSUMPTION: 4× slower is a noticeable but not extreme default.
 */
export function addFault(d: Draft): Draft {
  const first = d.scenario.faults[0];
  const failing = new Set(d.scenario.faults.map((f) => f.tier));
  const tier = d.topology.tiers.find((t) => !failing.has(t.id))?.id ?? first.tier;
  return updateScenario(d, { faults: [...d.scenario.faults, { tier, kind: 'slow', factor: 4, startMs: first.startMs, endMs: first.endMs }] });
}

/** Removes a failure; the first one always stays (a scenario injects at least one). */
export function removeFault(d: Draft, index: number): Draft {
  if (index === 0) return d;
  return updateScenario(d, { faults: d.scenario.faults.filter((_, i) => i !== index) });
}

/** The kinds of failure the editor offers, as plain words. */
export type FaultKindChoice = 'slow' | 'down' | 'one-down' | 'restart-empty';

/**
 * Each kind as the failure editor's "What happens" offers it; a problem quotes these, so it names
 * an option that is really there. A server's instances are "copies" everywhere the viewer reads.
 */
export const FAULT_KIND_LABELS: Record<FaultKindChoice, string> = {
  slow: 'slows down',
  down: 'goes down',
  'one-down': 'loses one copy',
  'restart-empty': 'goes down, restarts empty',
};

export function faultKindOf(f: Fault): FaultKindChoice {
  if (f.kind === 'slow') return 'slow';
  if (f.flushAtEnd) return 'restart-empty';
  return f.instance === undefined ? 'down' : 'one-down';
}

/**
 * The fault with its kind changed, keeping where and when it happens. Its keys are in the presets'
 * order (part, kind, how much, when, then the kind's extras), so it reads like them too.
 */
export function withFaultKind(f: Fault, kind: FaultKindChoice): Fault {
  const { tier, startMs, endMs } = f;
  if (kind === 'slow') return { tier, kind: 'slow', factor: f.factor ?? 4, startMs, endMs };
  if (kind === 'one-down') return { tier, kind: 'dead', startMs, endMs, instance: 0 };
  if (kind === 'restart-empty') return { tier, kind: 'dead', startMs, endMs, flushAtEnd: true };
  return { tier, kind: 'dead', startMs, endMs };
}

/** e.g. "slows 8×", "goes down", "loses one of its 4 copies", "goes down and restarts empty". */
export function describeFault(f: Fault, instances: number): string {
  switch (faultKindOf(f)) {
    case 'slow':
      return `slows ${f.factor}×`;
    case 'restart-empty':
      return 'goes down and restarts empty';
    case 'one-down':
      return `loses one of its ${instances} copies`;
    case 'down':
      return 'goes down';
  }
}

/** A call that can retry: who calls whom, and how many times it retries after giving up. */
export interface RetryCall {
  /** 'client' or the calling tier's id. */
  caller: string;
  target: string;
  retries: number;
}

/**
 * Every call's retries, front to back: each tier's calls in order (`callsOf`: a part that calls
 * several parts has one entry per call). Cache lookups are excluded: they don't retry.
 */
export function retryCalls(t: TopologyPreset): RetryCall[] {
  const calls: RetryCall[] = [{ caller: 'client', target: t.clientCall.target, retries: t.clientCall.retries }];
  for (const tier of t.tiers) for (const c of callsOf(tier)) calls.push({ caller: tier.id, target: c.target, retries: c.retries });
  return calls;
}

/** A key naming one call ("api>db"), for comparing calls between two drafts. */
export const callKey = (c: Pick<RetryCall, 'caller' | 'target'>): string => `${c.caller}>${c.target}`;

/** Each caller's retry counts, front to back: one entry per caller, its distinct counts in call order. */
export function retriesByCaller(calls: RetryCall[]): Array<{ caller: string; counts: number[] }> {
  const out: Array<{ caller: string; counts: number[] }> = [];
  for (const c of calls) {
    const group = out.find((g) => g.caller === c.caller);
    if (!group) out.push({ caller: c.caller, counts: [c.retries] });
    else if (!group.counts.includes(c.retries)) group.counts.push(c.retries);
  }
  return out;
}

/** "1×", or "1× / 2×" for a caller whose calls retry differently. */
export const countsText = (counts: number[]): string => counts.map((n) => `${n}×`).join(' / ');

/**
 * A part's name with its retry counts: "Load balancer 2×", but "App server 2: 2×" for a name that
 * ends in a number, which would otherwise read as one number ("App server 2 2×").
 */
export const withCounts = (name: string, counts: number[]): string => `${name}${/\d$/.test(name) ? ':' : ''} ${countsText(counts)}`;

/**
 * Sets how many times `caller` retries its call to `target` (every one of its calls when `target`
 * is left out).
 */
export function updateRetries(d: Draft, caller: string, retries: number, target?: string): Draft {
  if (caller === 'client') return { ...d, topology: { ...d.topology, clientCall: { ...d.topology.clientCall, retries } } };
  const set = (c: CallPolicy) => (target === undefined || c.target === target ? { ...c, retries } : c);
  return updateTier(d, caller, (t) => ({
    ...t,
    downstream: t.downstream && set(t.downstream),
    ...(t.moreDownstream ? { moreDownstream: t.moreDownstream.map(set) } : {}),
  }));
}

/** Changes one of a tier's calls (by position in `callsOf`: 0 is `downstream`). */
export function updateCallAt(t: TierConfig, index: number, change: Partial<CallPolicy>): TierConfig {
  if (index === 0) return { ...t, downstream: t.downstream && { ...t.downstream, ...change } };
  return { ...t, moreDownstream: (t.moreDownstream ?? []).map((c, i) => (i === index - 1 ? { ...c, ...change } : c)) };
}

/**
 * The map cell matching the current settings: the traffic across, and the first failure's length up.
 * ASSUMPTION: every scenario's map has failure length up (the failure editor sets the failure); the
 * sweep could also vary retries up, but no scenario does, so any other axis reads the traffic.
 */
export function currentCell(s: ScenarioPreset): { x: number; y: number } {
  const f = s.faults[0];
  const y = s.map.y.param === 'outageMs' ? f.endMs - f.startMs : s.rps;
  return { x: s.rps, y };
}

/** Input limits (5,000 req/s, 30–600 s); defined in data/limits.ts with the reasons. */
export { LIMITS };

/** Recovery needs time after the failure to be judged; the run must last this long past its end. */
export { JUDGE_AFTER_FAILURE_S };

/**
 * Problems that involve more than one setting, in plain words (each field checks its own range).
 * Running is blocked while there are any.
 */
export function draftProblems(d: Draft): string[] {
  const problems: string[] = [];
  const s = d.scenario;
  const durationS = s.durationMs / 1000;
  const label = (id: string) => d.topology.layout[id]?.label ?? id;
  for (const f of s.faults) {
    const tier = d.topology.tiers.find((t) => t.id === f.tier);
    if (f.instance !== undefined && tier && (tier.instances < 2 || f.instance >= tier.instances)) {
      problems.push(
        `${label(f.tier)} has only ${tier.instances} cop${tier.instances === 1 ? 'y' : 'ies'}, so "${FAULT_KIND_LABELS['one-down']}" would take it down completely; choose "${FAULT_KIND_LABELS.down}" instead.`,
      );
    }
    const endS = f.endMs / 1000;
    if (endS > durationS - JUDGE_AFTER_FAILURE_S) {
      problems.push(
        `The failure must end at least ${JUDGE_AFTER_FAILURE_S} s before the run ends, so there is time to see whether the system recovers. It ends at ${endS} s; the run lasts ${durationS} s.`,
      );
    }
  }
  // The fields stop traffic and duration at their limits; this also covers a loaded or built system.
  const tooBig = runSizeProblem(s.rps, s.durationMs, callsPerRequest(buildRunConfig(d.topology, s)));
  if (tooBig) problems.push(tooBig);
  // ASSUMPTION: the engine doesn't combine two failures of one part at once (the latest change
  // wins, engine/tier.ts), so overlapping failures of the same part are refused rather than
  // simulated in a way the editor doesn't describe.
  s.faults.forEach((f, i) => {
    const j = s.faults.findIndex((g, k) => k < i && g.tier === f.tier && g.startMs < f.endMs && f.startMs < g.endMs);
    if (j >= 0) problems.push(`Failures ${j + 1} and ${i + 1} both hit ${label(f.tier)} at the same time, and only one failure of a part can be simulated at once. Move one of them, or choose another part.`);
  });
  for (const t of d.topology.tiers) {
    if (t.service.kind === 'lognormal' && !(t.service.p99Ms > t.service.medianMs)) {
      problems.push(`${label(t.id)}: the slowest 1% of requests (p99) must take longer than a typical one (median).`);
    }
  }
  return problems;
}

/** The map cell closest to `cell` (the current settings may fall between or beyond the map's values). */
export function nearestCell(s: ScenarioPreset, cell: { x: number; y: number } = currentCell(s)): { x: number; y: number } {
  const near = (values: number[], v: number) => values.reduce((best, x) => (Math.abs(x - v) < Math.abs(best - v) ? x : best), values[0]);
  return { x: near(s.map.x.values, cell.x), y: near(s.map.y.values, cell.y) };
}

/** Whether the current settings are one of the map's cells. */
export function onMap(s: ScenarioPreset): boolean {
  const c = currentCell(s);
  return s.map.x.values.includes(c.x) && s.map.y.values.includes(c.y);
}
