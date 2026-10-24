import { useEffect, useMemo, useState } from 'react';
import type { RunConfig } from '../engine/config';
import type { ScenarioPreset, TopologyPreset } from '../data/types';
import { applyFix } from '../fixes/candidates';
import { FIX_CATALOG } from '../fixes/catalog';
import { configChanges } from '../fixes/changes';
import { isReliable, withLongerOutage, type FixOutcome, type RankedFix, type Robustness } from '../fixes/rank';
import { buildSweep, tippingPoints, type SweepResult, type SweepSpec } from '../sweep/sweep';
import type { AnalyzeResult } from '../worker/jobs';
import type { SimPool } from '../worker/pool';
import { FixTabs, type FixTab } from './components/FixTabs';
import { TippingMap } from './components/TippingMap';
import { currentCell, nearestCell, onMap } from './draft';
import { RunPlayer } from './RunPlayer';
import { useFixRanking } from './useFixRanking';
import { useAnalysis, useSweep } from './useSimulation';
import { axisPhrase, formatAxisValue, mapView, shortVerdict } from './viewModels';

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

/**
 * Step 3: fixes ranked by measured effect and how well they hold up. Choosing a fix shows it
 * everywhere: its details, the before/after maps and the before/after replay (of any map cell).
 */
export function FixStep({ pool, topology, scenario, config, original, labels, onEdit }: FixStepProps) {
  const ranking = useFixRanking(pool, config, original?.analysis ?? null, labels);
  /** The viewer's pick; until then the best fix is shown once the checks are done. */
  const [chosenId, setChosenId] = useState<string | null>(null);
  useEffect(() => setChosenId(null), [config]);
  const allTested = ranking.original !== null && ranking.tested === ranking.candidates.length;
  const helped = ranking.ranked.filter((f) => f.helped);
  const best = allTested && !ranking.checking && helped.length > 0 ? helped[0].candidate.id : null;
  const appliedId = chosenId ?? best;
  const applied = ranking.ranked.find((f) => f.candidate.id === appliedId) ?? null;
  // The map cell shown before vs after on the right: the current settings (or the nearest cell)
  // until the viewer clicks another.
  const current = currentCell(scenario);
  const [cell, setCell] = useState(() => nearestCell(scenario));
  useEffect(() => setCell(nearestCell(scenario)), [scenario]);
  const atCurrent = onMap(scenario) && cell.x === current.x && cell.y === current.y;

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
  // At the current settings the original run is reused; any other cell re-runs that cell's map
  // settings, without and with the fix.
  const beforeConfig = atCurrent ? config : cellConfig(beforeSpec, cell);
  const afterConfig = !applied ? null : atCurrent ? applied.candidate.config : cellConfig(afterSpec, cell);
  const beforeOther = useAnalysis(pool, atCurrent ? null : beforeConfig, labels);
  const fixed = useAnalysis(pool, afterConfig, labels);
  const beforeRun = atCurrent ? (original ? { status: 'done' as const, value: original } : beforeOther) : beforeOther;
  const changes = useMemo(() => (beforeConfig && afterConfig ? configChanges(beforeConfig, afterConfig) : []), [beforeConfig, afterConfig]);

  if (!original) return <p className="csl-status">Waiting for the original run…</p>;
  const { x: xAxis, y: yAxis } = scenario.map;
  const where = `at your settings (${current.x} req/s, ${axisPhrase(yAxis, current.y)})`;
  const longerS = ranking.longerApplies === false ? null : longerOutageSeconds(config);
  const tabs = ranking.ranked.map((f) => fixTab(f, ranking.original!, ranking.robustness[f.candidate.id], where, longerS));
  const cellTitle = `${cell.x} req/s · ${axisPhrase(yAxis, cell.y)}`;
  const status = ranking.error ? (
    <span className="csl-error">{ranking.error}</span>
  ) : !allTested ? (
    `Testing fixes: ${ranking.tested} of ${ranking.candidates.length}`
  ) : ranking.checking ? (
    'Checking which fixes hold up…'
  ) : (
    `${ranking.candidates.length} fixes tested`
  );

  return (
    <div className="csl-split csl-split--stretch">
      <div className="csl-split__col csl-split__side csl-split__side--wide">
        <section className="csl-card csl-card--compact" aria-label="Fixes">
          <div className="csl-fix-maps__panel" aria-label="Did the tipping point move?" data-tour="fix-maps">
            <div className="csl-fix-maps__head">
              <h2 className="csl-section-title" style={{ margin: 0 }}>
                Did the tipping point move?
              </h2>
              {/* Once everything is tested, the corner explains the map instead of the progress. */}
              <span className="csl-status">{allTested && !ranking.checking && !ranking.error && applied ? '◆ = shown on the right; click any cell' : status}</span>
            </div>
            {applied && before.result && after.result ? (
              <>
                <div className="csl-fix-maps csl-map--medium">
                  {[
                    { title: 'Before', sweep: before.result },
                    { title: `After: ${applied.candidate.short}`, sweep: after.result },
                  ].map((m) => (
                    <div key={m.title}>
                      <span className="csl-status">{m.title}</span>
                      <TippingMap map={{ ...mapView(m.title, xAxis, yAxis, (x, y) => m.sweep.get(x, y), cell), markLabel: 'shown on the right' }} selected={cell} onSelect={(c) => setCell({ x: c.x, y: c.y })} />
                    </div>
                  ))}
                </div>
                {/* Here the ◆ follows the clicked cell (it marks what the replay shows), so it moves with every click. */}
                <span style={{ fontSize: 13 }}>
                  {before.done === before.total && after.done === after.total ? moveSummary(scenario, before.result, after.result) : `${before.done + after.done} of ${before.total + after.total} runs done`}
                  {!atCurrent && onMap(scenario) && (
                    <>
                      {' '}
                      <button type="button" className="csl-btn csl-btn--link csl-fix-maps__back" onClick={() => setCell(current)}>
                        Back to your settings ({current.x} req/s · {formatAxisValue(yAxis, current.y)} {yAxis.label})
                      </button>
                    </>
                  )}
                </span>
              </>
            ) : (
              <span className="csl-status">
                {!allTested
                  ? 'Testing fixes; the most reliable one is shown automatically.'
                  : ranking.candidates.length === 0
                    ? noFixesMessage(original)
                    : helped.length === 0
                      ? original.analysis.recovery.verdict === 'recovered' || original.analysis.recovery.verdict === 'unaffected'
                        ? 'This run already recovers on its own, and none of the fixes made it recover faster.'
                        : 'None of the fixes tried made this run recover.'
                      : ranking.checking
                        ? 'Checking which fixes hold up: other random runs and a longer slowdown…'
                        : 'Choose a fix to see whether it moves the tipping point.'}
              </span>
            )}
          </div>
          <div data-tour="fix-tabs">{allTested && <FixTabs tabs={tabs} selectedId={appliedId} onSelect={setChosenId} />}</div>
        </section>
      </div>
      <div className="csl-split__main" data-tour="replay">
        {applied && afterConfig && beforeConfig && fixed.status === 'done' && beforeRun.status === 'done' && (
          <RunPlayer
            title={`Before vs after: ${applied.candidate.name}`}
            subtitle={`${cellTitle}${atCurrent ? ' (yours)' : ''} · only the fix differs`}
            topology={topology}
            config={beforeConfig}
            result={beforeRun.value}
            after={{ config: afterConfig, result: fixed.value }}
            changes={changes}
            onEdit={onEdit}
            compact
            chartHeight={155}
            sideTimeline
          />
        )}
        {applied && (fixed.status === 'running' || beforeRun.status === 'running') && (
          <section className="csl-card csl-card--compact">
            <p className="csl-status">Simulating {cellTitle} without and with the fix…</p>
          </section>
        )}
        {!applied && (
          <section className="csl-card csl-card--compact">
            <p className="csl-status">
              {!allTested || ranking.checking ? 'Testing fixes…' : helped.length > 0 ? 'Choose a fix to see it side by side with the original run.' : 'No fix helped, so there is nothing to compare.'}
            </p>
          </section>
        )}
      </div>
    </div>
  );
}

