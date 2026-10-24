import type { TimelineEntryView } from './types';

const DOT: Record<TimelineEntryView['kind'], string> = {
  fault: 'var(--csl-bad)',
  tip: 'var(--csl-bad)',
  bad: 'var(--csl-bad)',
  good: 'var(--csl-good)',
  info: 'var(--csl-info-dot)',
};

/** 30000 → "30", 30500 → "30.5" (one decimal at most). */
export function formatSeconds(ms: number): string {
  return String(Math.round(ms / 100) / 10);
}

export function timeLabel(e: Pick<TimelineEntryView, 'tMs' | 'endMs'>): string {
  return e.endMs === undefined ? `${formatSeconds(e.tMs)} s` : `${formatSeconds(e.tMs)}–${formatSeconds(e.endMs)} s`;
}

/** Events that mean something went wrong: highlighted so they stand out at a glance. */
const ALERT: ReadonlySet<TimelineEntryView['kind']> = new Set(['fault', 'tip', 'bad']);

/**
 * "Why" timeline: what happened during the run.
 * With `nowMs` (the replay position) it plays along, newest first: only events the replay has
 * reached are shown, the latest at the top, with a count of what is still ahead. An event spanning
 * a time range ("35–117 s") is shown once the replay reaches the end of the range, so it never
 * states something the replay hasn't shown yet. Failure events are highlighted.
 */
export function Timeline({ entries, nowMs }: { entries: TimelineEntryView[]; nowMs?: number }) {
  if (entries.length === 0) return <p className="csl-empty">Nothing notable detected.</p>;
  const revealAt = (e: TimelineEntryView) => e.endMs ?? e.tMs;
  const reached = nowMs === undefined ? entries : entries.filter((e) => revealAt(e) <= nowMs);
  // Newest first by when each entry appeared (a stable sort keeps same-time events in their given order).
  const shown = nowMs === undefined ? reached : [...reached].sort((a, b) => revealAt(b) - revealAt(a));
  const ahead = entries.length - reached.length;
  return (
    <>
      {ahead > 0 && reached.length > 0 && (
        <p className="csl-timeline__ahead">
          {ahead} more event{ahead === 1 ? '' : 's'} ahead
        </p>
      )}
      {shown.length === 0 ? (
        <p className="csl-empty">Events appear here as the replay reaches them.</p>
      ) : (
        <ol className="csl-timeline" aria-live="polite">
          {shown.map((e, i) => {
            const strong = e.kind === 'tip' || e.kind === 'bad' || e.kind === 'good';
            const cls = `csl-timeline__text${strong ? ' csl-timeline__text--strong' : ''}${e.kind === 'tip' ? ' csl-timeline__text--tip' : ''}`;
            const latest = nowMs !== undefined && i === 0;
            const itemCls = `csl-timeline__item${latest ? ' csl-timeline__item--latest' : ''}${ALERT.has(e.kind) ? ' csl-timeline__item--alert' : ''}`;
            return (
              <li key={`${e.tMs}-${e.text}`} className={itemCls} data-kind={e.kind}>
                <span className="csl-timeline__time">{timeLabel(e)}</span>
                <span className="csl-timeline__dot" style={{ background: DOT[e.kind] }} aria-hidden="true" />
                <span className={cls}>{e.text}</span>
              </li>
            );
          })}
        </ol>
      )}
    </>
  );
}
