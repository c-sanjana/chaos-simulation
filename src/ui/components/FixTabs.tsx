export interface FixTab {
  id: string;
  /** Short name for the tab, e.g. "Bound queue". */
  short: string;
  /** Heading for the panel, e.g. "Bound the queue (load shedding)". */
  name: string;
  /** What changes, one plain sentence, e.g. "DB lets at most 93 requests wait per instance…". */
  what: string;
  /** Why it was suggested, a sentence, e.g. "Retries made up 74% of DB's load." */
  why: string;
  /** Measured outcome, e.g. "Stuck → recovers in 3 s". */
  result: string;
  /** e.g. "242 failed requests instead of 12,687". */
  failed: string;
  /** e.g. "Helped on 5 of 5 random seeds" (or "Checking other seeds…"); empty when not checked. */
  seeds: string;
  /** Short outcome for the tab itself, e.g. "3s" or "stuck"; empty for a fix that did not help. */
  badge: string;
  helped: boolean;
  pros: string[];
  /** Drawbacks: measured ones from this run first, then the general ones. */
  cons: string[];
}

export interface FixTabsProps {
  tabs: FixTab[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  appliedId: string | null;
  onApply: (id: string | null) => void;
}

/**
 * Fixes as tabs (best first; ones that did not help come last, muted). The selected tab's
 * details sit underneath: what the fix changes, why it was suggested, what happened, and its pros
 * and cons, with an Apply & compare button.
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
          <div>
            <h3 className="csl-fixtabs__title">{selected.name}</h3>
            <p className="csl-fixtabs__what">{selected.what}</p>
          </div>
          <button
            type="button"
            className={`csl-btn csl-btn--small${applied ? ' csl-btn--primary' : ''}`}
            aria-pressed={applied}
            onClick={() => onApply(applied ? null : selected.id)}
          >
            {applied ? 'Comparing' : 'Apply & compare'}
          </button>
        </div>
        <dl className="csl-fixtabs__facts">
          <dt>Why try it</dt>
          <dd>{selected.why}</dd>
          <dt>Result</dt>
          <dd>
            <b className={selected.helped ? 'csl-fixtabs__good' : 'csl-fixtabs__bad'}>{selected.result}</b>
            <span className="csl-fixtabs__detail">
              {selected.failed}
              {selected.seeds && ` · ${selected.seeds}`}
            </span>
          </dd>
        </dl>
        <div className="csl-fixtabs__procon">
          <ProCon title="Pros" sign="+" items={selected.pros} tone="good" />
          <ProCon title="Cons" sign="−" items={selected.cons} tone="bad" />
        </div>
      </div>
    </div>
  );
}

/** One list with its count in the heading, so several cons are never missed. */
function ProCon({ title, sign, items, tone }: { title: string; sign: string; items: string[]; tone: 'good' | 'bad' }) {
  return (
    <section className={`csl-procon csl-procon--${tone}`} aria-label={title}>
      <h4 className="csl-procon__title">
        {title} <span className="csl-procon__count">({items.length})</span>
      </h4>
      <ul className="csl-procon__list">
        {items.map((item) => (
          <li key={item}>
            <span className="csl-procon__sign" aria-hidden="true">
              {sign}
            </span>
            {item}
          </li>
        ))}
      </ul>
    </section>
  );
}
