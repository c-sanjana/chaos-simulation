import { useEffect, useMemo, useRef, useState } from 'react';
import type { RunConfig } from '../engine/config';
import type { RunResult } from '../engine/result';
import type { ScenarioPreset, TopologyPreset } from '../data/types';
import { applyFix } from '../fixes/candidates';
import { FIX_CATALOG } from '../fixes/catalog';
import { configChanges } from '../fixes/changes';
import { explainFix, type FixExplanation } from '../fixes/explain';
import { isReliable, withLongerOutage, type FixOutcome, type RankedFix, type Robustness } from '../fixes/rank';
import { buildSweep, tippingPoints, type SweepResult, type SweepSpec } from '../sweep/sweep';
import type { AnalyzeResult } from '../worker/jobs';
import type { SimPool } from '../worker/pool';
import { FixTabs, type FixTab } from './components/FixTabs';
import { PlayerPlaceholder } from './components/PlayerPlaceholder';
import { MapLegend, TippingMap } from './components/TippingMap';
import { currentCell, nearestCell, onMap } from './draft';
import { formatCount } from './format';
import { RunPlayer } from './RunPlayer';
import { useFixRanking } from './useFixRanking';
import { useAnalysis, useSweep, type Async } from './useSimulation';
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
  const finished = allTested && !ranking.checking;
  const helped = ranking.ranked.filter((f) => f.helped);
  // The best fix is selected once, when the checks finish, so nothing reselects under the viewer.
  const best = finished && helped.length > 0 ? helped[0].candidate.id : null;
  const appliedId = chosenId ?? best;
  const applied = ranking.ranked.find((f) => f.candidate.id === appliedId) ?? null;
  // The map cell shown before vs after in the replay: the current settings (or the nearest cell)
  // until the viewer clicks another.
  const current = currentCell(scenario);
  const [cell, setCell] = useState(() => nearestCell(scenario));
  useEffect(() => setCell(nearestCell(scenario)), [scenario]);
  const atCurrent = onMap(scenario) && cell.x === current.x && cell.y === current.y;

  // Requested before the maps' cells, so the panel's "why" and the replay at your settings don't
  // wait behind 120 map runs (the pool takes jobs in order).
  const fixedAtYours = useAnalysis(pool, applied ? applied.candidate.config : null, labels);
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
  // At the current settings the original run and the ranking's run of the fix are reused (the pool
  // keeps them); any other cell re-runs that cell's map settings, without and with the fix. The fix
  // at the viewer's settings is always asked for: the panel's "why it worked / didn't" is measured
  // there, whichever cell the replay shows.
  const beforeConfig = atCurrent ? config : cellConfig(beforeSpec, cell);
  const afterConfig = !applied ? null : atCurrent ? applied.candidate.config : cellConfig(afterSpec, cell);
  const beforeOther = useAnalysis(pool, atCurrent ? null : beforeConfig, labels);
  const fixedOther = useAnalysis(pool, atCurrent ? null : afterConfig, labels);
  const fixed = atCurrent ? fixedAtYours : fixedOther;
  const beforeRun = atCurrent ? (original ? { status: 'done' as const, value: original } : beforeOther) : beforeOther;
  const changes = useMemo(() => (beforeConfig && afterConfig ? configChanges(beforeConfig, afterConfig) : []), [beforeConfig, afterConfig]);
  const explanation = useMemo<FixExplanation | null>(() => {
    if (!applied || !original || fixedAtYours.status !== 'done') return null;
    const kind = FIX_CATALOG.find((d) => d.id === applied.candidate.id)!.kind;
    return explainFix(kind, applied.helped, { config, result: original }, { config: applied.candidate.config, result: fixedAtYours.value }, labels);
  }, [applied, original, fixedAtYours, config, labels]);

  // While the checks run, the tabs keep the order they had when testing finished, so they never
  // reorder under the viewer (or the tour); the final order appears once, with the best selected.
  const frozen = useRef<string[] | null>(null);
  if (!allTested || !ranking.checking) frozen.current = null;
  else frozen.current ??= ranking.ranked.map((f) => f.candidate.id);
  const order = frozen.current;
  const shownRanking = order ? [...ranking.ranked].sort((a, b) => order.indexOf(a.candidate.id) - order.indexOf(b.candidate.id)) : ranking.ranked;

  if (!original) return <p className="csl-status">Waiting for the original run…</p>;
  const { x: xAxis, y: yAxis } = scenario.map;
  const where = `at your settings (${current.x} req/s, ${axisPhrase(yAxis, current.y)})`;
  const longerS = ranking.longerApplies === false ? null : longerOutageSeconds(config);
  const failure = failureWord(config);
  const tabs = shownRanking.map((f) =>
    fixTab(f, ranking.original!, ranking.robustness[f.candidate.id], where, longerS, f === applied ? { explanation, before: original, after: fixedAtYours.status === 'done' ? fixedAtYours.value : null } : undefined, failure),
  );
  const cellTitle = `${cell.x} req/s · ${axisPhrase(yAxis, cell.y)}`;
  const mapsDone = before.result !== null && after.result !== null && before.done === before.total && after.done === after.total;
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
          <div className="csl-fix-maps__panel" aria-label="Did the tipping point move?" data-tour="fix-maps" data-tour-ready={(mapsDone && applied !== null) || (finished && helped.length === 0) || undefined}>
            <div className="csl-fix-maps__head">
              <h2 className="csl-section-title" style={{ margin: 0 }} id="csl-step-heading" tabIndex={-1}>
                Did the tipping point move?
              </h2>
              {/* Once everything is tested, the corner explains the map instead of the progress. */}
              <span className="csl-status">{finished && !ranking.error && applied ? '◆ = the run in the replay; select any cell' : status}</span>
            </div>
            {applied && before.result && after.result ? (
              <>
                <MapLegend showSelected={false} showMark={false} showPending={!mapsDone} />
                <div className="csl-fix-maps csl-map--medium">
                  {[
                    { title: 'Before', sweep: before.result },
                    { title: `After: ${applied.candidate.short}`, sweep: after.result },
                  ].map((m) => (
                    <div key={m.title}>
                      <span className="csl-status">{m.title}</span>
                      <TippingMap
                        map={{ ...mapView(m.title, xAxis, yAxis, (x, y) => m.sweep.get(x, y), cell), markLabel: 'shown in the replay' }}
                        selected={cell}
                        onSelect={(c) => setCell({ x: c.x, y: c.y })}
                        tips={m.sweep.done === m.sweep.total ? tippingPoints(m.sweep) : []}
                      />
                    </div>
                  ))}
                </div>
                {/* Here the ◆ follows the clicked cell (it marks what the replay shows), so it moves with every click. */}
                <span style={{ fontSize: 13 }}>
                  {mapsDone ? moveSummary(scenario, before.result, after.result) : `${before.done + after.done} of ${before.total + after.total} runs done`}
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
                    : ranking.checking
                      ? `Checking which fixes hold up: other random runs and a longer ${failure}…`
                      : helped.length === 0
                        ? original.analysis.recovery.verdict === 'recovered' || original.analysis.recovery.verdict === 'unaffected'
                          ? 'This run already recovers on its own, and none of the fixes made it recover faster.'
                          : 'None of the fixes tried made this run recover.'
                        : 'Choose a fix to see whether it moves the tipping point.'}
              </span>
            )}
          </div>
          <div data-tour="fix-tabs" data-tour-ready={finished || undefined}>
            {allTested && <FixTabs tabs={tabs} selectedId={appliedId} onSelect={setChosenId} />}
          </div>
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
            chartHeight={178}
            sideTimeline
            compactStory
          />
        )}
        {applied && (fixed.status === 'running' || beforeRun.status === 'running') && (
          <PlayerPlaceholder text={`Simulating ${cellTitle} without and with the fix…`} progress={meanProgress(fixed, beforeRun)} minHeight={FIX_PLAYER_HEIGHT} />
        )}
        {!applied && (
          <PlayerPlaceholder
            text={!finished ? 'Testing fixes…' : helped.length > 0 ? 'Choose a fix to see it side by side with the original run.' : 'No fix helped, so there is nothing to compare.'}
            minHeight={!finished ? FIX_PLAYER_HEIGHT : 0}
          />
        )}
      </div>
    </div>
  );
}

