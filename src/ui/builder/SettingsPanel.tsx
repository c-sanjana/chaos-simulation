import { useId, type ReactNode } from 'react';
import { canConnectNodes, connectRefusal, updateCall, updateNode, type SettingsPatch } from '../../builder/edit';
import {
  KIND_BLURBS,
  KIND_LABELS,
  defaultCall,
  type BuilderEdge,
  type BuilderGraph,
  type BuilderNode,
  type CacheSettings,
  type PoolSettings,
  type QueueSettings,
  type ServiceSettings,
} from '../../builder/graph';
import { CheckboxField, NumberField } from '../components/Fields';
import { LIMITS } from '../draft';
import { callLabel, callSentence, displayName, edgeEnds } from './describe';
import { KindIcon } from './KindIcon';
import { PALETTE_KINDS } from './Palette';
import type { Selection } from './BuilderCanvas';

/*
 * Field limits. ASSUMPTION: generous ranges that keep runs meaningful and the simulator fast; the
 * main validator still checks combinations (e.g. a route from the Client to a database).
 */
const MAX_INSTANCES = 100;
const MAX_WORKERS = 10_000;
const MAX_CORES = 256;
const MAX_SERVICE_MS = 60_000;
const MAX_P99_MS = 600_000;
const MAX_QUEUE = 100_000;
const MAX_KEYS = 10_000_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_RETRIES = 10;
const MAX_BACKOFF_MS = 60_000;
const MAX_TTL_S = 86_400;

export interface SettingsPanelProps {
  graph: BuilderGraph;
  selection: Selection;
  onChange: (graph: BuilderGraph) => void;
  onSelect: (selection: Selection) => void;
  onConnect: (from: string, to: string) => void;
  onDelete: () => void;
}

function Group({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <fieldset className="csl-bpanel__group">
      <legend className="csl-bpanel__legend">{title}</legend>
      {hint && <p className="csl-bpanel__hint">{hint}</p>}
      <div className="csl-field-grid">{children}</div>
    </fieldset>
  );
}

function NameField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const id = useId();
  const blank = value.trim() === '';
  return (
    <label className="csl-field csl-bpanel__name">
      Name
      <span className={`csl-field__box${blank ? ' csl-field__box--invalid' : ''}`}>
        <input className="csl-field__input csl-bpanel__text" type="text" value={value} maxLength={40} aria-invalid={blank} aria-describedby={blank ? `${id}-error` : undefined} onChange={(e) => onChange(e.target.value)} />
      </span>
      {blank && (
        <span className="csl-field__error" id={`${id}-error`}>
          Give it a name
        </span>
      )}
    </label>
  );
}

/** Median and slow (99th percentile) time: how long one request takes when nothing is queued. */
function ServiceFields({ service, what, set }: { service: ServiceSettings; what: string; set: (p: Partial<ServiceSettings>) => void }) {
  return (
    <>
      <NumberField label={`Typical time ${what}`} unit="ms" value={service.medianMs} min={0.01} max={MAX_SERVICE_MS} onChange={(v) => set({ medianMs: v })} />
      <NumberField label="Slowest 1% take" unit="ms" value={service.p99Ms} min={service.medianMs} max={MAX_P99_MS} onChange={(v) => set({ p99Ms: v })} />
    </>
  );
}

/** Copies, workers and cores: shared by load balancers, servers, databases and caches. */
function MachineFields({ s, set }: { s: PoolSettings | CacheSettings; set: (p: SettingsPatch) => void }) {
  return (
    <>
      <NumberField label="Copies (instances)" value={s.instances} min={1} max={MAX_INSTANCES} integer onChange={(v) => set({ instances: v })} />
      <NumberField label="Requests each copy handles at once" value={s.workersPerInstance} min={1} max={MAX_WORKERS} integer onChange={(v) => set({ workersPerInstance: v })} />
      <NumberField label="CPU cores per copy" value={s.coresPerInstance} min={1} max={MAX_CORES} integer onChange={(v) => set({ coresPerInstance: v })} />
    </>
  );
}

function PoolFields({ s, set }: { s: PoolSettings; set: (p: SettingsPatch) => void }) {
  return (
    <>
      <Group title="Capacity" hint="Each copy works on a limited number of requests at once; the rest wait in line.">
        <MachineFields s={s} set={set} />
      </Group>
      <Group title="Speed" hint="Time to handle one request, not counting time spent waiting in line or calling others.">
        <ServiceFields service={s.service} what="per request" set={(p) => set({ service: p })} />
      </Group>
      <Group title="When busy">
        <CheckboxField label="Limit the waiting line" checked={s.queueLimit !== null} onChange={(on) => set({ queueLimit: on ? s.workersPerInstance : null })} />
        {s.queueLimit !== null && <NumberField label="Requests allowed to wait, per copy" value={s.queueLimit} min={0} max={MAX_QUEUE} integer onChange={(v) => set({ queueLimit: v })} />}
        <CheckboxField label="Skip requests whose caller already gave up" checked={s.dropExpired} onChange={(on) => set({ dropExpired: on })} />
      </Group>
    </>
  );
}

