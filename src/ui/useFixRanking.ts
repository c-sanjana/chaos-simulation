import { useEffect, useState } from 'react';
import type { Analysis } from '../analysis/analyze';
import type { RunConfig } from '../engine/config';
import { candidateFixes, type FixCandidate } from '../fixes/candidates';
import { rankFixes, seedAgreement, seedVariants, type FixOutcome, type RankedFix, type SeedAgreement } from '../fixes/rank';
import { CancelledError, type SimPool } from '../worker/pool';

/** Every fix that helped is re-checked on this many seeds (the original seed included). */
const SEEDS = 5;

export interface FixRankingState {
  original: FixOutcome | null;
  candidates: FixCandidate[];
  ranked: RankedFix[];
  tested: number;
  /** "Helps in N of 5 seeds" for every fix that helped, by fix id, once known. */
  seeds: Record<string, SeedAgreement>;
  error: string | null;
}

const EMPTY: FixRankingState = { original: null, candidates: [], ranked: [], tested: 0, seeds: {}, error: null };

/**
 * Tries every candidate fix for a run in the worker pool, ranking them by what actually happened as
 * results arrive; then re-checks every fix that helped on other random seeds. Each run is the fixed config
 * compared with its own no-failure control (see fixes/rank.ts).
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
    setState({ ...EMPTY, original, candidates });
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
        if (top.length === 0) return;
        const originals = await Promise.all(seedVariants(config, SEEDS).map((c) => batch.cell(c)));
        await Promise.all(
          top.map(async (f) => {
            const fixed = await Promise.all(seedVariants(f.candidate.config, SEEDS).map((c) => batch.cell(c)));
            setState((s) => ({ ...s, seeds: { ...s.seeds, [f.candidate.id]: seedAgreement(originals, fixed) } }));
          }),
        );
      })
      .catch(fail);
    return () => batch.cancel();
    // `key` stands in for config + analysis (compared by value).
  }, [pool, key]);
  return state;
}
