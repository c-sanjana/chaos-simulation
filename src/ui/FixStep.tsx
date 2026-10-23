import { useEffect, useMemo, useState } from 'react';
import type { RunConfig } from '../engine/config';
import type { ScenarioPreset, TopologyPreset } from '../data/types';
import { applyFix } from '../fixes/candidates';
import { FIX_CATALOG } from '../fixes/catalog';
import type { FixOutcome, RankedFix } from '../fixes/rank';
import { buildSweep, tippingPoints, type SweepResult } from '../sweep/sweep';
import type { AnalyzeResult } from '../worker/jobs';
import type { SimPool } from '../worker/pool';
import { FixTabs, type FixTab } from './components/FixTabs';
import { TippingMap } from './components/TippingMap';
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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [timelineEl, setTimelineEl] = useState<HTMLElement | null>(null);
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
  const allTested = ranking.candidates.length > 0 && ranking.tested === ranking.candidates.length;
  // Once every fix is tested, show the best one side by side straight away (until the viewer picks).
  const best = allTested && helped.length > 0 ? helped[0].candidate.id : null;
  useEffect(() => {
    if (!touched && best !== null) {
      setAppliedId(best);
      setSelectedId(best);
    }
  }, [best, touched]);

  if (!original) return <p className="csl-status">Waiting for the original run…</p>;
  const tabs = ranking.ranked.map((f) => fixTab(f, ranking.original!, ranking.seeds[f.candidate.id]));

  return (
    <div className="csl-split csl-split--stretch">
      <div className="csl-split__col csl-split__side csl-split__side--wide">
        <section className="csl-card csl-card--compact" aria-label="Fixes">
          <div className="csl-fix-maps__panel" aria-label="Did the tipping point move?" data-tour="fix-maps">
            <div className="csl-fix-maps__head">
              <h2 className="csl-section-title" style={{ margin: 0 }}>
                Did the tipping point move?
              </h2>
              <span className="csl-status" aria-live="polite">
                {ranking.error ? <span className="csl-error">{ranking.error}</span> : allTested ? `${ranking.candidates.length} fixes tested` : `Testing fixes: ${ranking.tested} of ${ranking.candidates.length}`}
              </span>
            </div>
            {applied && before.result && after.result ? (
              <>
                <div className="csl-fix-maps csl-map--medium">
                  {[
                    { title: 'Before', sweep: before.result },
                    { title: `After: ${shortName(applied.candidate.id)}`, sweep: after.result },
                  ].map((m) => (
                    <div key={m.title}>
                      <span className="csl-status">{m.title}</span>
                      <TippingMap map={mapView(m.title, scenario.map.x, scenario.map.y, (x, y) => m.sweep.get(x, y), currentCell(scenario))} />
                    </div>
                  ))}
                </div>
                <span style={{ fontSize: 13 }}>
                  {before.done === before.total && after.done === after.total ? moveSummary(scenario, before.result, after.result) : `${before.done + after.done} of ${before.total + after.total} runs done`}
                </span>
              </>
            ) : (
              <span className="csl-status">
                {!allTested ? 'Testing fixes; the best one is applied automatically.' : helped.length === 0 ? 'None of the fixes tried made this run recover.' : 'Apply a fix to see whether it moves the tipping point.'}
              </span>
            )}
          </div>
          <div data-tour="fix-tabs">
            {allTested && <FixTabs tabs={tabs} selectedId={selectedId ?? appliedId} onSelect={setSelectedId} appliedId={appliedId} onApply={apply} />}
          </div>
        </section>
        <div className="csl-split__slot" ref={setTimelineEl} />
      </div>
      <div className="csl-split__main" data-tour="replay">
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
            timelineTarget={timelineEl}
          />
        )}
        {applied && fixed.status === 'running' && (
          <section className="csl-card csl-card--compact">
            <p className="csl-status">Simulating the fix…</p>
          </section>
        )}
        {!applied && (
          <section className="csl-card csl-card--compact">
            <p className="csl-status">{allTested ? 'Pick a fix and press Apply & compare to see it side by side with the original run.' : 'Testing fixes…'}</p>
          </section>
        )}
      </div>
    </div>
  );
}

/** Short tab names for the catalogue's fixes (four tabs share a row; the full title is in the panel). */
const SHORT_NAMES: Record<string, string> = {
  'retry-budget': 'Retry budget',
  'cap-retries': 'Cap retries',
  'jitter-backoff': 'Jitter',
  'bound-queue': 'Bound queue',
  'drop-expired': 'Drop expired',
  'coalesce-misses': 'Coalesce',
  'longer-timeout': 'Timeout',
  'add-instances': 'Scale out',
};

function shortName(id: string): string {
  return SHORT_NAMES[id] ?? id;
}

function fixTab(f: RankedFix, original: FixOutcome, seeds: { helped: number; of: number } | undefined): FixTab {
  const o = f.outcome;
  return {
    id: f.candidate.id,
    short: shortName(f.candidate.id),
    title: f.candidate.title,
    why: f.candidate.why,
    result: `${capitalise(shortVerdict(original))} → ${shortVerdict(o)}`,
    // A fix that left the run stuck needs no badge: the tab's ✕ already says it did not help.
    badge: o.verdict === 'recovered' ? `${Math.round((o.recoveryMs ?? 0) / 1000)}s` : f.helped ? o.verdict : '',
    helped: f.helped,
    seeds: f.helped ? (seeds ? `helps in ${seeds.helped} of ${seeds.of} seeds` : 'checking other seeds…') : '',
    affected: `${o.failedRequests.toLocaleString()} failed requests (was ${original.failedRequests.toLocaleString()})`,
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
