import { useState } from 'react';
import { Timeline, timeLabel } from './Timeline';
import type { TimelineEntryView } from './types';

const MARK: Record<TimelineEntryView['kind'], string> = { fault: '⚡', tip: '◆', bad: '✕', good: '✓', info: '•' };

export interface EventTrackProps {
  entries: TimelineEntryView[];
  /** Replay position: events ahead of it are not shown. */
  nowMs: number;
  failureWindows: Array<[number, number]>;
}

/**
 * The measured events as a row of icons in the order they happened, each with its time, instead
 * of a wall of text; those during the failure sit on a tinted band. The newest event (or the one
 * the viewer points at) is spelled out underneath, and "List" shows them all as text.
 * ASSUMPTION: order matters more than spacing here. Most events bunch up within seconds of the
 * failure, so a to-scale strip in a narrow column would pile them on top of each other.
 * Like the list, it only shows what the replay has reached (a range once the replay reaches its end).
 */
export function EventTrack({ entries, nowMs, failureWindows }: EventTrackProps) {
  const [mode, setMode] = useState<'track' | 'list'>('track');
  const [picked, setPicked] = useState<TimelineEntryView | null>(null);
  const revealAt = (e: TimelineEntryView) => e.endMs ?? e.tMs;
  const reached = entries.filter((e) => revealAt(e) <= nowMs).sort((a, b) => a.tMs - b.tMs || revealAt(a) - revealAt(b));
  const latest = reached.reduce<TimelineEntryView | null>((l, e) => (l === null || revealAt(e) >= revealAt(l) ? e : l), null);
  const focus = picked && reached.includes(picked) ? picked : latest;
  const during = (e: TimelineEntryView) => failureWindows.some(([a, b]) => e.tMs >= a && e.tMs < b);

  return (
    <div className="csl-track">
      <div className="csl-track__bar">
        <span className="csl-track__count">
          {reached.length} of {entries.length} events
        </span>
        <div className="csl-segmented csl-segmented--small" role="group" aria-label="Show events as">
          <button type="button" aria-pressed={mode === 'track'} onClick={() => setMode('track')}>
            Icons
          </button>
          <button type="button" aria-pressed={mode === 'list'} onClick={() => setMode('list')}>
            List
          </button>
        </div>
      </div>
      {mode === 'list' ? (
        <div className="csl-track__list">
          <Timeline entries={entries} nowMs={nowMs} />
        </div>
      ) : reached.length === 0 ? (
        <p className="csl-empty">Events appear here as the replay reaches them.</p>
      ) : (
        <>
          <ol className="csl-track__steps">
            {reached.map((e) => (
              <li key={`${e.tMs}-${e.text}`} className={`csl-track__step${during(e) ? ' csl-track__step--during' : ''}`}>
                <button
                  type="button"
                  className={`csl-track__mark csl-track__mark--${e.kind}${e === focus ? ' csl-track__mark--focus' : ''}`}
                  aria-label={`${timeLabel(e)}: ${e.text}`}
                  aria-pressed={e === focus}
                  title={`${timeLabel(e)}: ${e.text}`}
                  onMouseEnter={() => setPicked(e)}
                  onFocus={() => setPicked(e)}
                  onClick={() => setPicked(e)}
                >
                  <span aria-hidden="true">{MARK[e.kind]}</span>
                </button>
                <span className="csl-track__time" aria-hidden="true">
                  {Math.round(e.tMs / 1000)} s
                </span>
              </li>
            ))}
          </ol>
          {focus && (
            <p className={`csl-track__detail csl-track__detail--${focus.kind}`}>
              <span className="csl-track__detail-time">{timeLabel(focus)}</span> {focus.text}
            </p>
          )}
          {failureWindows.length > 0 && (
            <p className="csl-track__key" aria-hidden="true">
              <span className="csl-track__key-band" /> during the failure
            </p>
          )}
        </>
      )}
    </div>
  );
}
