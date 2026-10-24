/**
 * Stands in for a run player while its run is simulated, at about the player's height so the
 * page doesn't jump when the player appears. Long runs show how far along they are, and can offer
 * a way to stop.
 */
export function PlayerPlaceholder({ text, progress, minHeight, onCancel }: { text: string; progress?: number; minHeight: number; onCancel?: () => void }) {
  const percent = progress === undefined ? null : Math.round(progress * 100);
  return (
    <section className="csl-card csl-card--compact" aria-busy="true" style={{ minHeight }}>
      <p className="csl-status" style={{ margin: 0 }}>
        {text}
        {percent !== null && <span className="csl-mono"> {percent}%</span>}
      </p>
      {percent !== null && <progress value={percent} max={100} aria-label="Simulation progress" style={{ width: '100%' }} />}
      {onCancel && (
        <div>
          <button type="button" className="csl-btn csl-btn--small" onClick={onCancel}>
            Stop this run
          </button>
        </div>
      )}
    </section>
  );
}
