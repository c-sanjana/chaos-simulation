import type { CallPolicy, TierConfig } from '../engine/config';
import { CheckboxField, NumberField } from './components/Fields';
import { LIMITS, updateScenario, updateTier, type Draft } from './draft';

/**
 * Settings of the topology and scenario, grouped by tier. Edits the draft only.
 * `only` limits it to one tier (or 'client' for traffic and the run); null shows everything.
 */
export function SettingsForm({ draft, onChange, only = null }: { draft: Draft; onChange: (d: Draft) => void; only?: string | null }) {
  const s = draft.scenario;
  const tier = (id: string, change: (t: TierConfig) => TierConfig) => onChange(updateTier(draft, id, change));
  const call = (t: TierConfig, key: 'downstream' | 'cacheAside', change: Partial<CallPolicy>) => tier(t.id, (x) => ({ ...x, [key]: { ...x[key]!, ...change } }));
  const tiers = only === null ? draft.topology.tiers : draft.topology.tiers.filter((t) => t.id === only);
  return (
    <>
      {(only === null || only === 'client') && (
        <>
      <h3 className="csl-section-title">Traffic and run</h3>
      <div className="csl-field-grid">
        <NumberField label="User traffic" unit="req/s" value={s.rps} min={1} max={LIMITS.maxRps} integer onChange={(v) => onChange(updateScenario(draft, { rps: v }))} />
        <NumberField label="Duration" unit="s" value={s.durationMs / 1000} min={LIMITS.minDurationS} max={LIMITS.maxDurationS} integer onChange={(v) => onChange(updateScenario(draft, { durationMs: v * 1000 }))} />
        <NumberField
          label="Client timeout"
          unit="ms"
          value={draft.topology.clientCall.timeoutMs ?? 0}
          min={1}
          onChange={(v) => onChange({ ...draft, topology: { ...draft.topology, clientCall: { ...draft.topology.clientCall, timeoutMs: v } } })}
        />
        <NumberField
          label="Client retries"
          value={draft.topology.clientCall.retries}
          min={0}
          max={10}
          integer
          onChange={(v) => onChange({ ...draft, topology: { ...draft.topology, clientCall: { ...draft.topology.clientCall, retries: v } } })}
        />
      </div>
        </>
      )}
      {tiers.map((t) => (
        <fieldset key={t.id} className="csl-panel" style={{ margin: '12px 0 0' }}>
          <legend className="csl-section-title" style={{ padding: '0 4px' }}>
            {draft.topology.layout[t.id]?.label ?? t.id}
          </legend>
          <div className="csl-field-grid">
            <NumberField label="Instances" value={t.instances} min={1} max={100} integer onChange={(v) => tier(t.id, (x) => ({ ...x, instances: v }))} />
            <NumberField label="Workers per instance" value={t.workersPerInstance} min={1} max={10000} integer onChange={(v) => tier(t.id, (x) => ({ ...x, workersPerInstance: v }))} />
            <NumberField label="Cores per instance" value={t.coresPerInstance} min={1} max={256} integer onChange={(v) => tier(t.id, (x) => ({ ...x, coresPerInstance: v }))} />
            {t.service.kind === 'lognormal' && (
              <>
                <NumberField label="Service time median" unit="ms" value={t.service.medianMs} min={0.01} max={60000} onChange={(v) => tier(t.id, (x) => ({ ...x, service: { ...(x.service as { kind: 'lognormal'; medianMs: number; p99Ms: number }), medianMs: v } }))} />
                <NumberField label="Service time p99" unit="ms" value={t.service.p99Ms} min={0.01} max={600000} onChange={(v) => tier(t.id, (x) => ({ ...x, service: { ...(x.service as { kind: 'lognormal'; medianMs: number; p99Ms: number }), p99Ms: v } }))} />
              </>
            )}
            {t.queueLimit !== null && <NumberField label="Queue limit per instance" value={t.queueLimit} min={0} integer onChange={(v) => tier(t.id, (x) => ({ ...x, queueLimit: v }))} />}
            {t.downstream && (
              <>
                <NumberField label={`Timeout to ${draft.topology.layout[t.downstream.target]?.label ?? t.downstream.target}`} unit="ms" value={t.downstream.timeoutMs ?? 0} min={1} onChange={(v) => call(t, 'downstream', { timeoutMs: v })} />
                <NumberField label="Retries" value={t.downstream.retries} min={0} max={10} integer onChange={(v) => call(t, 'downstream', { retries: v })} />
                <NumberField label="Backoff base" unit="ms" value={t.downstream.backoffBaseMs} min={0} onChange={(v) => call(t, 'downstream', { backoffBaseMs: v })} />
              </>
            )}
            {t.cache && (
              <>
                <NumberField label="Capacity" unit="keys" value={t.cache.capacity} min={1} integer onChange={(v) => tier(t.id, (x) => ({ ...x, cache: { ...x.cache!, capacity: v } }))} />
                <NumberField label="TTL" unit="s" value={(t.cache.ttlMs ?? 0) / 1000} min={1} onChange={(v) => tier(t.id, (x) => ({ ...x, cache: { ...x.cache!, ttlMs: v * 1000 } }))} />
                <NumberField label="Distinct keys requested" value={t.cache.keys} min={1} integer onChange={(v) => tier(t.id, (x) => ({ ...x, cache: { ...x.cache!, keys: v } }))} />
                <NumberField label="Popularity skew" unit="Zipf" value={t.cache.skew} min={0} onChange={(v) => tier(t.id, (x) => ({ ...x, cache: { ...x.cache!, skew: v } }))} />
              </>
            )}
          </div>
          <div className="csl-row" style={{ gap: 16, marginTop: 8 }}>
            <CheckboxField label="Unbounded queue" checked={t.queueLimit === null} onChange={(on) => tier(t.id, (x) => ({ ...x, queueLimit: on ? null : x.workersPerInstance }))} />
            {t.downstream && <CheckboxField label="Jitter on retries" checked={t.downstream.jitter} onChange={(on) => call(t, 'downstream', { jitter: on })} />}
            <CheckboxField label="Drop requests whose caller gave up" checked={t.dropExpired} onChange={(on) => tier(t.id, (x) => ({ ...x, dropExpired: on }))} />
          </div>
        </fieldset>
      ))}
    </>
  );
}