function CacheFields({ s, set }: { s: CacheSettings; set: (p: SettingsPatch) => void }) {
  return (
    <>
      <Group title="What it remembers" hint="A request whose key is in the cache is answered here; otherwise the server asks the database.">
        <NumberField label="Keys it can hold" unit="keys" value={s.capacity} min={1} max={MAX_KEYS} integer onChange={(v) => set({ capacity: v })} />
        <NumberField label="Different keys requested" unit="keys" value={s.keys} min={1} max={MAX_KEYS} integer onChange={(v) => set({ keys: v })} />
        <NumberField label="Popularity skew (0 = even, 1 = typical web)" value={s.skew} min={0} max={3} onChange={(v) => set({ skew: v })} />
        <CheckboxField label="Entries expire" checked={s.ttlMs !== null} onChange={(on) => set({ ttlMs: on ? 60_000 : null })} />
        {s.ttlMs !== null && <NumberField label="Expire after" unit="s" value={s.ttlMs / 1000} min={0.1} max={MAX_TTL_S} onChange={(v) => set({ ttlMs: v * 1000 })} />}
      </Group>
      <Group title="Capacity">
        <MachineFields s={s} set={set} />
      </Group>
      <Group title="Speed">
        <ServiceFields service={s.service} what="per lookup" set={(p) => set({ service: p })} />
      </Group>
    </>
  );
}

function QueueFields({ s, set }: { s: QueueSettings; set: (p: SettingsPatch) => void }) {
  return (
    <Group title="Queue" hint="The sender is answered as soon as its message is stored; consumers pass messages on later.">
      <NumberField label="Messages it can hold" value={s.maxDepth} min={1} max={MAX_KEYS} integer onChange={(v) => set({ maxDepth: v })} />
      <NumberField label="Messages handled at once (consumers)" value={s.consumers} min={1} max={MAX_WORKERS} integer onChange={(v) => set({ consumers: v })} />
      <ServiceFields service={s.service} what="per message" set={(p) => set({ service: p })} />
    </Group>
  );
}

