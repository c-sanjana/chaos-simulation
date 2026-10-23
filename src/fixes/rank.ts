import { assessRecovery, controlConfig, type Verdict } from '../analysis/recovery';
import type { RunConfig } from '../engine/config';
import { runSimulation } from '../engine/run';
import type { FixCandidate } from './candidates';
import { FIX_CATALOG } from './catalog';

export interface FixOutcome {
  verdict: Verdict;
  recoveryMs: number | null;
  failedRequests: number;
}

export interface RankedFix {
  candidate: FixCandidate;
  outcome: FixOutcome;
  helped: boolean;
}

/**
 * Runs `config` and judges it against its own control.
 *
 * The control for a fixed config is that fixed config without faults (controlConfig(fixedConfig)),
 * not the original's control: a fix changes normal behaviour too (a bounded queue may reject
 * requests, a retry budget refuses retries a healthy system would have made), and recovery means
 * returning to the fixed system's own normal. A fix that fails requests even without the failure
 * comes out as "overloaded" and ranks last.
 */
export function measureOutcome(config: RunConfig): FixOutcome {
  const run = runSimulation(config);
  const control = runSimulation(controlConfig(config));
  const { verdict, recoveryMs, failedRequests } = assessRecovery(run, control, config);
  return { verdict, recoveryMs, failedRequests };
}

const VERDICT_ORDER: Record<Verdict, number> = { unaffected: 0, recovered: 1, stuck: 2, overloaded: 3 };
const backToNormal = (v: Verdict) => v === 'unaffected' || v === 'recovered';
/** Time to return to normal: 0 if never affected, Infinity if it never returned. */
const timeToNormal = (o: FixOutcome) => (o.verdict === 'unaffected' ? 0 : o.recoveryMs ?? Infinity);

/**
 * Did the fix help? It turns a stuck/overloaded run into recovered/unaffected, or (if the original
 * already got back to normal) still gets back to normal and recovers strictly faster or fails
 * strictly fewer requests.
 */
export function fixHelped(original: FixOutcome, fixed: FixOutcome): boolean {
  if (!backToNormal(original.verdict)) return backToNormal(fixed.verdict);
  if (!backToNormal(fixed.verdict)) return false;
  return timeToNormal(fixed) < timeToNormal(original) || fixed.failedRequests < original.failedRequests;
}

/**
 * helped = the fix turns a stuck/overloaded run into recovered/unaffected, or (if the original
 * already recovered) recovers strictly faster or fails strictly fewer requests. Ranked: helped
 * first; then verdict (unaffected < recovered < stuck < overloaded); then recovery time; then
 * failed requests; ties by catalog order.
 */
export function rankFixes(original: FixOutcome, results: Array<{ candidate: FixCandidate; outcome: FixOutcome }>): RankedFix[] {
  const catalogIndex = (id: string) => {
    const i = FIX_CATALOG.findIndex((d) => d.id === id);
    return i < 0 ? Infinity : i;
  };
  return results
    .map(({ candidate, outcome }, input) => ({ candidate, outcome, helped: fixHelped(original, outcome), input }))
    .sort(
      (a, b) =>
        Number(b.helped) - Number(a.helped) ||
        VERDICT_ORDER[a.outcome.verdict] - VERDICT_ORDER[b.outcome.verdict] ||
        compare(timeToNormal(a.outcome), timeToNormal(b.outcome)) ||
        a.outcome.failedRequests - b.outcome.failedRequests ||
        compare(catalogIndex(a.candidate.id), catalogIndex(b.candidate.id)) ||
        a.input - b.input,
    )
    .map(({ candidate, outcome, helped }) => ({ candidate, outcome, helped }));
}

/** Ascending, treating equal infinities as equal (Infinity − Infinity is NaN). */
const compare = (x: number, y: number) => (x === y ? 0 : x < y ? -1 : 1);

/** The same config with seeds config.seed, config.seed + 1, … (deterministic). */
export function seedVariants(config: RunConfig, count = 5): RunConfig[] {
  return Array.from({ length: count }, (_, i) => ({ ...config, seed: config.seed + i }));
}

export interface SeedAgreement {
  helped: number;
  of: number;
}

/** Per seed i: did the fix help vs the original at the same seed. Both lists are in seed order. */
export function seedAgreement(originals: FixOutcome[], fixed: FixOutcome[]): SeedAgreement {
  if (originals.length !== fixed.length) throw new Error(`seedAgreement needs one fixed outcome per seed (${originals.length} vs ${fixed.length})`);
  return { helped: originals.filter((o, i) => fixHelped(o, fixed[i])).length, of: originals.length };
}
