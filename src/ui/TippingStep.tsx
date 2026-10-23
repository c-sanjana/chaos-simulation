import { useMemo, useState } from 'react';
import { buildRunConfig } from '../data/buildConfig';
import type { ScenarioPreset, TopologyPreset } from '../data/types';
import { buildSweep, tippingPoints } from '../sweep/sweep';
import type { SimPool } from '../worker/pool';
import { MapLegend, TippingMap } from './components/TippingMap';
import { currentCell } from './draft';
import { RunPlayer } from './RunPlayer';
import { useAnalysis, useSweep } from './useSimulation';
import { formatAxisValue, mapView, shortVerdict } from './viewModels';

/** Step 2: the tipping-point map, with any cell replayable inline. */
export function TippingStep({ pool, topology, scenario, labels, onEdit }: { pool: SimPool; topology: TopologyPreset; scenario: ScenarioPreset; labels: Record<string, string>; onEdit?: (tierId: string | null) => void }) {
  const spec = useMemo(() => buildSweep(topology, scenario), [topology, scenario]);
  const sweep = useSweep(pool, spec);
  const current = currentCell(scenario);
  const [selected, setSelected] = useState(current);
  const [timelineEl, setTimelineEl] = useState<HTMLElement | null>(null);
  const { x: xAxis, y: yAxis } = scenario.map;
  const yOverride = { [yAxis.param]: selected.y };
  const cellConfig = useMemo(() => buildRunConfig(topology, scenario, { rps: selected.x, ...yOverride }), [topology, scenario, selected.x, selected.y]);
  const replay = useAnalysis(pool, cellConfig, labels);

  const map = mapView('Tipping-point map', xAxis, yAxis, (x, y) => sweep.result?.get(x, y), current);
  const summary = sweep.result?.get(selected.x, selected.y);
  const tips = sweep.result && sweep.done === sweep.total ? tippingPoints(sweep.result) : [];
  const currentTip = tips.find((t) => t.y === current.y);
  const cellTitle = `${selected.x} rps · ${formatAxisValue(yAxis, selected.y)} ${yAxis.label}`;

  return (
    <div className="csl-split">
      <section className="csl-card csl-card--compact csl-split__side" aria-label="Tipping point">
        <div>
          <h2 className="csl-card__title">Where's the tipping point?</h2>
          <p className="csl-card__sub">The same failure at every traffic × {yAxis.label}. Each cell is a full run compared with its no-failure control. Click one to replay it.</p>
        </div>
        <MapLegend />
        <span className="csl-status" aria-live="polite">
          {sweep.error ? <span className="csl-error">{sweep.error}</span> : `${sweep.done} of ${sweep.total} runs done`}
        </span>
        <TippingMap map={map} selected={selected} onSelect={(c) => setSelected({ x: c.x, y: c.y })} />
        <div className="csl-panel">
          <span className="csl-mono" style={{ fontSize: 14 }}>
            {cellTitle}
          </span>
          <span>
            {summary ? capitalise(shortVerdict(summary)) : 'Running…'}
            {summary && summary.failedRequests > 0 && <span className="csl-status"> · {summary.failedRequests.toLocaleString()} requests failed because of the incident</span>}
          </span>
          {currentTip && (
            <span style={{ fontSize: 13, color: 'var(--csl-ink-2)' }}>
              {currentTip.tipsAtX === null
                ? `With the current ${yAxis.label} (${formatAxisValue(yAxis, current.y)}), the system recovers at every traffic level shown.`
                : `With the current ${yAxis.label} (${formatAxisValue(yAxis, current.y)}), the system tips at ${currentTip.tipsAtX} requests/s.`}
            </span>
          )}
        </div>
        <div className="csl-split__timeline" ref={setTimelineEl} />
      </section>
      <div className="csl-split__main">
        {replay.status === 'done' && (
          <RunPlayer
            title={`Replaying ${cellTitle}`}
            subtitle="Re-run of this cell's settings: identical to the map's run"
            topology={topology}
            config={cellConfig}
            result={replay.value}
            onEdit={onEdit}
            compact
            timelineTarget={timelineEl}
          />
        )}
        {replay.status === 'running' && (
          <section className="csl-card csl-card--compact">
            <p className="csl-status">Simulating {cellTitle}…</p>
          </section>
        )}
        {replay.status === 'error' && <p className="csl-error">{replay.message}</p>}
      </div>
    </div>
  );
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