function NodeSettings({ graph, node, onChange, onSelect, onConnect, onDelete }: Omit<SettingsPanelProps, 'selection'> & { node: BuilderNode }) {
  const s = node.settings;
  const set = (settings: SettingsPatch) => onChange(updateNode(graph, node.id, { settings }));
  const outgoing = graph.edges.filter((e) => e.from === node.id);
  const targets = graph.nodes.filter((n) => canConnectNodes(graph, node.id, n.id));
  const callsSomething = PALETTE_KINDS.some((k) => connectRefusal(s.kind, k) === null);
  const nameOf = (id: string) => {
    const n = graph.nodes.find((x) => x.id === id);
    return n ? displayName(n) : id;
  };

  return (
    <>
      <div className="csl-bpanel__head">
        <KindIcon kind={s.kind} size={20} />
        <div>
          <h3 className="csl-bpanel__title">{displayName(node)}</h3>
          <p className="csl-bpanel__sub">
            {KIND_LABELS[s.kind]}: {KIND_BLURBS[s.kind].toLowerCase()}
          </p>
        </div>
      </div>
      <NameField value={node.label} onChange={(label) => onChange(updateNode(graph, node.id, { label }))} />

      {s.kind === 'client' && (
        <Group title="Traffic" hint="Users keep sending at this rate, whether or not answers come back.">
          <NumberField label="Requests per second" unit="req/s" value={s.rps} min={1} max={LIMITS.maxRps} integer onChange={(v) => set({ rps: v })} />
        </Group>
      )}
      {(s.kind === 'loadBalancer' || s.kind === 'server' || s.kind === 'database') && <PoolFields s={s} set={set} />}
      {s.kind === 'cache' && <CacheFields s={s} set={set} />}
      {s.kind === 'queue' && <QueueFields s={s} set={set} />}

      <fieldset className="csl-bpanel__group">
        <legend className="csl-bpanel__legend">Calls</legend>
        {!callsSomething && <p className="csl-bpanel__hint">A {KIND_LABELS[s.kind].toLowerCase()} only answers calls; it doesn't call other components.</p>}
        {outgoing.length > 0 && (
          <ul className="csl-bpanel__calls">
            {outgoing.map((e) => (
              <li key={e.id}>
                <button type="button" className="csl-btn csl-btn--link" onClick={() => onSelect({ type: 'edge', id: e.id })}>
                  → {nameOf(e.to)} <span className="csl-bpanel__muted">({callLabel(e.call)})</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {callsSomething &&
          (targets.length > 0 ? (
            <label className="csl-field">
              Calls…
              <select
                className="csl-field__select csl-bpanel__select"
                value=""
                onChange={(e) => {
                  if (e.target.value) onConnect(node.id, e.target.value);
                }}
              >
                <option value="">Choose a component to call</option>
                {targets.map((t) => (
                  <option key={t.id} value={t.id}>
                    {displayName(t)} ({KIND_LABELS[t.settings.kind].toLowerCase()})
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <p className="csl-bpanel__hint">There is nothing more on the canvas it can call.</p>
          ))}
      </fieldset>

      <button type="button" className="csl-btn csl-bpanel__delete" onClick={onDelete}>
        Remove {displayName(node)}
      </button>
    </>
  );
}

function EdgeSettings({ edge, from, to, graph, onChange, onDelete }: Pick<SettingsPanelProps, 'graph' | 'onChange' | 'onDelete'> & { edge: BuilderEdge; from: BuilderNode; to: BuilderNode }) {
  const c = edge.call;
  const set = (patch: Partial<BuilderEdge['call']>) => onChange(updateCall(graph, edge.id, patch));
  const fromName = displayName(from);
  const toName = displayName(to);
  // When the timeout is switched back on, start from the usual value for this pair.
  const usualTimeout = defaultCall(from.settings.kind, to.settings.kind).timeoutMs ?? 1000;

  return (
    <>
      <div className="csl-bpanel__head">
        <span className="csl-bpanel__arrow" aria-hidden="true">
          →
        </span>
        <div>
          <h3 className="csl-bpanel__title">
            {fromName} → {toName}
          </h3>
          <p className="csl-bpanel__sub">
            {fromName} {callSentence(c)}.
          </p>
        </div>
      </div>
      <Group title="Giving up" hint="Without a timeout, a caller waits forever for a stuck component, and its own callers pile up behind it.">
        <CheckboxField label="Give up after a timeout" checked={c.timeoutMs !== null} onChange={(on) => set({ timeoutMs: on ? usualTimeout : null })} />
        {c.timeoutMs !== null && <NumberField label="Timeout" unit="ms" value={c.timeoutMs} min={1} max={MAX_TIMEOUT_MS} onChange={(v) => set({ timeoutMs: v })} />}
      </Group>
      <Group title="Trying again" hint="Each retry is one more request. When the callee is slow because it is overloaded, retries add to the overload: a retry storm.">
        <NumberField label="Retries" value={c.retries} min={0} max={MAX_RETRIES} integer onChange={(v) => set({ retries: v })} />
        <NumberField label="Wait before retrying (doubles each time)" unit="ms" value={c.backoffBaseMs} min={0} max={MAX_BACKOFF_MS} onChange={(v) => set({ backoffBaseMs: v })} />
        <CheckboxField label="Randomise the wait (jitter)" checked={c.jitter} onChange={(on) => set({ jitter: on })} />
      </Group>
      <button type="button" className="csl-btn csl-bpanel__delete" onClick={onDelete}>
        Remove this call
      </button>
    </>
  );
}

/** The side panel: settings of the selected box or arrow, or a short how-to when nothing is selected. */
export function SettingsPanel(props: SettingsPanelProps) {
  const { graph, selection } = props;
  const node = selection?.type === 'node' ? graph.nodes.find((n) => n.id === selection.id) : undefined;
  const edge = selection?.type === 'edge' ? graph.edges.find((e) => e.id === selection.id) : undefined;
  const ends = edge ? edgeEnds(graph, edge) : {};

  return (
    <aside className="csl-bpanel" aria-label="Settings">
      {/* The panel is as tall as the canvas column and scrolls inside, so it never makes the page scroll. */}
      <div className="csl-bpanel__scroll">
      {node && <NodeSettings key={node.id} {...props} node={node} />}
      {edge && ends.from && ends.to && <EdgeSettings key={edge.id} {...props} edge={edge} from={ends.from} to={ends.to} />}
      {!node && !(edge && ends.from && ends.to) && (
        <div className="csl-bpanel__intro">
          <h3 className="csl-bpanel__title">Settings</h3>
          <p>Select a box or an arrow's label to change its settings.</p>
          <ul>
            <li>Drag a component from the list above onto the canvas, or press its Add button.</li>
            <li>Drag a box to move it. Drag from the round handle on its right edge to another box to make it call that box.</li>
            <li>Requests start at the Client and flow along the arrows.</li>
          </ul>
        </div>
      )}
      </div>
    </aside>
  );
}
