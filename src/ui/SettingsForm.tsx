import type { CallPolicy, TierConfig } from '../engine/config';
import { CheckboxField, NumberField } from './components/Fields';
import { updateScenario, updateTier, type Draft } from './draft';

/** Every setting of the topology and scenario, grouped by tier. Edits the draft only. */
export function SettingsForm({ draft, onChange }: { draft: Draft; onChange: (d: Draft) => void }) {
  const s = draft.scenario;
  const tier = (id: string, change: (t: TierConfig) => TierConfig) => onChange(updateTier(draft, id, change));
  const call = (t: TierConfig, key: 'downstream' | 'cacheAside', change: Partial<CallPolicy>) => tier(t.id, (x) => ({ ...x, [key]: { ...x[key]!, ...change } }));
  return (
    <>
      <h3 className="csl-section-title">Traffic and run</h3>
      <div className="csl-field-grid">
        <NumberField label="User traffic" unit="req/s" value={s.rps} min={1} onChange={(v) => onChange(updateScenario(draft, { rps: v }))} />
        <NumberField label="Duration" unit="s" value={s.durationMs / 1000} min={30} step={10} onChange={(v) => onChange(updateScenario(draft, { durationMs: v * 1000 }))} />
        <NumberField
          label="Client timeout"
          unit="ms"
          value={draft.topology.clientCall.timeoutMs ?? 0}
          min={1}
          onChange={(v) => onChange({ ...draft, topology: { ...draft.topology, clientCall: { ...draft.topology.clientCall, timeoutMs: v } } })}
        />
      </div>
      {draft.topology.tiers.map((t) => (
        <fieldset key={t.id} className="csl-panel" style={{ margin: '12px 0 0' }}>
          <legend className="csl-section-title" style={{ padding: '0 4px' }}>
            {draft.topology.layout[t.id]?.label ?? t.id}
          </legend>
          <div className="csl-field-grid">
            <NumberField label="Instances" value={t.instances} min={1} step={1} onChange={(v) => tier(t.id, (x) => ({ ...x, instances: Math.round(v) }))} />
            <NumberField label="Workers per instance" value={t.workersPerInstance} min={1} step={1} onChange={(v) => tier(t.id, (x) => ({ ...x, workersPerInstance: Math.round(v) }))} />
            <NumberField label="Cores per instance" value={t.coresPerInstance} min={1} step={1} onChange={(v) => tier(t.id, (x) => ({ ...x, coresPerInstance: Math.round(v) }))} />
            {t.service.kind === 'lognormal' && (
              <>
                <NumberField label="Service time median" unit="ms" value={t.service.medianMs} min={0.01} step={1} onChange={(v) => tier(t.id, (x) => ({ ...x, service: { ...(x.service as { kind: 'lognormal'; medianMs: number; p99Ms: number }), medianMs: v } }))} />
                <NumberField label="Service time p99" unit="ms" value={t.service.p99Ms} min={0.01} step={1} onChange={(v) => tier(t.id, (x) => ({ ...x, service: { ...(x.service as { kind: 'lognormal'; medianMs: number; p99Ms: number }), p99Ms: v } }))} />
              </>
            )}
            {t.queueLimit !== null && <NumberField label="Queue limit per instance" value={t.queueLimit} min={0} step={1} onChange={(v) => tier(t.id, (x) => ({ ...x, queueLimit: Math.round(v) }))} />}
            {t.downstream && (
              <>
                <NumberField label={`Timeout to ${draft.topology.layout[t.downstream.target]?.label ?? t.downstream.target}`} unit="ms" value={t.downstream.timeoutMs ?? 0} min={1} onChange={(v) => call(t, 'downstream', { timeoutMs: v })} />
                {t.id === s.retryCall ? (
                  <NumberField label="Retries" value={s.retries} min={0} step={1} onChange={(v) => onChange(updateScenario(draft, { retries: Math.round(v) }))} />
                ) : (
                  <NumberField label="Retries" value={t.downstream.retries} min={0} step={1} onChange={(v) => call(t, 'downstream', { retries: Math.round(v) })} />
                )}
                <NumberField label="Backoff base" unit="ms" value={t.downstream.backoffBaseMs} min={0} onChange={(v) => call(t, 'downstream', { backoffBaseMs: v })} />
              </>
            )}
            {t.cache && (
              <>
                <NumberField label="Capacity" unit="keys" value={t.cache.capacity} min={1} step={100} onChange={(v) => tier(t.id, (x) => ({ ...x, cache: { ...x.cache!, capacity: Math.round(v) } }))} />
                <NumberField label="TTL" unit="s" value={(t.cache.ttlMs ?? 0) / 1000} min={1} onChange={(v) => tier(t.id, (x) => ({ ...x, cache: { ...x.cache!, ttlMs: v * 1000 } }))} />
                <NumberField label="Distinct keys requested" value={t.cache.keys} min={1} step={1000} onChange={(v) => tier(t.id, (x) => ({ ...x, cache: { ...x.cache!, keys: Math.round(v) } }))} />
                <NumberField label="Popularity skew" unit="Zipf" value={t.cache.skew} min={0} step={0.1} onChange={(v) => tier(t.id, (x) => ({ ...x, cache: { ...x.cache!, skew: v } }))} />
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
