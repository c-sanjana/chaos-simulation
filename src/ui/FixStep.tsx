import { useEffect, useMemo, useState } from 'react';
import type { RunConfig } from '../engine/config';
import type { ScenarioPreset, TopologyPreset } from '../data/types';
import { applyFix } from '../fixes/candidates';
import { FIX_CATALOG } from '../fixes/catalog';
import type { FixOutcome, RankedFix } from '../fixes/rank';
import { buildSweep, tippingPoints, type SweepResult } from '../sweep/sweep';
import type { AnalyzeResult } from '../worker/jobs';
import type { SimPool } from '../worker/pool';
import { FixList } from './components/FixList';
import { TippingMap } from './components/TippingMap';
import type { FixView } from './components/types';
import { currentCell } from './draft';
import { RunPlayer } from './RunPlayer';
import { useFixRanking } from './useFixRanking';
import { useAnalysis, useSweep } from './useSimulation';
import { formatAxisValue, mapView, shortVerdict } from './viewModels';

export interface FixStepProps {
  pool: SimPool;
  topology: TopologyPreset;
  scenario: ScenarioPreset;
  config: RunConfig;
  /** The original run (step 1); fixes are suggested from its signals. */
  original: AnalyzeResult | null;
  labels: Record<string, string>;
  onEdit?: (tierId: string | null) => void;
}

/** Step 3: fixes ranked by measured effect; apply one to compare runs and maps before and after. */
export function FixStep({ pool, topology, scenario, config, original, labels, onEdit }: FixStepProps) {
  const ranking = useFixRanking(pool, config, original?.analysis ?? null, labels);
  const [appliedId, setAppliedId] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const apply = (id: string | null) => (setTouched(true), setAppliedId(id));
  const applied = ranking.ranked.find((f) => f.candidate.id === appliedId) ?? null;
  const fixed = useAnalysis(pool, applied ? applied.candidate.config : null, labels);

  const signals = original?.analysis.signals ?? null;
  const beforeSpec = useMemo(() => (applied ? buildSweep(topology, scenario) : null), [applied, topology, scenario]);
  const afterSpec = useMemo(() => {
    if (!applied || !signals) return null;
    const def = FIX_CATALOG.find((d) => d.id === applied.candidate.id)!;
    // ASSUMPTION: the fix is applied to every cell the same way it was planned for this run's signals.
    return buildSweep(topology, scenario, {}, (c) => applyFix(def, c, signals) ?? c);
  }, [applied, signals, topology, scenario]);
  const before = useSweep(pool, beforeSpec);
  const after = useSweep(pool, afterSpec);

  const helped = ranking.ranked.filter((f) => f.helped);
  const didNotHelp = ranking.ranked.filter((f) => !f.helped);
  const allTested = ranking.candidates.length > 0 && ranking.tested === ranking.candidates.length;
  // Once every fix is tested, show the best one side by side straight away (until the viewer picks).
  const best = allTested && helped.length > 0 ? helped[0].candidate.id : null;
  useEffect(() => {
    if (!touched && best !== null) setAppliedId(best);
  }, [best, touched]);

  if (!original) return <p className="csl-status">Waiting for the original run…</p>;
  const fixes = helped.map((f) => fixView(f, ranking.original!, ranking.seeds[f.candidate.id]));

  return (
    <div className="csl-split">
      <section className="csl-card csl-card--compact csl-split__side" aria-label="Fixes">
        <div className="csl-card__head">
          <h2 className="csl-card__title">Does a fix help?</h2>
          <span className="csl-status" aria-live="polite">
            {ranking.error ? <span className="csl-error">{ranking.error}</span> : allTested ? `${ranking.candidates.length} fixes tested` : `Testing fixes: ${ranking.tested} of ${ranking.candidates.length}`}
          </span>
        </div>
        <p className="csl-card__sub" style={{ margin: 0 }}>
          Each fix is one setting change, re-run against the same traffic and failure, ranked by what actually happened.
        </p>
        {allTested && (
          <FixList
            fixes={fixes}
            appliedId={appliedId}
            onApply={apply}
            failed={didNotHelp.map((f) => ({ title: f.candidate.title, result: `${capitalise(shortVerdict(f.outcome))}: ${f.candidate.why}` }))}
          />
        )}
        {applied && before.result && after.result && (
          <div className="csl-panel" aria-label="Did the tipping point move?">
            <h3 className="csl-section-title" style={{ margin: 0 }}>
              Did the tipping point move?
            </h3>
            <div className="csl-row csl-map--small" style={{ gap: 14 }}>
              {[
                { title: 'Before', sweep: before.result },
                { title: 'After', sweep: after.result },
              ].map((m) => (
                <div key={m.title}>
                  <span className="csl-status">{m.title}</span>
                  <TippingMap map={mapView(m.title, scenario.map.x, scenario.map.y, (x, y) => m.sweep.get(x, y), currentCell(scenario))} />
                </div>
              ))}
            </div>
            <span className="csl-status">
              {before.done + after.done} of {before.total + after.total} runs done
            </span>
            {before.done === before.total && after.done === after.total && <p style={{ margin: 0, fontSize: 13 }}>{moveSummary(scenario, before.result, after.result)}</p>}
          </div>
        )}
      </section>
      <div className="csl-split__main">
        {applied && fixed.status === 'done' && (
          <RunPlayer
            title={`Before vs after: ${applied.candidate.title}`}
            subtitle="Same traffic, same failure, same seed. Only the fix differs."
            topology={topology}
            config={config}
            result={original}
            after={{ config: applied.candidate.config, result: fixed.value }}
            onEdit={onEdit}
            compact
          />
        )}
        {applied && fixed.status === 'running' && (
          <section className="csl-card csl-card--compact">
            <p className="csl-status">Simulating the fix…</p>
          </section>
        )}
        {!applied && (
          <section className="csl-card csl-card--compact">
            <p className="csl-status">{allTested ? 'Apply a fix to compare it with the original run here, side by side.' : 'Testing fixes…'}</p>
          </section>
        )}
      </div>
    </div>
  );
}

