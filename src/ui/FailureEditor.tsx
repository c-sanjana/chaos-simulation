import { NumberField } from './components/Fields';
import { updateFault, updateScenario, type Draft } from './draft';

/** The editable sentence under the scenario cards: what fails, how badly, when, at what traffic. */
export function FailureEditor({ draft, onChange, onRun, dirty }: { draft: Draft; onChange: (d: Draft) => void; onRun: () => void; dirty: boolean }) {
  const s = draft.scenario;
  const f = s.faults[0];
  const label = draft.topology.layout[f.tier]?.label ?? f.tier;
  return (
    <div className="csl-failure">
      <p style={{ margin: 0, fontSize: 14, flexBasis: '100%' }}>
        <span style={{ color: 'var(--csl-muted)' }}>Failure: </span>
        <strong>{label}</strong> {f.kind === 'slow' ? 'slows down' : 'goes down'}
        {f.flushAtEnd ? ' and restarts empty' : ''}.
      </p>
      {f.kind === 'slow' && (
        <NumberField label={`${label} slowdown`} unit="× slower" value={f.factor ?? 1} min={1} step={1} onChange={(v) => onChange(updateFault(draft, { factor: v }))} />
      )}
      <NumberField label="Lasting" unit="seconds" value={(f.endMs - f.startMs) / 1000} min={1} step={1} onChange={(v) => onChange(updateFault(draft, { endMs: f.startMs + v * 1000 }))} />
      <NumberField
        label="Starts at"
        unit="s in"
        value={f.startMs / 1000}
        min={0}
        step={1}
        onChange={(v) => onChange(updateFault(draft, { startMs: v * 1000, endMs: v * 1000 + (f.endMs - f.startMs) }))}
      />
      <NumberField label="Traffic" unit="req/s" value={s.rps} min={1} step={10} onChange={(v) => onChange(updateScenario(draft, { rps: v }))} />
      {s.map.y.param === 'retries' && <NumberField label={s.map.y.label} value={s.retries} min={0} step={1} onChange={(v) => onChange(updateScenario(draft, { retries: Math.round(v) }))} />}
      <button type="button" className="csl-btn csl-btn--primary csl-failure__run" onClick={onRun}>
        {dirty ? 'Run simulation' : 'Re-run'}
      </button>
    </div>
  );
}

/** One-line version of the scenario card, used on steps 2 and 3. */
export function ScenarioSummary({ draft, onChange }: { draft: Draft; onChange: () => void }) {
  const s = draft.scenario;
  const f = s.faults[0];
  const label = draft.topology.layout[f.tier]?.label ?? f.tier;
  return (
    <section className="csl-summary" aria-label="Scenario">
      <strong>{s.title}</strong>
      <span className="csl-summary__text">
        {label} {f.kind === 'slow' ? <b>slows {f.factor}×</b> : <b>goes down</b>} for <b>{(f.endMs - f.startMs) / 1000} s</b> at {f.startMs / 1000} s · <b>{s.rps} req/s</b>
        {s.map.y.param === 'retries' && (
          <>
            {' '}· <b>{s.retries}</b> {s.map.y.label}
          </>
        )}
      </span>
      <button type="button" className="csl-btn csl-btn--small" onClick={onChange}>
        Change failure
      </button>
    </section>
  );
}
