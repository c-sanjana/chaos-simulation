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

/**
 * "Why" timeline: what happened during the run, in the order given.
 * With `nowMs` (the replay position) it plays along: only events the replay has reached are shown,
 * the newest highlighted, with a count of what is still ahead.
 */
export function Timeline({ entries, nowMs }: { entries: TimelineEntryView[]; nowMs?: number }) {
  if (entries.length === 0) return <p className="csl-empty">Nothing notable detected.</p>;
  const shown = nowMs === undefined ? entries : entries.filter((e) => e.tMs <= nowMs);
  const ahead = entries.length - shown.length;
  return (
    <>
      {shown.length === 0 ? (
        <p className="csl-empty">Events appear here as the replay reaches them.</p>
      ) : (
        <ol className="csl-timeline" aria-live="polite">
          {shown.map((e, i) => {
            const strong = e.kind === 'tip' || e.kind === 'bad' || e.kind === 'good';
            const cls = `csl-timeline__text${strong ? ' csl-timeline__text--strong' : ''}${e.kind === 'tip' ? ' csl-timeline__text--tip' : ''}`;
            const latest = nowMs !== undefined && i === shown.length - 1;
            return (
              <li key={i} className={`csl-timeline__item${latest ? ' csl-timeline__item--latest' : ''}`} data-kind={e.kind}>
                <span className="csl-timeline__time">{timeLabel(e)}</span>
                <span className="csl-timeline__dot" style={{ background: DOT[e.kind] }} aria-hidden="true" />
                <span className={cls}>{e.text}</span>
              </li>
            );
          })}
        </ol>
      )}
      {ahead > 0 && shown.length > 0 && (
        <p className="csl-timeline__ahead">
          {ahead} more event{ahead === 1 ? '' : 's'} ahead
        </p>
      )}
    </>
  );
}
