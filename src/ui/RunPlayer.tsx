import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { spokenName } from '../analysis/helpers';
import type { Fault, RunConfig } from '../engine/config';
import type { TopologyPreset } from '../data/types';
import type { AnalyzeResult } from '../worker/jobs';
import { useAnnounce } from './components/Announcer';
import { ChartLegend } from './components/ChartLegend';
import { chartSummary, ChartTable } from './components/ChartText';
import { MetricTabs } from './components/MetricTabs';
import { PlaybackBar } from './components/PlaybackBar';
import { CHART_HEIGHT, TimeSeriesChart } from './components/TimeSeriesChart';
import { EventTrack } from './components/EventTrack';
import { StoryCard, type StoryStepView } from './components/StoryCard';
import { TopologyDiagram } from './components/TopologyDiagram';
import { usePlayback } from './components/usePlayback';
import { usePrefersReducedMotion } from './useMediaQuery';
import { chartView, labelsOf, METRIC_TABS, shortVerdict, timelineView, topologyView, verdictView, type ChangeLabel, type MetricTab } from './viewModels';

export interface RunPlayerProps {
  title: string;
  subtitle: string;
  topology: TopologyPreset;
  config: RunConfig;
  result: AnalyzeResult;
  /** Compare mode: the same failure with a fix applied (its own config and result). */
  after?: { config: RunConfig; result: AnalyzeResult };
  /** Start playing whenever a new run arrives (default). */
  autoPlay?: boolean;
  /** Opens settings: a tier id from clicking its box in the diagram, or null for every setting. */
  onEdit?: (tierId: string | null) => void;
  /** Smaller topology and chart, for side-by-side layouts. */
  compact?: boolean;
  /** Render the live timeline into this element (e.g. a column beside the player) instead of inside it. */
  timelineTarget?: HTMLElement | null;
  /** Chart height in px (defaults: full layout 240, compact 175). */
  chartHeight?: number;
  /** Show the live timeline beside the chart (under the metric tabs), as tall as the chart. */
  sideTimeline?: boolean;
  /** Keep the replay at the start and paused (e.g. while the guided tour is open); it plays when released. */
  holdPlayback?: boolean;
  /**
   * Guide a first-time viewer through the key moment: slow to 4× just before the failure and pause
   * just after it ends, with a callout ("back to normal speed: does the system recover?").
   */
  guided?: boolean;
  /** The run told in plain words, revealed as the replay reaches each step (shown above the timeline). */
  story?: StoryStepView[];
  /** What the fix changed (compare mode), labelled on the "after" diagram. */
  changes?: ChangeLabel[];
  /** Shown above the story once the replay has reached the end (e.g. the comparison with the last run). */
  endPanel?: ReactNode;
  /**
   * The guided demo's moment (ms into the run), or null: the replay plays forward to it and pauses
   * there (a moment behind the replay is jumped to). The guided pause is off meanwhile.
   */
  demoAtMs?: number | null;
  /** id for the title heading, which can then take focus (e.g. after a re-run). */
  headingId?: string;
  /** Show the story (and end panel) above the chart instead of with the timeline, e.g. on narrow screens where the side column is far below. */
  storyAbove?: boolean;
}

const COMPACT_CHART_HEIGHT = 175;

/**
 * Replays one computed run: topology with live flows, playback controls, metric charts and the
 * "why" timeline. In compare mode the charts overlay before and after, and the topology and
 * timeline switch between the two runs.
 */
