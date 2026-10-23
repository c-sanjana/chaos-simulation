import { useId, useState } from 'react';
import type { FixView } from './types';

export interface FixListProps {
  /** Fixes that helped, best first. */
  fixes: FixView[];
  appliedId: string | null;
  /** Called with the fix id, or null when the applied fix is clicked again to un-apply it. */
  onApply: (id: string | null) => void;
  /** Fixes that were tried and did not help. */
  failed: Array<{ title: string; result: string }>;
}

export function failedToggleLabel(count: number, open: boolean): string {
  if (open) return 'Hide fixes that did not help';
  return count === 1 ? '1 more fix tried that did not help ▸' : `${count} more fixes tried that did not help ▸`;
}

function FixItem({ fix, rank, applied, onApply }: { fix: FixView; rank: number; applied: boolean; onApply: FixListProps['onApply'] }) {
  const [caveatOpen, setCaveatOpen] = useState(false);
  const caveatId = useId();
  const applyLabel = applied ? 'Applied' : 'Apply & compare';
  return (
    <li className={`csl-fix${applied ? ' csl-fix--applied' : ''}`}>
      <div className="csl-fix__row">
        <span className="csl-fix__rank">{rank}</span>
        <div className="csl-fix__main">
          <span className="csl-fix__title">{fix.title}</span>
          <span className="csl-fix__why">Suggested because {fix.why}</span>
        </div>
        <div className="csl-fix__outcome">
          <span className="csl-fix__result">{fix.result}</span>
          <span className="csl-fix__meta">
            {fix.seeds} · {fix.affected}
          </span>
        </div>
        <button
          type="button"
          className="csl-fix__caveat-btn"
          aria-label={`Caveat for ${fix.title}`}
          aria-expanded={caveatOpen}
          aria-controls={caveatOpen ? caveatId : undefined}
          onClick={() => setCaveatOpen((o) => !o)}
        >
          i
        </button>
        <button
          type="button"
          className={`csl-btn csl-fix__apply${applied ? ' csl-btn--primary' : ''}`}
          aria-label={`${applyLabel}: ${fix.title}`}
          onClick={() => onApply(applied ? null : fix.id)}
        >
          {applyLabel}
        </button>
      </div>
      {caveatOpen && (
        <div id={caveatId} className="csl-fix__caveat">
          Caveat: {fix.caveat}
        </div>
      )}
    </li>
  );
}

/** Ranked fixes with their measured effect, plus a collapsed list of fixes that did not help. */
export function FixList({ fixes, appliedId, onApply, failed }: FixListProps) {
  const [showFailed, setShowFailed] = useState(false);
  return (
    <div className="csl-fix-list">
      {fixes.length === 0 ? (
        <p className="csl-empty">None of the fixes tried made this run recover.</p>
      ) : (
        <ol className="csl-fixes">
          {fixes.map((f, i) => (
            <FixItem key={f.id} fix={f} rank={i + 1} applied={f.id === appliedId} onApply={onApply} />
          ))}
        </ol>
      )}
      {failed.length > 0 && (
        <>
          <button
            type="button"
            className="csl-btn csl-btn--link csl-fix-list__toggle"
            aria-expanded={showFailed}
            onClick={() => setShowFailed((o) => !o)}
          >
            {failedToggleLabel(failed.length, showFailed)}
          </button>
          {showFailed && (
            <ul className="csl-failed">
              {failed.map((f) => (
                <li key={f.title} className="csl-failed__item">
                  <span className="csl-failed__title">{f.title}</span>
                  <span className="csl-failed__result">{f.result}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
