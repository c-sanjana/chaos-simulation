import { useLayoutEffect, useRef, useState } from 'react';
import type { Fault } from '../engine/config';
import { NumberField } from './components/Fields';
import { FIELD_LIMITS } from './fieldLimits';
import {
  addFault,
  describeFault,
  draftProblems,
  FAULT_KIND_LABELS,
  faultKindOf,
  JUDGE_AFTER_FAILURE_S,
  LIMITS,
  callKey,
  countsText,
  removeFault,
  withCounts,
  retriesByCaller,
  retryCalls,
  setFault,
  updateFault,
  updateRetries,
  updateScenario,
  withFaultKind,
  type Draft,
  type FaultKindChoice,
} from './draft';

/**
 * What fails, how badly and when; how many times each layer retries; and the traffic.
 * A form: Run is disabled while a field holds an invalid value (the field keeps it, explained) or
 * the settings don't fit together. With nothing changed, the button replays the run from the start.
 */
export function FailureEditor({ draft, onChange, onRun, dirty }: { draft: Draft; onChange: (d: Draft) => void; onRun: () => void; dirty: boolean }) {
  const s = draft.scenario;
  const label = (id: string) => draft.topology.layout[id]?.label ?? id;
  const problems = draftProblems(draft);
  // A field holding an invalid entry never reaches the draft, so the form's own validity is checked
  // after every render (setting the same value again does nothing).
  const form = useRef<HTMLFormElement>(null);
  const [fieldsInvalid, setFieldsInvalid] = useState(false);
  useLayoutEffect(() => setFieldsInvalid(form.current !== null && !form.current.checkValidity()));
  // Each part can fail once at a time (see draftProblems), so adding stops when every part fails.
  const canAdd = draft.topology.tiers.some((t) => !s.faults.some((f) => f.tier === t.id));
  return (
    <form
      ref={form}
      onChange={() => setFieldsInvalid(form.current !== null && !form.current.checkValidity())}
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
        <button type="button" className="csl-btn csl-btn--small" disabled={!canAdd} onClick={() => onChange(addFault(draft))}>
          + Add another failure
        </button>
        {!canAdd && <span className="csl-status">Every part already has a failure.</span>}
      </fieldset>
      <fieldset className="csl-failure__group">
        <legend className="csl-failure__legend">Retries: how many times each caller retries after giving up</legend>
        <div className="csl-failure__row">
          {retryCalls(draft.topology).map((c) => (
            <NumberField
              key={callKey(c)}
              label={`${label(c.caller)} → ${label(c.target)}`}
              value={c.retries}
              min={0}
              max={FIELD_LIMITS.maxRetries}
              integer
              onChange={(v) => onChange(updateRetries(draft, c.caller, v, c.target))}
            />
          ))}
          <NumberField label="Traffic" unit="req/s" value={s.rps} min={1} max={LIMITS.maxRps} integer onChange={(v) => onChange(updateScenario(draft, { rps: v }))} />
        </div>
      </fieldset>
      <button type="submit" className="csl-btn csl-btn--primary csl-failure__run" disabled={problems.length > 0 || fieldsInvalid}>
        {dirty ? 'Run simulation' : 'Replay from the start'}
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
  // A failure must end in time to judge recovery (draftProblems): the fields are bounded by the run's length.
  const latestEndS = Math.min(LIMITS.maxDurationS, draft.scenario.durationMs / 1000 - JUDGE_AFTER_FAILURE_S);
  const lastingS = (f.endMs - f.startMs) / 1000;
  return (
    <div className="csl-failure__row" role="group" aria-label={`Failure ${n}`}>
      <label className="csl-field">
        Part
        <select
          className="csl-field__box csl-field__select"
          value={f.tier}
          onChange={(e) => {
            const next = tiers.find((t) => t.id === e.target.value)!;
            // A kind the new part can't have (restart empty on a non-cache, one copy of one) becomes "goes down".
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
              {FAULT_KIND_LABELS[k]}
            </option>
          ))}
        </select>
      </label>
      {f.kind === 'slow' && <NumberField label="How much slower" unit="×" value={f.factor ?? 1} min={1} max={1000} onChange={(v) => update({ factor: v })} />}
      <NumberField label="Lasting" unit="seconds" value={lastingS} min={1} max={Math.max(1, latestEndS - f.startMs / 1000)} integer onChange={(v) => update({ endMs: f.startMs + v * 1000 })} />
      <NumberField
        label="Starts at"
        unit="s into the run"
        value={f.startMs / 1000}
        min={0}
        max={Math.max(0, latestEndS - lastingS)}
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

/** Callers listed one by one in the summary; beyond this, the most common count is said once for "the rest". */
export const SUMMARY_MAX_CALLERS = 4;

/**
 * Who retries and how many times, front to back, in words: "users' apps 5× · Load balancer 3× · App
 * server 1×" (REVIEW2 3.7: "retries 5 / 3 / 1" meant nothing to a newcomer). A part that calls
 * several parts with different retries reads "App server 1× / 2×". With more than
 * `SUMMARY_MAX_CALLERS` callers, the users' apps and the callers that differ are named and the most
 * common count is said once: "users' apps 2× · Queue 3× · the rest 1×", so it stays on one line.
 * When most of them don't retry, that is left unsaid ("the rest 0×" read oddly): the callers
 * named are then the ones that do.
 */
export function retriesSummary(draft: Draft): string {
  const label = (id: string) => draft.topology.layout[id]?.label ?? id;
  const groups = retriesByCaller(retryCalls(draft.topology));
  const text = (g: (typeof groups)[number]) => withCounts(g.caller === 'client' ? "users' apps" : label(g.caller), g.counts);
  if (groups.length <= SUMMARY_MAX_CALLERS) return groups.map(text).join(' · ');
  const [users, ...others] = groups;
  const tally = new Map<string, number>();
  for (const g of others) tally.set(countsText(g.counts), (tally.get(countsText(g.counts)) ?? 0) + 1);
  const common = [...tally].reduce((a, b) => (b[1] > a[1] ? b : a))[0];
  const rest = common === countsText([0]) ? [] : [`the rest ${common}`];
  return [text(users), ...others.filter((g) => countsText(g.counts) !== common).map(text), ...rest].join(' · ');
}

/**
 * Every call's retries, for the summary's tooltip, so "App server 1× / 3×" can be told apart:
 * "users' apps → Load balancer 2×, App server → Database 1×, App server → Queue 3×".
 */
export function retriesDetail(draft: Draft): string {
  const label = (id: string) => draft.topology.layout[id]?.label ?? id;
  return retryCalls(draft.topology)
    .map((c) => `${c.caller === 'client' ? "users' apps" : label(c.caller)} → ${label(c.target)} ${countsText([c.retries])}`)
    .join(', ');
}

/**
 * The experiment being run, as the banner under the page title: labelled "Failure being tested",
 * the preset's name in bold, then its failure (⚡, as the diagram marks it), traffic and retries
 * as chips, with the button that opens the editor at its end.
 * `edited`: the system's own settings were changed (not the failure or traffic), so the name gets "(edited)".
 */
export function ScenarioSummary({ draft, editing, onToggle, edited = false }: { draft: Draft; editing: boolean; onToggle: () => void; edited?: boolean }) {
  const s = draft.scenario;
  const [f, ...more] = s.faults;
  const label = (id: string) => draft.topology.layout[id]?.label ?? id;
  const instances = draft.topology.tiers.find((t) => t.id === f.tier)?.instances ?? 1;
  return (
    <section className="csl-summary" aria-label="Scenario">
      <div className="csl-summary__head">
        <span className="csl-summary__label">Failure being tested</span>
        <strong className="csl-summary__name">
          {s.title}
          {edited && <span className="csl-summary__edited"> (edited)</span>}
        </strong>
      </div>
      <ul className="csl-summary__facts">
        <li className="csl-summary__fact csl-summary__fact--fault">
          <span className="csl-summary__bolt" aria-hidden="true">
            ⚡
          </span>
          {label(f.tier)} <b>{describeFault(f, instances)}</b> for <b>{(f.endMs - f.startMs) / 1000} s</b> at {f.startMs / 1000} s
          {more.length > 0 && <> (+{more.length} more)</>}
        </li>
        <li className="csl-summary__fact">
          <b>{s.rps} req/s</b>
        </li>
        <li className="csl-summary__fact" title={`How many times each layer retries after giving up on an answer, front to back: ${retriesDetail(draft)}`}>
          retries: <b>{retriesSummary(draft)}</b>
        </li>
      </ul>
      <button type="button" className="csl-btn csl-btn--small csl-summary__change" aria-expanded={editing} onClick={onToggle}>
        {editing ? 'Close' : 'Change failure'}
      </button>
    </section>
  );
}
