export interface StoryStepView {
  /** Run time (ms) at which the replay has shown this step. */
  tMs: number;
  text: string;
  tone: 'fault' | 'bad' | 'good' | 'info';
}

/**
 * The run told in plain words, one numbered step at a time as the replay reaches it (oldest
 * first, because it is a chain of cause and effect). Steps ahead of the replay stay hidden, so
 * the ending isn't given away.
 */
export function StoryCard({ steps, nowMs }: { steps: StoryStepView[]; nowMs: number }) {
  const shown = steps.filter((s) => s.tMs <= nowMs);
  const ahead = steps.length - shown.length;
  return (
    <section className="csl-story" aria-label="What is happening, in plain words" data-tour="story">
      <h3 className="csl-story__title">What's happening, in plain words</h3>
      {shown.length === 0 ? (
        <p className="csl-story__empty">Everything is normal so far. Watch what happens when the failure starts.</p>
      ) : (
        <ol className="csl-story__list">
          {shown.map((s, i) => (
            <li key={`${s.tMs}-${s.text}`} className={`csl-story__step csl-story__step--${s.tone}${i === shown.length - 1 ? ' csl-story__step--latest' : ''}`}>
              {s.text}
            </li>
          ))}
        </ol>
      )}
      {ahead > 0 && shown.length > 0 && <p className="csl-story__ahead">More as the replay continues…</p>}
    </section>
  );
}
