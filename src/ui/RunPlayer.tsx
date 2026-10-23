import { useEffect, useMemo, useState } from 'react';
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
  /** Start playing on mount (used for the first run the reviewer sees). */
  autoPlay?: boolean;
}

/**
 * Replays one computed run: topology with live flows, playback controls, metric charts and the
 * "why" timeline. In compare mode the charts overlay before and after, and the topology and
 * timeline switch between the two runs.
 */
export function RunPlayer({ title, subtitle, topology, config, result, after, autoPlay = false }: RunPlayerProps) {
  const labels = useMemo(() => labelsOf(topology), [topology]);
  const playback = usePlayback(result.run.durationMs, { speeds: [1, 4, 16] });
  const [tab, setTab] = useState<MetricTab>('throughput');
  const [scope, setScope] = useState<string | null>(null);
  const [showAfter, setShowAfter] = useState(true);

  useEffect(() => {
    if (!autoPlay) return;
    playback.setSpeed(4);
    playback.play();
    // Only on mount: later changes are the viewer's to make.
  }, []);

  // Chart data is rebuilt only when what it shows changes, so the playhead can move every frame cheaply.
  const chart = useMemo(() => chartView(tab, config, result.run, labels, scope, after?.result.run), [tab, config, result, labels, scope, after]);
  const shown = after && showAfter ? after : { config, result };
  const { nodes, edges } = topologyView(topology, shown.config, shown.result.run, playback.tMs);
  const verdict = verdictView(result.analysis.recovery);
  const chip = after
    ? { text: `${capitalise(shortVerdict(summary(result)))} → ${shortVerdict(summary(after.result))}`, tone: verdictView(after.result.analysis.recovery).tone }
    : verdict;
  const failureWindowsMs = (config.faults ?? []).map((f) => [f.startMs, f.endMs] as [number, number]);

  return (
    <section className="csl-card" aria-label={title}>
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

      <TopologyDiagram
        nodes={nodes}
        edges={edges}
        selectedId={scope ?? 'client'}
        onSelect={(id) => setScope(id === 'client' ? null : id)}
        note={`Snapshot at t = ${Math.floor(playback.tMs / 1000)} s${after ? (showAfter ? ', after the fix' : ', before the fix') : ''}. Click a tier to scope the charts to it.`}
      />

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

      <div className="csl-player__body">
        <div className="csl-player__charts">
          <MetricTabs tabs={METRIC_TABS} selected={tab} onSelect={(id) => setTab(id as MetricTab)} scopeLabel={chart.scopeLabel} />
          <ChartLegend series={chart.spec.series} />
          <TimeSeriesChart {...chart.spec} playheadS={playback.tMs / 1000} />
        </div>
        <div className="csl-player__timeline">
          <h3>Why: timeline{after ? (showAfter ? ' (after the fix)' : ' (before the fix)') : ''}</h3>
          <Timeline entries={timelineView(shown.result.analysis)} />
        </div>
      </div>
    </section>
  );
}

function summary(r: AnalyzeResult) {
  return { verdict: r.analysis.recovery.verdict, recoveryMs: r.analysis.recovery.recoveryMs };
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
