import { NumberField } from './components/Fields';
import { draftProblems, LIMITS, updateFault, updateScenario, type Draft } from './draft';

/**
 * The editable sentence under the scenario cards: what fails, how badly, when, at what traffic.
 * A form: Run is blocked while a field holds an invalid value or the settings don't fit together.
 */
export function FailureEditor({ draft, onChange, onRun, dirty }: { draft: Draft; onChange: (d: Draft) => void; onRun: () => void; dirty: boolean }) {
  const s = draft.scenario;
  const f = s.faults[0];
  const label = draft.topology.layout[f.tier]?.label ?? f.tier;
  const problems = draftProblems(draft);
  return (
    <form
      className="csl-failure"
      aria-label="Failure settings"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (e.currentTarget.checkValidity() && problems.length === 0) onRun();
      }}
    >
      <p style={{ margin: 0, fontSize: 14, flexBasis: '100%' }}>
        <span style={{ color: 'var(--csl-muted)' }}>Failure: </span>
        <strong>{label}</strong> {f.kind === 'slow' ? 'slows down' : 'goes down'}
        {f.flushAtEnd ? ' and restarts empty' : ''}.
      </p>
      {f.kind === 'slow' && (
        <NumberField label={`${label} slowdown`} unit="× slower" value={f.factor ?? 1} min={1} max={1000} onChange={(v) => onChange(updateFault(draft, { factor: v }))} />
      )}
      <NumberField label="Lasting" unit="seconds" value={(f.endMs - f.startMs) / 1000} min={1} max={LIMITS.maxDurationS} integer onChange={(v) => onChange(updateFault(draft, { endMs: f.startMs + v * 1000 }))} />
      <NumberField
        label="Starts at"
        unit="s into the run"
        value={f.startMs / 1000}
        min={0}
        max={LIMITS.maxDurationS}
        integer
        onChange={(v) => onChange(updateFault(draft, { startMs: v * 1000, endMs: v * 1000 + (f.endMs - f.startMs) }))}
      />
      <NumberField label="Traffic" unit="req/s" value={s.rps} min={1} max={LIMITS.maxRps} integer onChange={(v) => onChange(updateScenario(draft, { rps: v }))} />
      {s.map.y.param === 'retries' && <NumberField label={s.map.y.label} value={s.retries} min={0} max={10} integer onChange={(v) => onChange(updateScenario(draft, { retries: v }))} />}
      <button type="submit" className="csl-btn csl-btn--primary csl-failure__run" disabled={problems.length > 0}>
        {dirty ? 'Run simulation' : 'Re-run'}
      </button>
      {problems.length > 0 && (
        <ul className="csl-problems" role="alert">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
    </form>
  );
}

/** One-line summary of the scenario and failure, with a button that opens the full editor. */
export function ScenarioSummary({ draft, editing, onToggle }: { draft: Draft; editing: boolean; onToggle: () => void }) {
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
      <button type="button" className="csl-btn csl-btn--small" aria-expanded={editing} onClick={onToggle}>
        {editing ? 'Close' : 'Change failure'}
      </button>
    </section>
  );
}
