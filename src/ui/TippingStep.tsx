import { useMemo, useState } from 'react';
import { buildRunConfig } from '../data/buildConfig';
import type { ScenarioPreset, TopologyPreset } from '../data/types';
import { buildSweep, tippingPoints } from '../sweep/sweep';
import type { SimPool } from '../worker/pool';
import { PlayerPlaceholder } from './components/PlayerPlaceholder';
import { MapLegend, TippingMap } from './components/TippingMap';
import { currentCell, nearestCell, onMap, retryCalls } from './draft';
import { RunPlayer } from './RunPlayer';
import { useAnalysis, useSweep } from './useSimulation';
import { axisPhrase, formatAxisValue, mapView, retriesPhrase, shortVerdict } from './viewModels';

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
  const tips = sweep.result && sweep.done === sweep.total ? tippingPoints(sweep.result) : [];
  const currentTip = tips.find((t) => t.y === current.y);
  const cellTitle = `${selected.x} req/s · ${formatAxisValue(yAxis, selected.y)} ${yAxis.label}`;
  const cascade = retriesPhrase(retryCalls(topology), labels);

  return (
    <div className="csl-split csl-split--stretch">
      <div className="csl-split__col csl-split__side">
        <section className="csl-card csl-card--compact" aria-label="Tipping point" data-tour="map">
          <div className="csl-card__head">
            <h2 className="csl-card__title">Where's the tipping point?</h2>
            <span className="csl-status" aria-live="polite">
              {sweep.error ? <span className="csl-error">{sweep.error}</span> : `${sweep.done} of ${sweep.total} runs`}
            </span>
          </div>
          <p className="csl-card__sub" style={{ margin: 0 }}>
            Each cell re-runs the same failure at another traffic level and {yAxis.label}. The <b>tipping point</b> is the lowest traffic at which the system gets stuck for good. Click a cell to replay it.
          </p>
          <MapLegend />
          <TippingMap map={map} selected={selected} onSelect={(c) => setSelected({ x: c.x, y: c.y })} />
          <div className="csl-selected-line" aria-label="Selected cell">
            <span className="csl-mono">{cellTitle}</span>
            <strong style={{ fontWeight: 600 }}>{summary ? capitalise(shortVerdict(summary)) : sweep.done === sweep.total && sweep.total > 0 ? 'Not on the map' : 'Running…'}</strong>
            {summary && summary.failedRequests > 0 && <span className="csl-status">{summary.failedRequests.toLocaleString()} failed requests</span>}
          </div>
          {!onMap(scenario) && (
            <p className="csl-status" style={{ margin: 0 }}>
              Your settings ({current.x} req/s, {axisPhrase(yAxis, current.y)}) aren't one of the map's cells; the nearest is selected.
            </p>
          )}
          {currentTip && (
            <p style={{ margin: 0, fontSize: 13, color: 'var(--csl-ink-2)' }}>
              {currentTip.tipsAtX === null
                ? `With ${axisPhrase(yAxis, current.y)}, the system recovers at every traffic level shown.`
                : `With ${axisPhrase(yAxis, current.y)}, the system tips at ${currentTip.tipsAtX} req/s.${current.x >= currentTip.tipsAtX ? ` Your ${current.x} req/s is past it: everything looks healthy until a failure like this happens.` : ''}`}{' '}
              {cascade && `Every layer asks again when it gives up (${cascade}), so one failed answer can come back as many requests.`}
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
