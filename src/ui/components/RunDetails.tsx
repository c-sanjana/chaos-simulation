import { useState } from 'react';
import { Cascade, ICON, Meter, stepTime, type StoryStepView } from './StoryCard';
import { timeLabel } from './Timeline';
import type { TimelineEntryView } from './types';

export interface RunDetailsProps {
  /** The run told in plain words, step by step (analysis/story.ts). */
  steps: StoryStepView[];
  /** What was measured (analysis/timeline.ts): attached to the step whose stretch of the run it falls in. */
  entries: TimelineEntryView[];
  /** Replay position: steps and measurements ahead of it are not shown. */
  nowMs: number;
  failureWindows: Array<[number, number]>;
  /** e.g. " (after the fix)" on step 3. */
  titleSuffix?: string;
}

/** Step tone → the track's marker colours (shared with the measured events' kinds). */
const MARK_TONE: Record<StoryStepView['tone'], TimelineEntryView['kind']> = { fault: 'fault', bad: 'bad', good: 'good', info: 'info' };

/**
 * One panel for what happened in the run (user decision, 2026-10-25: "What's happening" and
 * "Details: what was measured" told the same events twice). The story's steps are the events: a
 * row of icons in order, the newest (or the one pointed at) spelled out underneath with its few
 * words, its key number, the sentence that explains it, its meter or retry cascade, and the
 * measurements taken in its stretch of the run (from that step to the next). "List" shows every
 * step reached so far that way.
 *
 * Measured events that only restate a step are left out: a failure starting or ending is always a
 * step of its own.
 */
export function RunDetails({ steps, entries, nowMs, failureWindows, titleSuffix = '' }: RunDetailsProps) {
  const [mode, setMode] = useState<'track' | 'list'>('track');
  const [picked, setPicked] = useState<StoryStepView | null>(null);
  const reached = steps.filter((s) => s.tMs <= nowMs);
  const latest = reached[reached.length - 1] ?? null;
  const focus = picked && reached.includes(picked) ? picked : latest;
  const during = (s: StoryStepView) => s.kind !== 'stuck' && s.kind !== 'recovered' && failureWindows.some(([a, b]) => s.tMs >= a && s.tMs < b);
  const measured = measuredBySteps(steps, entries, nowMs);
  const ahead = steps.length - reached.length;

  return (
    <section className="csl-timeline-window csl-details" data-tour="timeline" aria-label="Details: what was measured">
      <h3 className="csl-timeline-title">Details: what was measured{titleSuffix}</h3>
      <div className="csl-timeline-window__body">
        <div className="csl-track">
          <div className="csl-track__bar">
            <span className="csl-track__count">
              {reached.length} of {steps.length} events
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
          {reached.length === 0 ? (
            <p className="csl-empty">All normal so far. Watch what happens when the failure starts.</p>
          ) : mode === 'list' ? (
            <ol className="csl-flow csl-details__list">
              {reached.map((s) => (
                <Step key={stepKey(s)} step={s} measured={measured.get(s) ?? []} latest={s === latest} />
              ))}
            </ol>
          ) : (
            <>
              <ol className="csl-track__steps">
                {reached.map((s) => (
                  <li key={stepKey(s)} className={`csl-track__step${during(s) ? ' csl-track__step--during' : ''}`}>
                    <button
                      type="button"
                      className={`csl-track__mark csl-track__mark--${MARK_TONE[s.tone]}${s === focus ? ' csl-track__mark--focus' : ''}`}
                      aria-label={`${stepTime(s)}: ${s.headline ?? s.text}`}
                      aria-current={s === focus ? 'true' : undefined}
                      title={`${stepTime(s)}: ${s.headline ?? s.text}`}
                      onMouseEnter={() => setPicked(s)}
                      onFocus={() => setPicked(s)}
                      onClick={() => setPicked(s)}
                    >
                      <span aria-hidden="true">{ICON[s.kind ?? 'info']}</span>
                    </button>
                    <span className="csl-track__time" aria-hidden="true">
                      {s.kind === 'stuck' && s.tMs > 0 ? 'end' : `${Math.round(s.tMs / 1000)} s`}
                    </span>
                  </li>
                ))}
              </ol>
              {focus && (
                <ol className="csl-flow csl-details__focus" aria-label="Selected event">
                  <Step step={focus} measured={measured.get(focus) ?? []} latest />
                </ol>
              )}
              {failureWindows.length > 0 && (
                <p className="csl-track__key" aria-hidden="true">
                  <span className="csl-track__key-band" /> during the failure
                </p>
              )}
            </>
          )}
          {ahead > 0 && reached.length > 0 && <p className="csl-story__ahead">{ahead} more as the replay continues…</p>}
        </div>
      </div>
    </section>
  );
}

/** One step: icon, few words and number, when, the sentence, its picture, and what was measured then. */
function Step({ step: s, measured, latest }: { step: StoryStepView; measured: TimelineEntryView[]; latest: boolean }) {
  return (
    <li className={`csl-flow__step csl-flow__step--${s.tone}${latest ? ' csl-flow__step--latest' : ''}`}>
      <span className="csl-flow__icon" aria-hidden="true">
        {ICON[s.kind ?? 'info']}
      </span>
      <span className="csl-flow__body">
        <span className="csl-flow__line">
          <span className="csl-flow__headline">{s.headline ?? s.text}</span>
          {s.figure && <span className="csl-flow__figure">{s.figure}</span>}
        </span>
        <span className="csl-flow__time">{stepTime(s)}</span>
        {s.headline && <span className="csl-flow__text">{s.text}</span>}
        {s.meter !== undefined && <Meter value={s.meter} />}
        {s.cascade && <Cascade layers={s.cascade} />}
        {measured.length > 0 && (
          <span className="csl-details__measured">
            <span className="csl-details__measured-title">Measured</span>
            <ul>
              {measured.map((e) => (
                <li key={`${e.tMs}-${e.text}`} className={`csl-details__entry csl-details__entry--${e.kind}`}>
                  <span className="csl-flow__time">{timeLabel(e)}</span> {e.text}
                </li>
              ))}
            </ul>
          </span>
        )}
      </span>
    </li>
  );
}

const stepKey = (s: StoryStepView) => `${s.tMs}-${s.headline ?? s.text}`;

/**
 * The measured events the replay has reached, each attached to the step whose stretch of the run
 * it falls in: the last step at or before it (the first step for anything earlier). A failure
 * starting or ending is left out: the story tells each as a step of its own.
 */
export function measuredBySteps(steps: StoryStepView[], entries: TimelineEntryView[], nowMs: number): Map<StoryStepView, TimelineEntryView[]> {
  const out = new Map<StoryStepView, TimelineEntryView[]>();
  if (steps.length === 0) return out;
  const revealAt = (e: TimelineEntryView) => e.endMs ?? e.tMs;
  for (const e of entries) {
    if (e.kind === 'fault' || revealAt(e) > nowMs) continue;
    const owner = [...steps].reverse().find((s) => s.tMs <= e.tMs) ?? steps[0];
    out.set(owner, [...(out.get(owner) ?? []), e]);
  }
  return out;
}
