import type { Fault } from '../engine/config';
import { NumberField } from './components/Fields';
import {
  addFault,
  describeFault,
  draftProblems,
  faultKindOf,
  LIMITS,
  removeFault,
  retryCalls,
  setFault,
  updateFault,
  updateRetries,
  updateScenario,
  withFaultKind,
  type Draft,
  type FaultKindChoice,
} from './draft';

const KIND_LABELS: Record<FaultKindChoice, string> = {
  slow: 'slows down',
  down: 'goes down',
  'one-down': 'loses one server',
  'restart-empty': 'goes down, restarts empty',
};

/**
 * What fails, how badly and when; how many times each layer asks again; and the traffic.
 * A form: Run is blocked while a field holds an invalid value or the settings don't fit together.
 */
export function FailureEditor({ draft, onChange, onRun, dirty }: { draft: Draft; onChange: (d: Draft) => void; onRun: () => void; dirty: boolean }) {
  const s = draft.scenario;
  const label = (id: string) => draft.topology.layout[id]?.label ?? id;
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
      <fieldset className="csl-failure__group">
        <legend className="csl-failure__legend">What fails</legend>
        {s.faults.map((f, i) => (
          <FaultRow key={i} draft={draft} fault={f} index={i} onChange={onChange} />
        ))}
        <button type="button" className="csl-btn csl-btn--small" onClick={() => onChange(addFault(draft))}>
          + Add another failure
        </button>
      </fieldset>
      <fieldset className="csl-failure__group">
        <legend className="csl-failure__legend">Retries: how many times each caller asks again after giving up</legend>
        <div className="csl-failure__row">
          {retryCalls(draft.topology).map((c) => (
            <NumberField
              key={c.caller}
              label={`${label(c.caller)} → ${label(c.target)}`}
              value={c.retries}
              min={0}
              max={10}
              integer
              onChange={(v) => onChange(updateRetries(draft, c.caller, v))}
            />
          ))}
          <NumberField label="Traffic" unit="req/s" value={s.rps} min={1} max={LIMITS.maxRps} integer onChange={(v) => onChange(updateScenario(draft, { rps: v }))} />
        </div>
      </fieldset>
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

/** One failure: which part, what happens to it, how badly, for how long and when. */
function FaultRow({ draft, fault: f, index, onChange }: { draft: Draft; fault: Fault; index: number; onChange: (d: Draft) => void }) {
  const tiers = draft.topology.tiers;
  const label = (id: string) => draft.topology.layout[id]?.label ?? id;
  const tier = tiers.find((t) => t.id === f.tier);
  const update = (change: Partial<Fault>) => onChange(updateFault(draft, change, index));
  const kinds: FaultKindChoice[] = ['slow', 'down', ...(tier && tier.instances > 1 ? (['one-down'] as const) : []), ...(tier?.cache ? (['restart-empty'] as const) : [])];
  const n = index + 1;
  return (
    <div className="csl-failure__row" role="group" aria-label={`Failure ${n}`}>
      <label className="csl-field">
        Part
        <select
          className="csl-field__box csl-field__select"
          value={f.tier}
          onChange={(e) => {
            const next = tiers.find((t) => t.id === e.target.value)!;
            // A kind the new part can't have (restart empty on a non-cache, one server of one) becomes "goes down".
            const kind = faultKindOf(f);
            const keep = (kind !== 'restart-empty' || next.cache) && (kind !== 'one-down' || next.instances > 1);
            onChange(setFault(draft, withFaultKind({ ...f, tier: next.id }, keep ? kind : 'down'), index));
          }}
        >
          {tiers.map((t) => (
            <option key={t.id} value={t.id}>
              {label(t.id)}
            </option>
          ))}
        </select>
      </label>
      <label className="csl-field">
        What happens
        <select className="csl-field__box csl-field__select" value={faultKindOf(f)} onChange={(e) => onChange(setFault(draft, withFaultKind(f, e.target.value as FaultKindChoice), index))}>
          {kinds.map((k) => (
            <option key={k} value={k}>
              {KIND_LABELS[k]}
            </option>
          ))}
        </select>
      </label>
      {f.kind === 'slow' && <NumberField label="How much slower" unit="×" value={f.factor ?? 1} min={1} max={1000} onChange={(v) => update({ factor: v })} />}
      <NumberField label="Lasting" unit="seconds" value={(f.endMs - f.startMs) / 1000} min={1} max={LIMITS.maxDurationS} integer onChange={(v) => update({ endMs: f.startMs + v * 1000 })} />
      <NumberField
        label="Starts at"
        unit="s into the run"
        value={f.startMs / 1000}
        min={0}
        max={LIMITS.maxDurationS}
        integer
        onChange={(v) => update({ startMs: v * 1000, endMs: v * 1000 + (f.endMs - f.startMs) })}
      />
      <span className="csl-failure__sentence">
        {label(f.tier)} {describeFault(f, tier?.instances ?? 1)} for {(f.endMs - f.startMs) / 1000} s.
      </span>
      {index > 0 && (
        <button type="button" className="csl-btn csl-btn--link" aria-label={`Remove failure ${n}`} onClick={() => onChange(removeFault(draft, index))}>
          Remove
        </button>
      )}
    </div>
  );
}

/** One-line summary of the scenario, its failures and retries, with a button that opens the editor. */
export function ScenarioSummary({ draft, editing, onToggle }: { draft: Draft; editing: boolean; onToggle: () => void }) {
  const s = draft.scenario;
  const [f, ...more] = s.faults;
  const label = (id: string) => draft.topology.layout[id]?.label ?? id;
  const instances = draft.topology.tiers.find((t) => t.id === f.tier)?.instances ?? 1;
  const retries = retryCalls(draft.topology).map((c) => c.retries);
  return (
    <section className="csl-summary" aria-label="Scenario">
      <strong>{s.title}</strong>
      <span className="csl-summary__text">
        {label(f.tier)} <b>{describeFault(f, instances)}</b> for <b>{(f.endMs - f.startMs) / 1000} s</b> at {f.startMs / 1000} s
        {more.length > 0 && <> (+{more.length} more)</>} · <b>{s.rps} req/s</b> · retries <b title="Times each layer asks again, front to back">{retries.join(' / ')}</b>
      </span>
      <button type="button" className="csl-btn csl-btn--small" aria-expanded={editing} onClick={onToggle}>
        {editing ? 'Close' : 'Change failure'}
      </button>
    </section>
  );
}
