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
 * Recovery times this close are a tie: they are whole seconds (recovery is judged per second) and
 * vary by a second or more from one random seed to the next.
 */
export const RECOVERY_TIE_MS = 1000;

/** How far a fix's success holds up beyond the one run it was measured on. */
export interface Robustness {
  /** Helped on how many of several random seeds; undefined = not checked yet. */
  seeds?: SeedAgreement;
  /** helped also with a longer slowdown; undefined = not checked yet */
  longer?: boolean;
}

/** Share of seeds a fix must help on to count as reliable. */
const RELIABLE_SHARE = 0.8;

/**
 * Is a fix's help reliable? true when it helped on at least 80% of the seeds checked (4 of 5) and
 * did not stop helping with a longer slowdown (not checking that is fine: the check does not
 * always apply); false when either check failed; null while the seeds are still unknown.
 */
export function isReliable(r: Robustness | undefined): boolean | null {
  if (r === undefined) return null;
  const seedsKnown = r.seeds !== undefined && r.seeds.of > 0;
  if ((seedsKnown && r.seeds!.helped < RELIABLE_SHARE * r.seeds!.of) || r.longer === false) return false;
  return seedsKnown ? true : null;
}

/**
 * helped = the fix turns a stuck/overloaded run into recovered/unaffected, or (if the original
 * already recovered) recovers strictly faster or fails strictly fewer requests. Ranked:
 *   1. helped first, and among those, reliable ones (see isReliable; not known yet counts as
 *      reliable) before unreliable ones;
 *   2. verdict (unaffected < recovered < stuck < overloaded);
 *   3. recovery time, where times within RECOVERY_TIE_MS of each other are a tie;
 *   4. failed requests;
 *   5. catalog order, then input order.
 */
export function rankFixes(
  original: FixOutcome,
  results: Array<{ candidate: FixCandidate; outcome: FixOutcome }>,
  robustness: Record<string, Robustness> = {},
): RankedFix[] {
  const catalogIndex = (id: string) => {
    const i = FIX_CATALOG.findIndex((d) => d.id === id);
    return i < 0 ? Infinity : i;
  };
  const rows = results.map(({ candidate, outcome }, input) => {
    const helped = fixHelped(original, outcome);
    // Only helped fixes are told apart by reliability; the rest keep their order.
    const unreliable = helped && isReliable(robustness[candidate.id]) === false;
    const group = `${helped}|${unreliable}|${outcome.verdict}`;
    return { candidate, outcome, helped, unreliable, group, input, timeTier: 0 };
  });
  assignTimeTiers(rows);
  return rows
    .sort(
      (a, b) =>
        Number(b.helped) - Number(a.helped) ||
        Number(a.unreliable) - Number(b.unreliable) ||
        VERDICT_ORDER[a.outcome.verdict] - VERDICT_ORDER[b.outcome.verdict] ||
        compare(a.timeTier, b.timeTier) ||
        a.outcome.failedRequests - b.outcome.failedRequests ||
        compare(catalogIndex(a.candidate.id), catalogIndex(b.candidate.id)) ||
        a.input - b.input,
    )
    .map(({ candidate, outcome, helped }) => ({ candidate, outcome, helped }));
}

/**
 * Ties recovery times within RECOVERY_TIE_MS, among rows that are otherwise ranked alike (same
 * `group`). "Within 1 s of each other" is not transitive (1 s, 1.9 s and 2.8 s), so ties are cut
 * greedily: the fastest time opens a tier holding every time up to 1 s slower, the next time
 * opens the next tier, and so on. Every row's `timeTier` becomes the time that opened its tier.
 */
function assignTimeTiers(rows: Array<{ outcome: FixOutcome; group: string; timeTier: number }>): void {
  const byGroup = new Map<string, typeof rows>();
  for (const row of rows) byGroup.set(row.group, [...(byGroup.get(row.group) ?? []), row]);
  for (const group of byGroup.values()) {
    let opened = -Infinity;
    for (const row of [...group].sort((a, b) => compare(timeToNormal(a.outcome), timeToNormal(b.outcome)))) {
      const t = timeToNormal(row.outcome);
      if (!(t - opened <= RECOVERY_TIE_MS)) opened = t; // also opens a tier for the first row, and for Infinity after a finite time
      row.timeTier = opened;
    }
  }
}

/** Ascending, treating equal infinities as equal (Infinity − Infinity is NaN). */
const compare = (x: number, y: number) => (x === y ? 0 : x < y ? -1 : 1);

/**
 * Longest a failure may last into the run, as time left after it: recovery needs room to be seen
 * (the retry storm recovers within seconds when it recovers at all, and the judged range ends a
 * few seconds before the run does).
 */
export const LONGER_OUTAGE_MARGIN_MS = 20_000;

/**
 * The same config with every failure lasting `factor` times as long (same start), to check whether
 * a fix still helps with a longer slowdown. Null when there are no failures, or when a longer one
 * would end less than LONGER_OUTAGE_MARGIN_MS before the run does (too late to judge recovery).
 * Never mutates `config`.
 */
export function withLongerOutage(config: RunConfig, factor = 2): RunConfig | null {
  const faults = config.faults ?? [];
  if (faults.length === 0) return null;
  const longer = faults.map((f) => ({ ...f, endMs: f.startMs + factor * (f.endMs - f.startMs) }));
  if (longer.some((f) => f.endMs > config.durationMs - LONGER_OUTAGE_MARGIN_MS)) return null;
  return { ...config, faults: longer };
}

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
