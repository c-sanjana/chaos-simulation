export interface StoryStepView {
  /** Run time (ms) at which the replay has shown this step. */
  tMs: number;
  /** The full sentence (tooltip and screen readers). */
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
 * The run's story as an incident flow: one row per step, revealed as the replay reaches it (oldest
 * first: it is a chain of cause and effect). Each row is an icon, a few words and the key number;
 * an overload gets a meter against capacity and the retry cascade gets one bar per retrying layer.
 * The full sentence is the row's tooltip and what screen readers read.
 */
export function StoryCard({ steps, nowMs }: { steps: StoryStepView[]; nowMs: number }) {
  const shown = steps.filter((s) => s.tMs <= nowMs);
  const ahead = steps.length - shown.length;
  return (
    <section className="csl-story" aria-label="What is happening, in plain words" data-tour="story">
      <h3 className="csl-story__title">What's happening</h3>
      {shown.length === 0 ? (
        <p className="csl-story__empty">All normal so far. Watch what happens when the failure starts.</p>
      ) : (
        <ol className="csl-flow">
          {shown.map((s, i) => (
            <li key={`${s.tMs}-${s.text}`} className={`csl-flow__step csl-flow__step--${s.tone}${i === shown.length - 1 ? ' csl-flow__step--latest' : ''}`} title={s.text}>
              <span className="csl-sr-only">{s.text}</span>
              <span className="csl-flow__icon" aria-hidden="true">
                {ICON[s.kind ?? 'info']}
              </span>
              <span className="csl-flow__body" aria-hidden="true">
                <span className="csl-flow__line">
                  <span className="csl-flow__headline">{s.headline ?? s.text}</span>
                  {s.figure && <span className="csl-flow__figure">{s.figure}</span>}
                </span>
                <span className="csl-flow__time">{Math.round(s.tMs / 1000)} s</span>
                {s.meter !== undefined && <Meter value={s.meter} />}
                {s.cascade && <Cascade layers={s.cascade} />}
              </span>
            </li>
          ))}
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
    <span className="csl-meter">
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
    <span className="csl-cascade">
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
