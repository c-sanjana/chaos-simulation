export interface FixTab {
  id: string;
  /** Short name for the tab, e.g. "Retry budget". */
  short: string;
  /** Full description of the change, e.g. "Retry budget of 10%: API → DB". */
  title: string;
  /** Why it was suggested, e.g. "retries were 74% of DB load". */
  why: string;
  /** Measured outcome, e.g. "Stuck → recovers in 3 s". */
  result: string;
  /** Short outcome for the tab itself, e.g. "3 s" or "stuck". */
  badge: string;
  helped: boolean;
  /** e.g. "helps in 5 of 5 seeds" (or "checking other seeds…"); empty when not checked. */
  seeds: string;
  affected: string;
  caveat: string;
}

export interface FixTabsProps {
  tabs: FixTab[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  appliedId: string | null;
  onApply: (id: string | null) => void;
}

/**
 * Fixes as horizontal tabs (best first; ones that did not help come last, muted). The selected
 * tab's details sit underneath with an Apply & compare button, so every fix is one click away
 * without scrolling a long list.
 */
export function FixTabs({ tabs, selectedId, onSelect, appliedId, onApply }: FixTabsProps) {
  if (tabs.length === 0) return <p className="csl-empty">No fixes to try for this run.</p>;
  const selected = tabs.find((t) => t.id === selectedId) ?? tabs[0];
  const applied = selected.id === appliedId;
  return (
    <div className="csl-fixtabs">
      <div className="csl-fixtabs__list" role="tablist" aria-label="Fixes">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`fix-tab-${t.id}`}
            aria-selected={t.id === selected.id}
            aria-controls="fix-tab-panel"
            className={`csl-fixtab${t.helped ? '' : ' csl-fixtab--no'}${t.id === appliedId ? ' csl-fixtab--applied' : ''}`}
            onClick={() => onSelect(t.id)}
          >
            <span className="csl-fixtab__mark" aria-hidden="true">
              {t.helped ? '✓' : '✕'}
            </span>
            <span className="csl-fixtab__name">{t.short}</span>
            {t.badge && <span className="csl-fixtab__badge">{t.badge}</span>}
          </button>
        ))}
      </div>
      <div className="csl-fixtabs__panel" role="tabpanel" id="fix-tab-panel" aria-labelledby={`fix-tab-${selected.id}`}>
        <div className="csl-fixtabs__head">
          <strong className="csl-fixtabs__title">{selected.title}</strong>
          <button
            type="button"
            className={`csl-btn csl-btn--small${applied ? ' csl-btn--primary' : ''}`}
            aria-pressed={applied}
            onClick={() => onApply(applied ? null : selected.id)}
          >
            {applied ? 'Comparing' : 'Apply & compare'}
          </button>
        </div>
        <span className="csl-fixtabs__why">Suggested because {selected.why}</span>
        <span className="csl-fixtabs__result">
          <b>{selected.result}</b>
          {selected.seeds && <span className="csl-mono"> · {selected.seeds}</span>}
          <span className="csl-mono"> · {selected.affected}</span>
        </span>
        <span className="csl-fixtabs__caveat">Caveat: {selected.caveat}</span>
      </div>
    </div>
  );
}
