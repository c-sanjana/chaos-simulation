export interface PlaybackBarProps {
  tMs: number;
  durationMs: number;
  playing: boolean;
  speed: number;
  speeds: number[];
  /** Failure windows in milliseconds (same unit as tMs), tinted on the scrubber. */
  failureWindows: Array<[number, number]>;
  onPlayPause: () => void;
  onSeek: (tMs: number) => void;
  onSpeed: (speed: number) => void;
}

/** Scrubber granularity: whole simulated seconds, which is also the keyboard arrow step. */
const SEEK_STEP_MS = 1000;

function pct(ms: number, durationMs: number): number {
  if (durationMs <= 0) return 0;
  return Math.min(100, Math.max(0, (ms / durationMs) * 100));
}

function PlayIcon({ playing }: { playing: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      {playing ? <path d="M6 4h4v16H6zM14 4h4v16h-4z" /> : <path d="M6 4l14 8-14 8z" />}
    </svg>
  );
}

/** Play/pause, a scrubber with the failure window tinted, a time readout and speed buttons. */
export function PlaybackBar({ tMs, durationMs, playing, speed, speeds, failureWindows, onPlayPause, onSeek, onSpeed }: PlaybackBarProps) {
  const nowS = Math.floor(tMs / 1000);
  const durS = Math.round(durationMs / 1000);
  const at = pct(tMs, durationMs);
  return (
    <div className="csl-playback">
      <button type="button" className="csl-playback__play" aria-label={playing ? 'Pause' : 'Play'} onClick={onPlayPause}>
        <PlayIcon playing={playing} />
      </button>
      <div className="csl-scrubber">
        <div className="csl-scrubber__track">
          {failureWindows.map(([from, to], i) => (
            <div
              key={i}
              className="csl-scrubber__window"
              data-testid="scrubber-window"
              style={{ left: `${pct(from, durationMs)}%`, width: `${pct(to, durationMs) - pct(from, durationMs)}%` }}
            />
          ))}
          <div className="csl-scrubber__fill" data-testid="scrubber-fill" style={{ width: `${at}%` }} />
          <div className="csl-scrubber__thumb" style={{ left: `${at}%` }} />
        </div>
        <input
          type="range"
          className="csl-scrubber__input"
          aria-label="Playback position"
          aria-valuetext={`${nowS} seconds of ${durS}`}
          min={0}
          max={durationMs}
          step={SEEK_STEP_MS}
          value={tMs}
          onChange={(e) => onSeek(Number(e.target.value))}
        />
      </div>
      <span className="csl-playback__readout">
        t = {nowS} s / {durS} s
      </span>
      <div className="csl-speeds" role="group" aria-label="Playback speed">
        {speeds.map((s) => (
          <button key={s} type="button" className="csl-speed" aria-label={`Speed ${s}×`} aria-pressed={s === speed} onClick={() => onSpeed(s)}>
            {s}×
          </button>
        ))}
      </div>
    </div>
  );
}
