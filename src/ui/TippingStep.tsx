import { useMemo, useState } from 'react';
import { buildRunConfig } from '../data/buildConfig';
import type { ScenarioPreset, TopologyPreset } from '../data/types';
import { buildSweep, tippingPoints } from '../sweep/sweep';
import type { SimPool } from '../worker/pool';
import { PlayerPlaceholder } from './components/PlayerPlaceholder';
import { MapLegend, OVERLOADED_TEXT, TippingMap } from './components/TippingMap';
import { currentCell, nearestCell, onMap, retryCalls } from './draft';
import { formatCount } from './format';
import { RunPlayer } from './RunPlayer';
import { cascadeSentence, tippingSentence } from './tipping';
import { useAnalysis, useSweep } from './useSimulation';
import { axisPhrase, formatAxisValue, mapView, shortVerdict } from './viewModels';

/** Step 2: the tipping-point map, with any cell replayable inline. */
export function TippingStep({ pool, topology, scenario, labels, onEdit }: { pool: SimPool; topology: TopologyPreset; scenario: ScenarioPreset; labels: Record<string, string>; onEdit?: (tierId: string | null) => void }) {
  const spec = useMemo(() => buildSweep(topology, scenario), [topology, scenario]);
  const sweep = useSweep(pool, spec);
  const current = currentCell(scenario);
  // Settings between or beyond the map's values start on the nearest cell (and say so).
  const [selected, setSelected] = useState(() => nearestCell(scenario));
  const { x: xAxis, y: yAxis } = scenario.map;
  const yOverride = { [yAxis.param]: selected.y };
  const cellConfig = useMemo(() => buildRunConfig(topology, scenario, { rps: selected.x, ...yOverride }), [topology, scenario, selected.x, selected.y]);
  const replay = useAnalysis(pool, cellConfig, labels);

  const map = mapView('Tipping-point map', xAxis, yAxis, (x, y) => sweep.result?.get(x, y), current);
  const summary = sweep.result?.get(selected.x, selected.y);
  const finished = sweep.result !== null && sweep.total > 0 && sweep.done === sweep.total;
  const tips = finished ? tippingPoints(sweep.result!) : [];
  // The sentence follows the clicked cell's row; the viewer's own traffic is mentioned on their row.
  const rowTip = tips.find((t) => t.y === selected.y);
  const currentVerdict = onMap(scenario) ? sweep.result?.get(current.x, current.y)?.verdict : undefined;
  const cellTitle = `${selected.x} req/s · ${formatAxisValue(yAxis, selected.y)} ${yAxis.label}`;
  const cascade = cascadeSentence(retryCalls(topology), labels);
  const verdictText = summary ? (summary.verdict === 'overloaded' ? OVERLOADED_TEXT : capitalise(shortVerdict(summary))) : finished ? 'Not on the map' : 'Running…';

  return (
    <div className="csl-split csl-split--stretch">
      <div className="csl-split__col csl-split__side">
        <section className="csl-card csl-card--compact" aria-label="Tipping point" data-tour="map" data-tour-ready={finished || undefined}>
          <div className="csl-card__head">
            <h2 className="csl-card__title" id="csl-step-heading" tabIndex={-1}>
              Where's the tipping point?
            </h2>
            <span className="csl-status" aria-live="polite">
              {sweep.error ? <span className="csl-error">{sweep.error}</span> : `${sweep.done} of ${sweep.total} runs`}
            </span>
          </div>
          <p className="csl-card__sub" style={{ margin: 0 }}>
            Each cell re-runs the same failure at another traffic level and {yAxis.label}. The <b>tipping point</b> is the lowest traffic at which the system gets stuck for good. Select a cell (click it, or arrow keys then Enter) to replay it.
          </p>
          <MapLegend />
          <TippingMap map={map} selected={selected} onSelect={(c) => setSelected({ x: c.x, y: c.y })} tips={tips} />
          <div className="csl-selected-line" aria-label="Selected cell">
            <span className="csl-mono">{cellTitle}</span>
            <strong style={{ fontWeight: 600 }}>{verdictText}</strong>
            {summary && summary.failedRequests > 0 && <span className="csl-status">{formatCount(summary.failedRequests)} failed requests</span>}
          </div>
          {!onMap(scenario) && (
            <p className="csl-status" style={{ margin: 0 }}>
              Your settings ({current.x} req/s, {axisPhrase(yAxis, current.y)}) aren't one of the map's cells; the nearest is selected.
            </p>
          )}
          {rowTip && (
            <p style={{ margin: 0, fontSize: 13, color: 'var(--csl-ink-2)' }}>
              {tippingSentence({ tip: rowTip, yAxis, current, currentVerdict })} {cascade}
            </p>
          )}
        </section>
      </div>
      <div className="csl-split__main" data-tour="replay">
        {replay.status === 'done' && (
          <RunPlayer
            title={`Replaying ${cellTitle}`}
            subtitle="Re-run of this cell's settings: identical to the map's run"
            topology={topology}
            config={cellConfig}
            result={replay.value}
            onEdit={onEdit}
            compact
            chartHeight={200}
            sideTimeline
            compactStory
          />
        )}
        {replay.status === 'running' && <PlayerPlaceholder text={`Simulating ${cellTitle}…`} progress={replay.progress} minHeight={REPLAY_PLAYER_HEIGHT} />}
        {replay.status === 'error' && <p className="csl-error">{replay.message}</p>}
      </div>
    </div>
  );
}

/** ASSUMPTION: about the height of the replay player at 1440 × 900 (measured), so the page doesn't jump when it appears. */
const REPLAY_PLAYER_HEIGHT = 640;

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
