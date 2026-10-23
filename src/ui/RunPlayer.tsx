import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { RunConfig } from '../engine/config';
import type { TopologyPreset } from '../data/types';
import type { AnalyzeResult } from '../worker/jobs';
import { ChartLegend } from './components/ChartLegend';
import { MetricTabs } from './components/MetricTabs';
import { PlaybackBar } from './components/PlaybackBar';
import { TimeSeriesChart } from './components/TimeSeriesChart';
import { Timeline } from './components/Timeline';
import { TopologyDiagram } from './components/TopologyDiagram';
import { usePlayback } from './components/usePlayback';
import { chartView, labelsOf, METRIC_TABS, shortVerdict, timelineView, topologyView, verdictView, type MetricTab } from './viewModels';

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
}

const COMPACT_CHART_HEIGHT = 175;

/**
 * Replays one computed run: topology with live flows, playback controls, metric charts and the
 * "why" timeline. In compare mode the charts overlay before and after, and the topology and
 * timeline switch between the two runs.
 */
export function RunPlayer({ title, subtitle, topology, config, result, after, autoPlay = true, onEdit, compact = false, timelineTarget, chartHeight, sideTimeline = false }: RunPlayerProps) {
  const labels = useMemo(() => labelsOf(topology), [topology]);
  const playback = usePlayback(result.run.durationMs, { speeds: [1, 4, 16] });
  // ASSUMPTION: 16× is the default (a 120 s run replays in ~8 s); 1× and 4× are there to slow down.
  const [tab, setTab] = useState<MetricTab>('throughput');
  const [scope, setScope] = useState<string | null>(null);
  const [showAfter, setShowAfter] = useState(true);

  // Every new run replays from the start (and plays by itself unless told not to), so the live
  // timeline always tells that run's story from the beginning.
  useEffect(() => {
    playback.seek(0);
    playback.setSpeed(16);
    if (autoPlay) playback.play();
  }, [result, after?.result]); // eslint-disable-line react-hooks/exhaustive-deps

  // Chart data is rebuilt only when what it shows changes, so the playhead can move every frame cheaply.
  const chart = useMemo(() => chartView(tab, config, result.run, labels, scope, after?.result.run), [tab, config, result, labels, scope, after]);
  const shown = after && showAfter ? after : { config, result };
  const { nodes, edges } = topologyView(topology, shown.config, shown.result.run, playback.tMs);
  const verdict = verdictView(result.analysis.recovery);
  const chip = after
    ? { text: `${capitalise(shortVerdict(summary(result)))} → ${shortVerdict(summary(after.result))}`, tone: verdictView(after.result.analysis.recovery).tone }
    : verdict;
  const failureWindowsMs = (config.faults ?? []).map((f) => [f.startMs, f.endMs] as [number, number]);
  const timeline = (
    <section className="csl-timeline-window" data-tour="timeline" aria-label="Live timeline">
      <h3 className="csl-timeline-title">Why: live timeline{after ? (showAfter ? ' (after the fix)' : ' (before the fix)') : ''}</h3>
      <div className="csl-timeline-window__body">
        <Timeline entries={timelineView(shown.result.analysis)} nowMs={playback.tMs} />
      </div>
    </section>
  );

  return (
    <section className={`csl-card${compact ? ' csl-card--compact' : ''}`} aria-label={title}>
      <div className="csl-card__head">
        <div>
          <h2 className="csl-card__title">{title}</h2>
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
        note={`Snapshot at t = ${Math.floor(playback.tMs / 1000)} s${after ? (showAfter ? ', after the fix' : ', before the fix') : ''}.${onEdit ? ' Click a box to edit that tier.' : ''}`}
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

      <div className="csl-player__body">
        <div className="csl-player__charts" data-tour="charts">
          <MetricTabs
            tabs={METRIC_TABS}
            selected={tab}
            onSelect={(id) => setTab(id as MetricTab)}
            scopeLabel={chart.scopeLabel}
            scopes={[{ id: 'client', label: 'End to end' }, ...shown.config.tiers.map((t) => ({ id: t.id, label: labels[t.id] ?? t.id }))]}
            scope={scope ?? 'client'}
            onScope={(id) => setScope(id === 'client' ? null : id)}
          />
          <div className={`csl-player__chartrow${sideTimeline ? ' csl-player__chartrow--side' : ''}`}>
            <div className="csl-player__chart">
              <ChartLegend series={chart.spec.series} />
              <TimeSeriesChart {...chart.spec} playheadS={playback.tMs / 1000} revealS={playback.tMs / 1000} height={chartHeight ?? (compact ? COMPACT_CHART_HEIGHT : undefined)} />
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

function summary(r: AnalyzeResult) {
  return { verdict: r.analysis.recovery.verdict, recoveryMs: r.analysis.recovery.recoveryMs };
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
