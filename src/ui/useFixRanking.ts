import { useEffect, useState } from 'react';
import type { Analysis } from '../analysis/analyze';
import type { RunConfig } from '../engine/config';
import { candidateFixes, type FixCandidate } from '../fixes/candidates';
import { fixHelped, rankFixes, seedAgreement, seedVariants, withLongerOutage, type FixOutcome, type RankedFix, type Robustness } from '../fixes/rank';
import { CancelledError, type SimPool } from '../worker/pool';

/** Every fix that helped is re-checked on this many seeds (the original seed included). */
const SEEDS = 5;

export interface FixRankingState {
  original: FixOutcome | null;
  candidates: FixCandidate[];
  ranked: RankedFix[];
  tested: number;
  /** For every fix that helped, by fix id: how it did on other random seeds and with a longer slowdown, once known. */
  robustness: Record<string, Robustness>;
  /** True until those checks are done (from the start, so "all tested" never shows a ranking about to change). */
  checking: boolean;
  /**
   * Whether the longer-slowdown check means anything: only when the longer slowdown leaves the
   * original stuck (if it recovers by itself, no fix can "help" there). null until known.
   */
  longerApplies: boolean | null;
  error: string | null;
}

const EMPTY: FixRankingState = { original: null, candidates: [], ranked: [], tested: 0, robustness: {}, checking: false, longerApplies: null, error: null };

/**
 * Tries every candidate fix for a run in the worker pool, ranking them by what actually happened as
 * results arrive; then checks whether every fix that helped holds up: on other random seeds, and
 * with a slowdown twice as long (a fix tuned to exactly this failure may not survive a worse one).
 * Fixes that hold up rank first. Each run is the fixed config compared with its own no-failure
 * control (see fixes/rank.ts).
 */
export function useFixRanking(pool: SimPool, config: RunConfig, analysis: Analysis | null, labels: Record<string, string>): FixRankingState {
  const key = analysis ? JSON.stringify(config) : null;
  const [state, setState] = useState<FixRankingState>(EMPTY);
  useEffect(() => {
    if (!analysis) {
      setState(EMPTY);
      return;
    }
    const r = analysis.recovery;
    const original: FixOutcome = { verdict: r.verdict, recoveryMs: r.recoveryMs, failedRequests: r.failedRequests };
    const candidates = candidateFixes(config, analysis.signals, labels);
    const results: Array<{ candidate: FixCandidate; outcome: FixOutcome }> = [];
    const robustness: Record<string, Robustness> = {};
    setState({ ...EMPTY, original, candidates, checking: candidates.length > 0 });
    const update = (id: string, r: Robustness) => {
      robustness[id] = { ...robustness[id], ...r };
      setState((s) => ({ ...s, robustness: { ...robustness }, ranked: rankFixes(original, results, robustness) }));
    };
    const batch = pool.batch();
    const fail = (e: unknown) => {
      if (!(e instanceof CancelledError)) setState((s) => ({ ...s, error: String(e) }));
    };

    Promise.all(
      candidates.map((candidate) =>
        batch.cell(candidate.config).then((outcome) => {
          results.push({ candidate, outcome });
          setState((s) => ({ ...s, ranked: rankFixes(original, results), tested: results.length }));
        }),
      ),
    )
      .then(async () => {
        const top = rankFixes(original, results).filter((f) => f.helped);
        if (top.length === 0) return setState((s) => ({ ...s, checking: false }));
        const longerConfig = withLongerOutage(config);
        const [originals, longerResult] = await Promise.all([
          Promise.all(seedVariants(config, SEEDS).map((c) => batch.cell(c))),
          longerConfig ? batch.cell(longerConfig) : Promise.resolve(null),
        ]);
        // ASSUMPTION: a longer slowdown the system recovers from by itself says nothing about a fix
        // (measured: the Gateway preset's 40 s slowdown recovers while 20 s gets stuck), so skip it.
        const stuck = (v: string) => v === 'stuck' || v === 'overloaded';
        const longerOriginal = longerResult && stuck(longerResult.verdict) ? longerResult : null;
        setState((s) => ({ ...s, longerApplies: longerOriginal !== null }));
        await Promise.all(
          top.flatMap((f) => {
            const longerFixed = withLongerOutage(f.candidate.config);
            return [
              Promise.all(seedVariants(f.candidate.config, SEEDS).map((c) => batch.cell(c))).then((fixed) => update(f.candidate.id, { seeds: seedAgreement(originals, fixed) })),
              longerOriginal && longerFixed ? batch.cell(longerFixed).then((o) => update(f.candidate.id, { longer: fixHelped(longerOriginal, o) })) : Promise.resolve(),
            ];
          }),
        );
        setState((s) => ({ ...s, checking: false }));
      })
      .catch(fail);
    return () => batch.cancel();
    // `key` stands in for config + analysis (compared by value).
  }, [pool, key]);
  return state;
}
