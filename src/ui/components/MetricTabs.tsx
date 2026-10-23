export interface MetricTabsProps {
  tabs: Array<{ id: string; label: string }>;
  selected: string;
  onSelect: (id: string) => void;
  /** What the charts currently describe, e.g. "end to end, as users see it" or "DB". */
  scopeLabel: string;
}

/** Chart picker (Throughput, Latency, …) with a pill saying which tier the charts are scoped to. */
export function MetricTabs({ tabs, selected, onSelect, scopeLabel }: MetricTabsProps) {
  return (
    <div className="csl-tabs-row">
      <div className="csl-tabs" role="group" aria-label="Chart">
        {tabs.map((t) => (
          <button key={t.id} type="button" className="csl-tab" aria-pressed={t.id === selected} onClick={() => onSelect(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      <span className="csl-scope-pill">Showing: {scopeLabel}</span>
    </div>
  );
}