function fixView(f: RankedFix, original: FixOutcome, seeds: { helped: number; of: number } | undefined): FixView {
  return {
    id: f.candidate.id,
    title: f.candidate.title,
    why: f.candidate.why,
    result: `${capitalise(shortVerdict(original))} → ${shortVerdict(f.outcome)}`,
    seeds: seeds ? `helps in ${seeds.helped} of ${seeds.of} seeds` : 'checking other seeds…',
    affected: `${f.outcome.failedRequests.toLocaleString()} failed requests (was ${original.failedRequests.toLocaleString()})`,
    caveat: f.candidate.caveat,
  };
}

/** One sentence on how the boundary moved for the current y value. */
export function moveSummary(scenario: ScenarioPreset, before: SweepResult, after: SweepResult): string {
  const y = currentCell(scenario).y;
  const tip = (r: SweepResult) => tippingPoints(r).find((t) => t.y === y)?.tipsAtX ?? null;
  const [b, a] = [tip(before), tip(after)];
  const at = `With ${formatAxisValue(scenario.map.y, y)} ${scenario.map.y.label}`;
  if (b === null && a === null) return `${at}, the system recovered at every traffic level shown, before and after.`;
  if (a === null) return `${at}, the system used to tip at ${b} requests/s; with the fix it recovers at every traffic level shown.`;
  if (b === null) return `${at}, the fix makes it tip at ${a} requests/s, where it used to recover everywhere shown.`;
  if (a > b) return `${at}, the tipping point moves from ${b} to ${a} requests/s.`;
  if (a < b) return `${at}, the tipping point moves down from ${b} to ${a} requests/s: the fix makes this worse.`;
  return `${at}, the tipping point stays at ${b} requests/s.`;
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