/** ASSUMPTION: about the height of the before/after player at 1440 × 900 (measured), so the page doesn't jump when it appears. */
const FIX_PLAYER_HEIGHT = 635;

/** How far along the two replays are together, once either reports progress (a finished one counts as done). */
export function meanProgress(...runs: Async<AnalyzeResult>[]): number | undefined {
  const parts = runs.map((r) => (r.status === 'running' ? r.progress : 1));
  if (!runs.some((r) => r.status === 'running' && r.progress !== undefined)) return undefined;
  return parts.reduce<number>((sum, p) => sum + (p ?? 0), 0) / runs.length;
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

/** "slowdown" when every failure is a slowdown, otherwise "failure" (a part going down is not a slowdown). */
export function failureWord(config: RunConfig): 'slowdown' | 'failure' {
  const faults = config.faults ?? [];
  return faults.length > 0 && faults.every((f) => f.kind === 'slow') ? 'slowdown' : 'failure';
}

/** A tier's queue messages dropped after their retries (dead-lettered), over the whole run. */
export function droppedMessages(run: RunResult): number {
  return Object.values(run.tiers).reduce((n, t) => n + t.deadLettered.reduce((a, b) => a + b, 0), 0);
}

/** A run's config has a message queue (only then can messages be dropped). */
const hasQueue = (run: RunResult) => Object.values(run.tiers).some((t) => t.consumers > 0);

/** A rare helper: helped in at most this many of the random runs checked, i.e. luck, not a fix. */
const RARE_SEEDS = 1;

/**
 * What the run with the fix at the viewer's settings showed (only for the fix shown): why it
 * worked or didn't, which pros and cons it contradicts, and the two runs (for dropped messages).
 */
export interface FixMeasured {
  explanation: FixExplanation | null;
  before: AnalyzeResult;
  after: AnalyzeResult | null;
}

/**
 * The tab and panel for one tested fix, measured at the viewer's settings (`where`). Drawbacks
 * measured in this run (more failures, helping only sometimes, not holding up with a longer
 * failure) come before the catalogue's general cons. A pro or con the run can contradict is shown
 * only once the run with the fix is measured (`measured`), and only if it didn't contradict it.
 */
export function fixTab(
  f: RankedFix,
  original: FixOutcome,
  robustness: Robustness | undefined,
  where: string,
  longerS: number | null,
  measured?: FixMeasured,
  failure: 'slowdown' | 'failure' = 'slowdown',
): FixTab {
  const o = f.outcome;
  const seeds = robustness?.seeds;
  const reliable = isReliable(robustness);
  // ASSUMPTION: helping in at most 1 of 5 random runs is luck: marked like a fix that didn't help (REVIEW2 3.2).
  const rare = f.helped && seeds !== undefined && seeds.of > 1 && seeds.helped <= RARE_SEEDS;
  const status: FixTab['status'] = !f.helped ? 'no' : rare ? 'rare' : reliable === null ? 'checking' : reliable ? 'reliable' : 'unreliable';
  const cons: string[] = [];
  if (o.failedRequests > original.failedRequests) {
    cons.push(`In this run more requests failed with it than without (${formatCount(o.failedRequests)} vs ${formatCount(original.failedRequests)})`);
  }
  if (f.helped && seeds && seeds.helped < seeds.of) cons.push(`Helped in only ${seeds.helped} of ${seeds.of} random runs, so the result depends on luck`);
  if (f.helped && robustness?.longer === false && longerS !== null) cons.push(`Didn't help when the ${failure} lasted ${longerS} s`);
  const checks: string[] = [];
  if (f.helped) {
    if (seeds) checks.push(`helped in ${seeds.helped} of ${seeds.of} random runs${seeds.alreadyFine ? ` (${seeds.alreadyFine} more recovered without it)` : ''}`);
    if (robustness?.longer !== undefined && longerS !== null) checks.push(robustness.longer ? `still helps if the ${failure} lasts ${longerS} s` : `doesn't help if it lasts ${longerS} s`);
    if (!seeds || (robustness?.longer === undefined && longerS !== null)) checks.push('checking whether it holds up…');
  }
  const unchanged = o.verdict === original.verdict && o.recoveryMs === original.recoveryMs;
  const refuted = measured?.explanation?.refuted ?? null;
  const shows = (claim: string) => {
    const by = f.candidate.refutable?.[claim];
    return by === undefined || (refuted !== null && !refuted.includes(by));
  };
  return {
    id: f.candidate.id,
    short: f.candidate.short,
    name: f.candidate.name,
    what: f.candidate.what,
    how: f.candidate.how,
    why: `${capitalise(f.candidate.why)}.`,
    ...(measured?.explanation ? { verdict: { title: measured.explanation.title, text: measured.explanation.text } } : {}),
    result: unchanged && !f.helped ? `No improvement: still ${shortVerdict(o)}` : `${capitalise(shortVerdict(original))} → ${shortVerdict(o)}`,
    where,
    failed: [failedText(o, original), ...(measured ? droppedText(measured) : [])].join(' · '),
    checks,
    // Only fixes that helped get a badge: the time back to normal after the failure ended.
    badge: f.helped && o.verdict === 'recovered' ? `${Math.round((o.recoveryMs ?? 0) / 1000)} s` : f.helped && o.verdict === 'unaffected' ? '0 s' : '',
    status,
    recoverySeconds: o.verdict === 'unaffected' ? 0 : o.verdict === 'recovered' ? Math.round((o.recoveryMs ?? 0) / 1000) : null,
    failedCount: o.failedRequests,
    pros: f.candidate.pros.filter(shows),
    cons: [...cons, ...f.candidate.cons.filter(shows)],
  };
}

function failedText(o: FixOutcome, original: FixOutcome): string {
  return o.failedRequests === original.failedRequests
    ? `no change: ${formatCount(o.failedRequests)} failed requests`
    : `${formatCount(o.failedRequests)} failed requests instead of ${formatCount(original.failedRequests)}`;
}

/**
 * Behind a queue, a message that keeps failing is dropped (dead-lettered): users never see it, but
 * it is work lost, so a queue fix's result counts it too (REVIEW2 1.12).
 */
function droppedText(m: FixMeasured): string[] {
  if (!m.after || !(hasQueue(m.before.run) || hasQueue(m.after.run))) return [];
  const [b, a] = [droppedMessages(m.before.run), droppedMessages(m.after.run)];
  if (a === 0 && b === 0) return [];
  return [a === b ? `no change: ${formatCount(a)} messages dropped` : `${formatCount(a)} messages dropped instead of ${formatCount(b)}`];
}

/**
 * One sentence on how the boundary moved for the current y value. When that value isn't one of
 * the map's rows (e.g. 7 retries on a 0–5 map), it says so and describes the nearest row instead.
 */
export function moveSummary(scenario: ScenarioPreset, before: SweepResult, after: SweepResult): string {
  const y = currentCell(scenario).y;
  const rowY = nearestCell(scenario).y;
  const row = (r: SweepResult) => tippingPoints(r).find((t) => t.y === rowY);
  const [rb, ra] = [row(before), row(after)];
  const [b, a] = [rb?.tipsAtX ?? null, ra?.tipsAtX ?? null];
  const fmt = (v: number) => axisPhrase(scenario.map.y, v);
  const at = rowY === y ? `With ${fmt(y)}` : `Your setting (${fmt(y)}) isn't on the map; with ${fmt(rowY)}`;
  // Overload (too much traffic even without the failure) is not recovering, but not a tipping point either.
  const overload = (rb?.overloadedFromX ?? null) !== null || (ra?.overloadedFromX ?? null) !== null;
  if (b === null && a === null) return overload ? `${at}, the failure never left the system stuck at the traffic shown, before or after.` : `${at}, the system recovered at every traffic level shown, before and after.`;
  if (a === null) return `${at}, the system used to tip at ${b} req/s; with the fix it ${overload ? 'never gets stuck at the traffic shown' : 'recovers at every traffic level shown'}.`;
  if (b === null) return `${at}, the fix makes it tip at ${a} req/s, where it used to ${overload ? 'never get stuck' : 'recover everywhere shown'}.`;
  if (a > b) return `${at}, the tipping point moves from ${b} to ${a} req/s.`;
  if (a < b) return `${at}, the tipping point moves down from ${b} to ${a} req/s: the fix makes this worse.`;
  return `${at}, the tipping point stays at ${b} req/s.`;
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
