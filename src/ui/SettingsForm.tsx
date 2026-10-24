import type { ReactNode } from 'react';
import { shareFractions, sharesWith } from '../builder/edit';
import { callsOf, type CallPolicy, type TierConfig } from '../engine/config';
import { CheckboxField, NumberField } from './components/Fields';
import { LIMITS, updateCallAt, updateScenario, updateTier, type Draft } from './draft';
import { FIELD_LIMITS as L, p99Message } from './fieldLimits';

type Lognormal = { kind: 'lognormal'; medianMs: number; p99Ms: number };

/**
 * How a caller calls `target`, in the builder's words: give up after a timeout (or wait as long as
 * it takes), how many times to try again, and how long to wait between tries.
 * ASSUMPTION: switching the timeout back on starts from 1 s, a common middle value.
 */
function CallFields({ call, target, onChange }: { call: CallPolicy; target: string; onChange: (change: Partial<CallPolicy>) => void }) {
  return (
    <>
      <CheckboxField label={`Give up on ${target} after a timeout`} checked={call.timeoutMs !== null} onChange={(on) => onChange({ timeoutMs: on ? 1000 : null })} />
      {call.timeoutMs !== null && <NumberField label={`Timeout to ${target}`} unit="ms" value={call.timeoutMs} min={1} max={L.maxTimeoutMs} onChange={(v) => onChange({ timeoutMs: v })} />}
      <NumberField label={`Retries to ${target}`} value={call.retries} min={0} max={L.maxRetries} integer onChange={(v) => onChange({ retries: v })} />
      {/* The wait between tries only matters when it tries again. */}
      {call.retries > 0 && (
        <>
          <NumberField label="Wait before retrying (doubles each time)" unit="ms" value={call.backoffBaseMs} min={0} max={L.maxBackoffMs} onChange={(v) => onChange({ backoffBaseMs: v })} />
          <CheckboxField label="Randomise the wait (jitter)" checked={call.jitter} onChange={(on) => onChange({ jitter: on })} />
        </>
      )}
    </>
  );
}

/**
 * Every call a tier makes, each with its own timeout and retries. A tier that calls several parts
 * also says how: a load balancer's share of traffic per call (in percent; the others make up the
 * rest), or an app server's "one after another" / "all at once".
 */
function TierCalls({ tier: t, label, onCall, onTier }: { tier: TierConfig; label: (id: string) => string; onCall: (index: number, change: Partial<CallPolicy>) => void; onTier: (change: (t: TierConfig) => TierConfig) => void }) {
  const calls = callsOf(t);
  if (calls.length === 0) return null;
  const split = t.fanOut === 'split' && calls.length > 1;
  const fractions = shareFractions(calls.map((c) => c.share));
  const setShare = (index: number, percent: number) => {
    const next = sharesWith(calls.map((c) => c.share), index, percent);
    onTier((x) => callsOf(x).reduce((acc, _, i) => updateCallAt(acc, i, { share: next[i] }), x));
  };
  return (
    <>
      {calls.length > 1 && !split && (
        <label className="csl-field">
          Calls its parts
          <select
            className="csl-field__box csl-field__select"
            value={t.fanOut === 'parallel' ? 'parallel' : 'sequence'}
            onChange={(e) => onTier((x) => ({ ...x, fanOut: e.target.value === 'parallel' ? 'parallel' : 'sequence' }))}
          >
            <option value="sequence">one after another</option>
            <option value="parallel">all at once</option>
          </select>
        </label>
      )}
      {calls.map((c, i) => (
        <CallGroup key={c.target} several={calls.length > 1}>
          {split && (
            <NumberField
              label={`Share of traffic to ${label(c.target)}`}
              unit="%"
              value={Math.round(fractions[i] * 100)}
              min={1}
              max={99}
              integer
              onChange={(v) => setShare(i, v)}
            />
          )}
          <CallFields call={c} target={label(c.target)} onChange={(change) => onCall(i, change)} />
        </CallGroup>
      ))}
    </>
  );
}

/** One call's fields; with several calls each is framed, so it is clear which fields go together. */
function CallGroup({ several, children }: { several: boolean; children: ReactNode }) {
  return several ? <div className="csl-field-grid csl-call-group">{children}</div> : <>{children}</>;
}

/**
 * Settings of the topology and scenario, grouped by part, with the same words and limits as the
 * builder's settings panel. Edits the draft only.
 * `only` limits it to one tier (or 'client' for traffic and the run); null shows everything.
 */