/** Why there is nothing to try, in plain words. */
function noFixesMessage(original: AnalyzeResult): string {
  const v = original.analysis.recovery.verdict;
  if (v === 'unaffected' || v === 'recovered') return 'This run recovers on its own, and nothing in it points to a fix worth trying.';
  return 'Nothing in this run points to a fix in the catalogue.';
}

/** How long the slowdown lasts in the "longer slowdown" check, in seconds (null when it can't be checked). */
function longerOutageSeconds(config: RunConfig): number | null {
  const longer = withLongerOutage(config);
  const f = longer?.faults?.[0];
  return f ? Math.round((f.endMs - f.startMs) / 1000) : null;
}

/** A map cell's run config from a sweep spec (null until the spec exists). */
function cellConfig(spec: SweepSpec | null, cell: { x: number; y: number }): RunConfig | null {
  return spec?.cells.find((c) => c.x === cell.x && c.y === cell.y)?.config ?? null;
}

/**
 * The tab and panel for one tested fix, measured at the viewer's settings (`where`). Drawbacks
 * measured in this run (more failures, helping only sometimes, not holding up with a longer
 * slowdown) come before the catalogue's general cons.
 */
export function fixTab(f: RankedFix, original: FixOutcome, robustness: Robustness | undefined, where: string, longerS: number | null): FixTab {
  const o = f.outcome;
  const seeds = robustness?.seeds;
  const reliable = isReliable(robustness);
  const status: FixTab['status'] = !f.helped ? 'no' : reliable === null ? 'checking' : reliable ? 'reliable' : 'unreliable';
  const measured: string[] = [];
  if (o.failedRequests > original.failedRequests) {
    measured.push(`In this run more requests failed with it than without (${o.failedRequests.toLocaleString()} vs ${original.failedRequests.toLocaleString()})`);
  }
  if (f.helped && seeds && seeds.helped < seeds.of) measured.push(`Helped in only ${seeds.helped} of ${seeds.of} random runs, so the result depends on luck`);
  if (f.helped && robustness?.longer === false && longerS !== null) measured.push(`Didn't help when the slowdown lasted ${longerS} s`);
  const checks: string[] = [];
  if (f.helped) {
    if (seeds) checks.push(`helped in ${seeds.helped} of ${seeds.of} random runs${seeds.alreadyFine ? ` (${seeds.alreadyFine} more recovered without it)` : ''}`);
    if (robustness?.longer !== undefined && longerS !== null) checks.push(robustness.longer ? `still helps if the slowdown lasts ${longerS} s` : `doesn't help if it lasts ${longerS} s`);
    if (!seeds || (robustness?.longer === undefined && longerS !== null)) checks.push('checking whether it holds up…');
  }
  const unchanged = o.verdict === original.verdict && o.recoveryMs === original.recoveryMs;
  return {
    id: f.candidate.id,
    short: f.candidate.short,
    name: f.candidate.name,
    what: f.candidate.what,
    how: f.candidate.how,
    why: `${capitalise(f.candidate.why)}.`,
    result: unchanged && !f.helped ? `No improvement: still ${shortVerdict(o)}` : `${capitalise(shortVerdict(original))} → ${shortVerdict(o)}`,
    where,
    failed:
      o.failedRequests === original.failedRequests
        ? `no change: ${o.failedRequests.toLocaleString()} failed requests`
        : `${o.failedRequests.toLocaleString()} failed requests instead of ${original.failedRequests.toLocaleString()}`,
    checks,
    // Only fixes that helped get a badge: the time back to normal after the failure ended.
    badge: f.helped && o.verdict === 'recovered' ? `${Math.round((o.recoveryMs ?? 0) / 1000)} s` : f.helped && o.verdict === 'unaffected' ? '0 s' : '',
    status,
    pros: f.candidate.pros,
    cons: [...measured, ...f.candidate.cons],
  };
}