export function RunPlayer({
  title,
  subtitle,
  topology,
  config,
  result,
  after,
  autoPlay = true,
  onEdit,
  compact = false,
  timelineTarget,
  chartHeight,
  sideTimeline = false,
  holdPlayback = false,
  guided = false,
  story,
  changes = [],
  endPanel,
  demoAtMs = null,
  headingId,
  storyAbove = false,
}: RunPlayerProps) {
  const labels = useMemo(() => labelsOf(topology), [topology]);
  const playback = usePlayback(result.run.durationMs, { speeds: [1, 4, 16] });
  // ASSUMPTION: 16× is the default (a 120 s run replays in ~8 s); 1× and 4× are there to slow down.
  // With reduced motion the replay waits for Play and runs at 4×.
  const reducedMotion = usePrefersReducedMotion();
  const startSpeed = reducedMotion ? 4 : 16;
  // Load & retries first: retries piling up over capacity is the heart of the story.
  const [tab, setTab] = useState<MetricTab>('load');
  const [scope, setScope] = useState<string | null>(null);
  const [showAfter, setShowAfter] = useState(true);

  // Every new run replays from the start (and plays by itself unless told not to or held), so the
  // live timeline always tells that run's story from the beginning.
  const faults = config.faults ?? [];
  const guidePauseMs = guided && !after && faults.length > 0 ? Math.max(...faults.map((f) => f.endMs)) + 1500 : null;
  const guideSlowMs = guidePauseMs === null ? null : Math.min(...faults.map((f) => f.startMs)) - 3000;
  const [guide, setGuide] = useState<'pending' | 'slowed' | 'paused' | 'done'>('pending');
  useEffect(() => {
    playback.seek(0);
    playback.setSpeed(startSpeed);
    setGuide('pending');
    if (autoPlay && !holdPlayback && !reducedMotion) playback.play();
    else playback.pause();
  }, [result, after?.result, holdPlayback]); // eslint-disable-line react-hooks/exhaustive-deps

  // The demo: play forward to its moment (briskly over long stretches), or jump back to it.
  useEffect(() => {
    if (demoAtMs === null) return;
    if (demoAtMs <= playback.tMs) {
      playback.seek(demoAtMs);
      playback.pause();
      return;
    }
    playback.setSpeed(demoAtMs - playback.tMs > 15_000 ? 16 : 4);
    playback.play();
  }, [demoAtMs, result]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (demoAtMs !== null && playback.playing && playback.tMs >= demoAtMs) {
      playback.pause();
      playback.seek(demoAtMs);
    }
  }, [playback.tMs]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (demoAtMs !== null) return; // the demo moves the replay itself
    if (guidePauseMs === null || guideSlowMs === null || !playback.playing || guide === 'paused' || guide === 'done') return;
    if (playback.tMs > guidePauseMs + 3000) setGuide('done'); // the viewer scrubbed past it
    else if (playback.tMs >= guidePauseMs) {
      playback.pause();
      setGuide('paused');
    } else if (guide === 'pending' && playback.tMs >= guideSlowMs && playback.speed === 16) {
      playback.setSpeed(4);
      setGuide('slowed');
    }
  }, [playback.tMs, playback.playing]); // eslint-disable-line react-hooks/exhaustive-deps
  // Once the replay has reached the end (for this run), the end panel stays.
  const [ended, setEnded] = useState(false);
  useEffect(() => setEnded(false), [result, after?.result]);
  useEffect(() => {
    if (playback.tMs >= result.run.durationMs) setEnded(true);
  }, [playback.tMs, result.run.durationMs]);
  const keepWatching = () => {
    setGuide('done');
    playback.setSpeed(startSpeed);
    playback.play();
  };

  // Chart data is rebuilt only when what it shows changes, so the playhead can move every frame cheaply.
  const plotHeight = chartHeight ?? (compact ? COMPACT_CHART_HEIGHT : CHART_HEIGHT);
  const chart = useMemo(() => chartView(tab, config, result.run, labels, scope, after?.result.run, undefined, showAfter), [tab, config, result, labels, scope, after, showAfter]);
  const shown = after && showAfter ? after : { config, result };
  // The default scope already is one tier ("DB (most overloaded)"), so that tier isn't listed twice.
  const scopeShown = scope === chart.defaultScopeId ? 'client' : (scope ?? 'client');
  const [asTable, setAsTable] = useState(false);
  const summaryId = useId();
  const revealS = Math.floor(playback.tMs / 1000);
  const shownSpec = useMemo(() => ({ ...chart.spec, revealS }), [chart.spec, revealS]);
  const summaryText = useMemo(() => chartSummary(shownSpec), [shownSpec]);
  const { nodes, edges } = topologyView(topology, shown.config, shown.result.run, playback.tMs, after && showAfter ? changes : []);
  // The verdict is revealed when the replay gets there, not given away at the start.
  const recovery = result.analysis.recovery;
  const verdictAtMs = verdictRevealMs(recovery, result.run.durationMs);
  const chip = after
    ? { text: `${capitalise(shortVerdict(summary(result)))} → ${shortVerdict(summary(after.result))}`, tone: verdictView(after.result.analysis.recovery).tone }
    : playback.tMs >= verdictAtMs
      ? verdictView(recovery)
      : { text: 'Replaying… the verdict comes when the replay gets there', tone: 'neutral' as const };
  useAnnouncements(story, playback.tMs, chip.tone === 'neutral' ? null : after ? compareWords(result, after.result) : chip.text, guide === 'paused' ? `Paused: the failure is over: ${failureOverText(faults, labels)}. Watch whether the system recovers.` : null);
  const failureWindowsMs = (config.faults ?? []).map((f) => [f.startMs, f.endMs] as [number, number]);
  const timelineWindow = (
    <section className="csl-timeline-window" data-tour="timeline" aria-label="Live timeline">
      <h3 className="csl-timeline-title">
        {story ? 'Details: what was measured' : 'Why: live timeline'}
        {after ? (showAfter ? ' (after the fix)' : ' (before the fix)') : ''}
      </h3>
      <div className="csl-timeline-window__body">
        <EventTrack entries={timelineView(shown.result.analysis)} nowMs={playback.tMs} failureWindows={failureWindowsMs} />
      </div>
    </section>
  );
  const storyPart = (
    <>
      {ended && endPanel}
      {story && <StoryCard steps={story} nowMs={playback.tMs} />}
    </>
  );
  const timeline = (
    <>
      {!storyAbove && storyPart}
      {timelineWindow}
    </>
  );

  return (
    <section className={`csl-card csl-player${compact ? ' csl-card--compact' : ''}`} aria-label={title}>
      <div className="csl-card__head">
        <div>
          <h2 className="csl-card__title" id={headingId} tabIndex={headingId ? -1 : undefined}>
            {title}
          </h2>
          <p className="csl-card__sub">{subtitle}</p>
        </div>
        <div className="csl-row" style={{ gap: 10, alignItems: 'center' }}>
          {after && (
            <div className="csl-segmented" role="group" aria-label="Show run">
              <button type="button" aria-pressed={!showAfter} onClick={() => setShowAfter(false)}>
                Before
              </button>
              <button type="button" aria-pressed={showAfter} onClick={() => setShowAfter(true)}>
                After
              </button>
            </div>
          )}
          <span className={`csl-chip csl-chip--${chip.tone}`}>{chip.text}</span>
        </div>
      </div>

      <div data-tour="topology">
      <TopologyDiagram
        nodes={nodes}
        edges={edges}
        selectedId={null}
        onSelect={(id) => onEdit?.(id)}
        editable={onEdit !== undefined}
        compact={compact}
        note={`Snapshot at t = ${Math.floor(playback.tMs / 1000)} s${after ? (showAfter ? ', after the fix' : ', before the fix') : ''}.${onEdit ? ' Select a box to edit that tier.' : ''}`}
        actions={
          onEdit && (
            <button type="button" className="csl-btn csl-btn--small" onClick={() => onEdit(null)}>
              ⚙ Edit all settings
            </button>
          )
        }
      />
      </div>

      <div data-tour="playback">
      <PlaybackBar
        tMs={playback.tMs}
        durationMs={result.run.durationMs}
        playing={playback.playing}
        speed={playback.speed}
        speeds={playback.speeds}
        failureWindows={failureWindowsMs}
        onPlayPause={playback.toggle}
        onSeek={playback.seek}
        onSpeed={playback.setSpeed}
      />
      </div>

      {storyAbove && story && <div className="csl-player__story">{storyPart}</div>}

      <div className="csl-player__body">
        <div className="csl-player__charts" data-tour="charts">
          <MetricTabs
            tabs={METRIC_TABS}
            selected={tab}
            onSelect={(id) => setTab(id as MetricTab)}
            scopeLabel={chart.scopeLabel}
            scopes={[{ id: 'client', label: chart.defaultScopeLabel }, ...shown.config.tiers.filter((t) => t.id !== chart.defaultScopeId).map((t) => ({ id: t.id, label: labels[t.id] ?? t.id }))]}
            scope={scopeShown}
            onScope={(id) => setScope(id === 'client' ? null : id)}
          />
          <div className={`csl-player__chartrow${sideTimeline ? ' csl-player__chartrow--side' : ''}`}>
            <div className="csl-player__chart">
              {guide === 'paused' && (
                <div className="csl-guide">
                  <span>
                    ⏸ <b>The failure is over: {failureOverText(faults, labels)}.</b> Watch whether the system recovers.
                  </span>
                  <button type="button" className="csl-btn csl-btn--primary csl-btn--small" onClick={keepWatching}>
                    ▶ Keep watching
                  </button>
                </div>
              )}
              <ChartLegend
                series={chart.spec.series}
                extra={
                  <li className="csl-legend__item csl-legend__table">
                    <button type="button" className="csl-btn csl-btn--link csl-chart-toggle" aria-pressed={asTable} onClick={() => setAsTable((t) => !t)}>
                      {asTable ? 'Show as chart' : 'Show as table'}
                    </button>
                  </li>
                }
              />
              <p id={summaryId} className="csl-sr-only">
                {summaryText}
              </p>
              {asTable ? (
                <ChartTable spec={shownSpec} height={plotHeight} />
              ) : (
                <TimeSeriesChart {...chart.spec} playheadS={playback.tMs / 1000} revealS={playback.tMs / 1000} height={plotHeight} describedBy={summaryId} />
              )}
            </div>
            {sideTimeline && <div className="csl-player__timeline csl-player__timeline--side">{timeline}</div>}
          </div>
        </div>
        {!sideTimeline && timelineTarget === undefined && <div className="csl-player__timeline">{timeline}</div>}
      </div>
      {timelineTarget && createPortal(timeline, timelineTarget)}
    </section>
  );
}