export function SettingsForm({ draft, onChange, only = null }: { draft: Draft; onChange: (d: Draft) => void; only?: string | null }) {
  const s = draft.scenario;
  const label = (id: string) => draft.topology.layout[id]?.label ?? id;
  const tier = (id: string, change: (t: TierConfig) => TierConfig) => onChange(updateTier(draft, id, change));
  const call = (t: TierConfig, index: number, change: Partial<CallPolicy>) => tier(t.id, (x) => updateCallAt(x, index, change));
  const service = (t: TierConfig, change: Partial<Lognormal>) => tier(t.id, (x) => ({ ...x, service: { ...(x.service as Lognormal), ...change } }));
  const tiers = only === null ? draft.topology.tiers : draft.topology.tiers.filter((t) => t.id === only);
  return (
    <>
      {(only === null || only === 'client') && (
        <>
          <h3 className="csl-section-title">Traffic and run</h3>
          <div className="csl-field-grid">
            <NumberField label="User traffic" unit="req/s" value={s.rps} min={1} max={LIMITS.maxRps} integer onChange={(v) => onChange(updateScenario(draft, { rps: v }))} />
            <NumberField label="Duration" unit="s" value={s.durationMs / 1000} min={LIMITS.minDurationS} max={LIMITS.maxDurationS} integer onChange={(v) => onChange(updateScenario(draft, { durationMs: v * 1000 }))} />
            <CallFields
              call={draft.topology.clientCall}
              target={label(draft.topology.clientCall.target)}
              onChange={(change) => onChange({ ...draft, topology: { ...draft.topology, clientCall: { ...draft.topology.clientCall, ...change } } })}
            />
          </div>
        </>
      )}
      {tiers.map((t) => {
        const what = t.cache ? 'per lookup' : t.queue ? 'per message' : 'per request';
        return (
          <fieldset key={t.id} className="csl-panel" style={{ margin: '12px 0 0' }}>
            <legend className="csl-section-title" style={{ padding: '0 4px' }}>
              {label(t.id)}
            </legend>
            <div className="csl-field-grid">
              {t.queue ? (
                <>
                  <NumberField label="Messages it can hold" value={t.queue.maxDepth} min={1} max={L.maxKeys} integer onChange={(v) => tier(t.id, (x) => ({ ...x, queue: { ...x.queue!, maxDepth: v } }))} />
                  <NumberField label="Messages handled at once (consumers)" value={t.queue.consumers} min={1} max={L.maxWorkers} integer onChange={(v) => tier(t.id, (x) => ({ ...x, queue: { ...x.queue!, consumers: v } }))} />
                </>
              ) : (
                <>
                  <NumberField label="Copies (instances)" value={t.instances} min={1} max={L.maxInstances} integer onChange={(v) => tier(t.id, (x) => ({ ...x, instances: v }))} />
                  <NumberField label="Requests each copy handles at once" value={t.workersPerInstance} min={1} max={L.maxWorkers} integer onChange={(v) => tier(t.id, (x) => ({ ...x, workersPerInstance: v }))} />
                  <NumberField label="CPU cores per copy" value={t.coresPerInstance} min={1} max={L.maxCores} integer onChange={(v) => tier(t.id, (x) => ({ ...x, coresPerInstance: v }))} />
                </>
              )}
              {t.service.kind === 'lognormal' && (
                <>
                  <NumberField label={`Typical time ${what}`} unit="ms" value={t.service.medianMs} min={L.minServiceMs} max={L.maxServiceMs} onChange={(v) => service(t, { medianMs: v })} />
                  <NumberField
                    label="Slowest 1% take"
                    unit="ms"
                    value={t.service.p99Ms}
                    min={L.minServiceMs}
                    max={L.maxP99Ms}
                    above={t.service.medianMs}
                    aboveMessage={p99Message(t.service.medianMs)}
                    onChange={(v) => service(t, { p99Ms: v })}
                  />
                </>
              )}
              {t.cache && (
                <>
                  <NumberField label="Keys it can hold" unit="keys" value={t.cache.capacity} min={1} max={L.maxKeys} integer onChange={(v) => tier(t.id, (x) => ({ ...x, cache: { ...x.cache!, capacity: v } }))} />
                  <NumberField label="Different keys requested" unit="keys" value={t.cache.keys} min={1} max={L.maxKeys} integer onChange={(v) => tier(t.id, (x) => ({ ...x, cache: { ...x.cache!, keys: v } }))} />
                  <NumberField label="Popularity skew (0 = even, 1 = typical web)" value={t.cache.skew} min={0} max={L.maxSkew} onChange={(v) => tier(t.id, (x) => ({ ...x, cache: { ...x.cache!, skew: v } }))} />
                  <CheckboxField label="Entries expire" checked={t.cache.ttlMs !== null} onChange={(on) => tier(t.id, (x) => ({ ...x, cache: { ...x.cache!, ttlMs: on ? 60_000 : null } }))} />
                  {t.cache.ttlMs !== null && (
                    <NumberField label="Expire after" unit="s" value={t.cache.ttlMs / 1000} min={L.minTtlS} max={L.maxTtlS} onChange={(v) => tier(t.id, (x) => ({ ...x, cache: { ...x.cache!, ttlMs: v * 1000 } }))} />
                  )}
                </>
              )}
              {!t.cache && !t.queue && (
                <>
                  <CheckboxField label="Limit the waiting line" checked={t.queueLimit !== null} onChange={(on) => tier(t.id, (x) => ({ ...x, queueLimit: on ? x.workersPerInstance : null }))} />
                  {t.queueLimit !== null && (
                    <NumberField label="Requests allowed to wait, per copy" value={t.queueLimit} min={0} max={L.maxQueue} integer onChange={(v) => tier(t.id, (x) => ({ ...x, queueLimit: v }))} />
                  )}
                  <CheckboxField label="Skip requests whose caller already gave up" checked={t.dropExpired} onChange={(on) => tier(t.id, (x) => ({ ...x, dropExpired: on }))} />
                </>
              )}
              <TierCalls tier={t} label={label} onCall={(index, change) => call(t, index, change)} onTier={(change) => tier(t.id, change)} />
            </div>
          </fieldset>
        );
      })}
    </>
  );
}
