import { useState } from 'react';

export interface StoryStepView {
  /** Run time (ms) at which the replay has shown this step. */
  tMs: number;
  /** The full sentence: shown under the newest row and on "Why?", and read by screen readers. */
  text: string;
  tone: 'fault' | 'bad' | 'good' | 'info';
  kind?: 'fault' | 'giveup' | 'back' | 'overload' | 'waste' | 'cache' | 'backlog' | 'recovered' | 'stuck' | 'info';
  /** A few words, e.g. "Database 8× slower"; the sentence is used when missing. */
  headline?: string;
  figure?: string;
  /** Load as a multiple of capacity. */
  meter?: number;
  cascade?: Array<{ who: string; retries: number }>;
}

const ICON: Record<NonNullable<StoryStepView['kind']>, string> = {
  fault: '⚡',
  giveup: '⏱',
  back: '↺',
  overload: '▲',
  waste: '∅',
  cache: '◌',
  backlog: '▤',
  recovered: '✓',
  stuck: '✕',
  info: '•',
};

/** Meters show up to this many times capacity (beyond it the bar is full and the figure says how far). */
const METER_MAX = 5;
/** Retry blocks drawn per caller (more are summarised by the number beside them). */
const BLOCKS_MAX = 8;

/**
 * When a step happened, as its row says it. A "still stuck" verdict is known only once the run has
 * ended, and the moment it is revealed (the end of the judged range) is not an event, so it says
 * "at the end of the run" rather than a time that looks like one (REVIEW2 1.11).
 */
export function stepTime(s: Pick<StoryStepView, 'tMs' | 'kind'>): string {
  return s.kind === 'stuck' && s.tMs > 0 ? 'at the end of the run' : `${Math.round(s.tMs / 1000)} s`;
}

/**
 * The run's story as an incident flow: one row per step, revealed as the replay reaches it (oldest
 * first: it is a chain of cause and effect). Each row is an icon, a few words and the key number;
 * an overload gets a meter against capacity and the retry cascade gets one bar per retrying layer.
 * The newest row also shows its full sentence, the one that explains the step; older rows show it
 * on "Why?" (visible on touch screens too, unlike a tooltip).
 *
 * `compact` (the step 2 and 3 replays, where there is less room) shows only the newest row, with
 * the "earlier steps" link beside the title.
 *
 * It is the one panel telling what happened, on every step (user decision, 2026-10-25: a separate
 * "Details: what was measured" panel repeated it, and merging the two into one gave too much text).
 */
export function StoryCard({ steps, nowMs, compact = false }: { steps: StoryStepView[]; nowMs: number; compact?: boolean }) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  /** Compact only: the viewer asked to see every step reached so far. */
  const [all, setAll] = useState(false);
  const reached = steps.filter((s) => s.tMs <= nowMs);
  const shown = compact && !all ? reached.slice(-1) : reached;
  const earlier = reached.length - shown.length;
  const ahead = steps.length - reached.length;
  const toggle = (key: string) =>
    setOpen((o) => {
      const next = new Set(o);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  return (
    <section className={`csl-story${compact ? ' csl-story--compact' : ''}`} aria-label="What is happening, in plain words" data-tour="story">
      {compact ? (
        <div className="csl-story__head">
          <h3 className="csl-story__title">What's happening</h3>
          {reached.length > 1 && (
            <button type="button" className="csl-btn csl-btn--link csl-story__more" aria-expanded={earlier === 0} onClick={() => setAll((a) => !a)}>
              {earlier > 0 ? `Show the ${earlier} earlier step${earlier === 1 ? '' : 's'}` : 'Show only the newest step'}
            </button>
          )}
        </div>
      ) : (
        <h3 className="csl-story__title">What's happening</h3>
      )}
      {shown.length === 0 ? (
        <p className="csl-story__empty">All normal so far. Watch what happens when the failure starts.</p>
      ) : (
        <ol className="csl-flow">
          {shown.map((s, i) => {
            const key = `${s.tMs}-${s.text}`;
            const latest = i === shown.length - 1;
            const explained = latest || open.has(key);
            return (
              <li key={key} className={`csl-flow__step csl-flow__step--${s.tone}${latest ? ' csl-flow__step--latest' : ''}`} title={s.text}>
                <span className="csl-sr-only">{s.text}</span>
                <span className="csl-flow__icon" aria-hidden="true">
                  {ICON[s.kind ?? 'info']}
                </span>
                <span className="csl-flow__body">
                  <span className="csl-flow__line" aria-hidden="true">
                    <span className="csl-flow__headline">{s.headline ?? s.text}</span>
                    {s.figure && <span className="csl-flow__figure">{s.figure}</span>}
                  </span>
                  <span className="csl-flow__meta">
                    <span className="csl-flow__time" aria-hidden="true">
                      {stepTime(s)}
                    </span>
                    {!latest && s.headline && (
                      <button type="button" className="csl-btn csl-btn--link csl-flow__why" aria-expanded={explained} aria-label={`Why: ${s.headline}`} onClick={() => toggle(key)}>
                        {explained ? 'Hide' : 'Why?'}
                      </button>
                    )}
                  </span>
                  {explained && s.headline && (
                    <span className="csl-flow__text" aria-hidden="true">
                      {s.text}
                    </span>
                  )}
                  {s.meter !== undefined && <Meter value={s.meter} />}
                  {s.cascade && <Cascade layers={s.cascade} />}
                </span>
              </li>
            );
          })}
        </ol>
      )}
      {ahead > 0 && shown.length > 0 && <p className="csl-story__ahead">{ahead} more as the replay continues…</p>}
    </section>
  );
}

/** Load against capacity: a track with a "capacity" tick at 1×, filled up to the load. */
function Meter({ value }: { value: number }) {
  const width = (Math.min(value, METER_MAX) / METER_MAX) * 100;
  return (
    <span className="csl-meter" aria-hidden="true">
      <span className={`csl-meter__fill${value > 1 ? ' csl-meter__fill--over' : ''}`} style={{ width: `${width}%` }} />
      <span className="csl-meter__tick" style={{ left: `${100 / METER_MAX}%` }} />
      <span className="csl-meter__label" style={{ left: `${100 / METER_MAX}%` }}>
        capacity
      </span>
    </span>
  );
}

/** How many times each layer asks again, as blocks: the cascade at a glance. */
function Cascade({ layers }: { layers: Array<{ who: string; retries: number }> }) {
  return (
    <span className="csl-cascade" aria-hidden="true">
      {layers.map((l) => (
        <span key={l.who} className="csl-cascade__layer">
          <span className="csl-cascade__who">{l.who}</span>
          <span className="csl-cascade__blocks">
            {Array.from({ length: Math.min(l.retries, BLOCKS_MAX) }, (_, i) => (
              <span key={i} className="csl-cascade__block" />
            ))}
          </span>
          <span className="csl-cascade__n">{l.retries}×</span>
        </span>
      ))}
    </span>
  );
}
