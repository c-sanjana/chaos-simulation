import type { Comparison, ComparisonRow } from '../compare';

/** The arrow says which way the number moved; the colour says whether that is better or worse. */
const arrow = ({ before, now }: NonNullable<ComparisonRow['values']>) => (now > before ? '▲' : now < before ? '▼' : '=');
const TAKEAWAY_ICON = (rows: ComparisonRow[]) => (rows.some((r) => r.label === 'Outcome' && r.tone === 'better') ? '✓' : rows.some((r) => r.label === 'Outcome') ? '✕' : 'ⓘ');

/**
 * "Compared with your last run" as a picture: what changed (chips), each measure as a dumbbell
 * from before (grey) to now (blue) on its own scale, a ▲/▼ change chip coloured better/worse, and
 * one plain takeaway. The exact numbers are in each row's tooltip and in the screen-reader table.
 */
export function RunComparison({ comparison, onDismiss }: { comparison: Comparison; onDismiss: () => void }) {
  const { changes, rows, takeaway } = comparison;
  const shown = changes.slice(0, 3);
  const outcome = rows.find((r) => r.label === 'Outcome');
  const measured = rows.filter((r) => r.values);
  return (
    <section className="csl-compare" aria-label="Compared with your last run">
      <div className="csl-compare__head">
        <h3 className="csl-compare__title">Compared with your last run</h3>
        <button type="button" className="csl-btn csl-btn--link csl-compare__close" aria-label="Dismiss the comparison" onClick={onDismiss}>
          ×
        </button>
      </div>
      <ul className="csl-compare__changes" aria-label="What you changed">
        {shown.map((c) => (
          <li key={c} className="csl-compare__chip">
            {c}
          </li>
        ))}
        {changes.length > shown.length && <li className="csl-compare__chip csl-compare__chip--more">+{changes.length - shown.length} more</li>}
      </ul>
      {outcome && (
        <p className={`csl-compare__outcome csl-compare__outcome--${outcome.tone}`}>
          {outcome.before} <span aria-hidden="true">→</span>
          <span className="csl-sr-only">to</span> <b>{outcome.now}</b>
        </p>
      )}
      <div className="csl-compare__rows" aria-hidden="true">
        <span className="csl-compare__key">
          <span className="csl-compare__dot csl-compare__dot--before" /> before <span className="csl-compare__dot csl-compare__dot--now" /> now
        </span>
        {measured.map((r) => (
          <Dumbbell key={r.label} row={r} />
        ))}
      </div>
      <table className="csl-sr-only">
        <caption>Results before and now</caption>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label}>
              <th scope="row">{r.label}</th>
              <td>{r.before}</td>
              <td>{r.now}</td>
              <td>{r.change}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="csl-compare__takeaway">
        <span className="csl-compare__takeaway-icon" aria-hidden="true">
          {TAKEAWAY_ICON(rows)}
        </span>
        {takeaway}
      </p>
    </section>
  );
}

/** One measure: label and change chip above a before → now dumbbell on a 0..max scale. */
function Dumbbell({ row }: { row: ComparisonRow }) {
  const { before, now, max } = row.values!;
  const at = (v: number) => (max > 0 ? (100 * v) / max : 0);
  const [lo, hi] = [Math.min(at(before), at(now)), Math.max(at(before), at(now))];
  return (
    <div className="csl-dumbbell" title={`${row.label}: ${row.before} → ${row.now} (${row.change})`}>
      <span className="csl-dumbbell__label">{row.label}</span>
      <span className={`csl-dumbbell__change csl-dumbbell__change--${row.tone}`}>
        {arrow(row.values!)} {row.change}
      </span>
      <span className="csl-dumbbell__track">
        <span className="csl-dumbbell__span" style={{ left: `${lo}%`, width: `${hi - lo}%` }} />
        <span className="csl-dumbbell__dot csl-compare__dot--before" style={{ left: `${at(before)}%` }} />
        <span className="csl-dumbbell__dot csl-compare__dot--now" style={{ left: `${at(now)}%` }} />
      </span>
      <span className="csl-dumbbell__values">
        {row.before} → <b>{row.now}</b>
      </span>
    </div>
  );
}