/**
 * One sentence on how the boundary moved for the current y value. When that value isn't one of
 * the map's rows (e.g. 7 retries on a 0–5 map), it says so and describes the nearest row instead.
 */
export function moveSummary(scenario: ScenarioPreset, before: SweepResult, after: SweepResult): string {
  const y = currentCell(scenario).y;
  const rowY = nearestCell(scenario).y;
  const tip = (r: SweepResult) => tippingPoints(r).find((t) => t.y === rowY)?.tipsAtX ?? null;
  const [b, a] = [tip(before), tip(after)];
  const fmt = (v: number) => axisPhrase(scenario.map.y, v);
  const at = rowY === y ? `With ${fmt(y)}` : `Your setting (${fmt(y)}) isn't on the map; with ${fmt(rowY)}`;
  if (b === null && a === null) return `${at}, the system recovered at every traffic level shown, before and after.`;
  if (a === null) return `${at}, the system used to tip at ${b} req/s; with the fix it recovers at every traffic level shown.`;
  if (b === null) return `${at}, the fix makes it tip at ${a} req/s, where it used to recover everywhere shown.`;
  if (a > b) return `${at}, the tipping point moves from ${b} to ${a} req/s.`;
  if (a < b) return `${at}, the tipping point moves down from ${b} to ${a} req/s: the fix makes this worse.`;
  return `${at}, the tipping point stays at ${b} req/s.`;
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