/** What "the failure is over" means for the failure that ends last, e.g. "the database is back to normal speed". */
export function failureOverText(faults: Fault[], labels: Record<string, string>): string {
  const last = faults.reduce((a, f) => (f.endMs > a.endMs ? f : a));
  const who = spokenName(last.tier, labels);
  if (last.kind === 'slow') return `${who} is back to normal speed`;
  if (last.flushAtEnd) return `${who} is back up, but empty`;
  return `${who} is back up`;
}

/** When the replay has shown enough to state the verdict: recovery, or the end of what is judged. */
export function verdictRevealMs(r: AnalyzeResult['analysis']['recovery'], durationMs: number): number {
  if (r.verdict === 'recovered') return r.lastFaultEndMs + (r.recoveryMs ?? 0);
  if (r.verdict === 'unaffected') return r.lastFaultEndMs;
  return Math.min(durationMs, r.judgedUntilMs);
}

/**
 * Says the story steps as the replay reveals them, the verdict once it is shown, and the guided
 * pause, in the page's live region (throttled there). Seeking back re-arms the steps quietly.
 */
function useAnnouncements(story: StoryStepView[] | undefined, nowMs: number, verdict: string | null, pause: string | null) {
  const announce = useAnnounce();
  const shown = story ? story.filter((s) => s.tMs <= nowMs) : [];
  const said = useRef(0);
  const saidFor = useRef(story);
  const count = shown.length;
  useEffect(() => {
    if (saidFor.current !== story) {
      // A new run: the replay is about to restart, so nothing from the old position is said.
      saidFor.current = story;
      said.current = count;
      return;
    }
    if (count > said.current) announce(shown.slice(said.current).map((s) => s.text).join(' '));
    said.current = count;
  }, [count, story]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (verdict) announce(verdict, 'verdict');
  }, [verdict, announce]);
  useEffect(() => {
    if (pause) announce(pause, 'pause');
  }, [pause, announce]);
}

/** The compare chip in words: "Before the fix: stuck. After the fix: recovers in 16 s." */
function compareWords(before: AnalyzeResult, after: AnalyzeResult): string {
  return `Before the fix: ${shortVerdict(summary(before))}. After the fix: ${shortVerdict(summary(after))}.`;
}

function summary(r: AnalyzeResult) {
  return { verdict: r.analysis.recovery.verdict, recoveryMs: r.analysis.recovery.recoveryMs };
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
