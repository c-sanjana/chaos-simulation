import type { Comparison } from '../compare';

/**
 * "Compared with your last run": what the viewer changed, the results before and now, and a
 * plain takeaway. Shown after a re-run with changed settings; the viewer can dismiss it.
 */
export function RunComparison({ comparison, onDismiss }: { comparison: Comparison; onDismiss: () => void }) {
  const { changes, rows, takeaway } = comparison;
  const shown = changes.slice(0, 2);
  return (
    <section className="csl-compare" aria-label="Compared with your last run">
      <div className="csl-compare__head">
        <h3 className="csl-compare__title">Compared with your last run</h3>
        <button type="button" className="csl-btn csl-btn--link csl-compare__close" aria-label="Dismiss the comparison" onClick={onDismiss}>
          ×
        </button>
      </div>
      <p className="csl-compare__changes">
        You changed: {shown.join('; ')}
        {changes.length > shown.length && ` and ${changes.length - shown.length} more`}
      </p>
      <table className="csl-compare__table">
        <thead>
          <tr>
            <th scope="col">
              <span className="csl-sr-only">Measure</span>
            </th>
            <th scope="col">Before</th>
            <th scope="col">Now</th>
            <th scope="col">
              <span className="csl-sr-only">Change</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label}>
              <th scope="row">{r.label}</th>
              <td>{r.before}</td>
              <td>{r.now}</td>
              <td className={`csl-compare__change csl-compare__change--${r.tone}`}>{r.change}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="csl-compare__takeaway">{takeaway}</p>
    </section>
  );
}
