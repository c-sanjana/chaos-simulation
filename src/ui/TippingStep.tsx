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
export function TippingStep({ pool, topology, scenario, labels }: { pool: SimPool; topology: TopologyPreset; scenario: ScenarioPreset; labels: Record<string, string> }) {
  const spec = useMemo(() => buildSweep(topology, scenario), [topology, scenario]);
  const sweep = useSweep(pool, spec);
  const current = currentCell(scenario);
  const [selected, setSelected] = useState(current);
  const [watching, setWatching] = useState(true);
  const { x: xAxis, y: yAxis } = scenario.map;
  const yOverride = { [yAxis.param]: selected.y };
  const cellConfig = useMemo(() => buildRunConfig(topology, scenario, { rps: selected.x, ...yOverride }), [topology, scenario, selected.x, selected.y]);
  const replay = useAnalysis(pool, watching ? cellConfig : null, labels);

  const map = mapView('Tipping-point map', xAxis, yAxis, (x, y) => sweep.result?.get(x, y), current);
  const summary = sweep.result?.get(selected.x, selected.y);
  const tips = sweep.result && sweep.done === sweep.total ? tippingPoints(sweep.result) : [];
  const currentTip = tips.find((t) => t.y === current.y);
  const cellTitle = `${selected.x} rps · ${formatAxisValue(yAxis, selected.y)} ${yAxis.label}`;

  return (
    <>
      <section className="csl-card" aria-label="Tipping point">
        <div>
          <h2 className="csl-card__title">Where's the tipping point?</h2>
          <p className="csl-card__sub">
            The same failure, re-run at every combination of traffic and {yAxis.label}. Each cell is a full simulation compared with its own no-failure run.
          </p>
        </div>
        <div className="csl-row" style={{ alignItems: 'center', gap: 12 }}>
          <MapLegend />
          <span className="csl-status" style={{ marginLeft: 'auto' }} aria-live="polite">
            {sweep.error ? <span className="csl-error">{sweep.error}</span> : `${sweep.done} of ${sweep.total} runs done`}
          </span>
        </div>
        <div className="csl-row">
          <div className="csl-row__main">
            <TippingMap map={map} selected={selected} onSelect={(c) => (setSelected({ x: c.x, y: c.y }), setWatching(true))} />
          </div>
          <aside className="csl-row__side csl-panel">
            <span className="csl-panel__label">Selected cell</span>
            <span className="csl-mono" style={{ fontSize: 15 }}>
              {cellTitle}
            </span>
            <span>{summary ? capitalise(shortVerdict(summary)) : 'Running…'}</span>
            {summary && summary.failedRequests > 0 && <span className="csl-status">{summary.failedRequests.toLocaleString()} requests failed because of the incident</span>}
            <button type="button" className="csl-btn csl-btn--primary" style={{ alignSelf: 'flex-start' }} aria-expanded={watching} onClick={() => setWatching((w) => !w)}>
              {watching ? 'Hide replay' : 'Watch this run'}
            </button>
            {currentTip && (
              <span style={{ fontSize: 13, color: 'var(--csl-ink-2)', borderTop: '1px solid var(--csl-border)', paddingTop: 8 }}>
                {currentTip.tipsAtX === null
                  ? `With the current ${yAxis.label} (${formatAxisValue(yAxis, current.y)}), the system recovers at every traffic level shown.`
                  : `With the current ${yAxis.label} (${formatAxisValue(yAxis, current.y)}), the system tips at ${currentTip.tipsAtX} requests/s.`}
              </span>
            )}
          </aside>
        </div>
      </section>
      {watching && replay.status === 'done' && (
        <RunPlayer title={`Replaying ${cellTitle}`} subtitle="Re-run of this cell's settings: identical to the map's run" topology={topology} config={cellConfig} result={replay.value} />
      )}
      {watching && replay.status === 'running' && <p className="csl-status">Simulating {cellTitle}…</p>}
      {replay.status === 'error' && <p className="csl-error">{replay.message}</p>}
    </>
  );
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
