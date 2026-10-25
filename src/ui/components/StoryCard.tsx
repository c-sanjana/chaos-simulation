/**
 * The pieces of the run's plain-words story (analysis/story.ts) as RunDetails draws them: the step
 * type, its icons, when it happened, and its two pictures (a meter against capacity, the retry
 * cascade). The story used to have a card of its own; it is now the backbone of the one details
 * panel (RunDetails.tsx).
 */
export interface StoryStepView {
  /** Run time (ms) at which the replay has shown this step. */
  tMs: number;
  /** The full sentence that explains the step. */
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

export const ICON: Record<NonNullable<StoryStepView['kind']>, string> = {
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

/** Load against capacity: a track with a "capacity" tick at 1×, filled up to the load. */
export function Meter({ value }: { value: number }) {
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
export function Cascade({ layers }: { layers: Array<{ who: string; retries: number }> }) {
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
