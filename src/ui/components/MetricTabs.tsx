export interface MetricTabsProps {
  tabs: Array<{ id: string; label: string }>;
  selected: string;
  onSelect: (id: string) => void;
  /** What the charts currently describe, e.g. "end to end, as users see it" or "DB". */
  scopeLabel: string;
  /** With these, the scope is a dropdown the viewer can change instead of a fixed pill. */
  scopes?: Array<{ id: string; label: string }>;
  scope?: string;
  onScope?: (id: string) => void;
}

/** Chart picker (Throughput, Latency, …) with a pill saying which tier the charts are scoped to. */
export function MetricTabs({ tabs, selected, onSelect, scopeLabel, scopes, scope, onScope }: MetricTabsProps) {
  return (
    <div className="csl-tabs-row">
      <div className="csl-tabs" role="group" aria-label="Chart">
        {tabs.map((t) => (
          <button key={t.id} type="button" className="csl-tab" aria-pressed={t.id === selected} onClick={() => onSelect(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      {scopes && onScope ? (
        <label className="csl-scope-pill csl-scope-select">
          Showing:
          <select value={scope} onChange={(e) => onScope(e.target.value)} aria-label="Show metrics for">
            {scopes.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
          <span className="csl-sr-only">({scopeLabel})</span>
        </label>
      ) : (
        <span className="csl-scope-pill">Showing: {scopeLabel}</span>
      )}
    </div>
  );
}
