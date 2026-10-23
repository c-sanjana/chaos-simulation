import { useCallback, useEffect, useState } from 'react';

export const DEFAULT_SPEEDS = [1, 4, 16];

/**
 * ASSUMPTION: a single frame never advances more than this much real time. Browsers pause
 * requestAnimationFrame in background tabs; without a cap, returning to the tab would jump
 * the playhead by the whole time away.
 */
export const MAX_FRAME_MS = 250;

export interface PlaybackState {
  tMs: number;
  playing: boolean;
  speed: number;
}

export interface Playback extends PlaybackState {
  speeds: number[];
  play: () => void;
  pause: () => void;
  toggle: () => void;
  seek: (tMs: number) => void;
  setSpeed: (speed: number) => void;
}

/**
 * Playback clock for a run of `durationMs` simulated milliseconds. At speed 1, one simulated
 * second passes per real second. Stops at the end; playing again from the end restarts at 0.
 */
export function usePlayback(durationMs: number, { speeds = DEFAULT_SPEEDS }: { speeds?: number[] } = {}): Playback {
  const [state, setState] = useState<PlaybackState>({ tMs: 0, playing: false, speed: speeds[0] ?? 1 });

  useEffect(() => {
    if (!state.playing) return;
    let last: number | null = null;
    let frame = requestAnimationFrame(function step(now: number) {
      if (last !== null) {
        const dt = Math.min(MAX_FRAME_MS, Math.max(0, now - last));
        setState((s) => {
          const tMs = Math.min(durationMs, s.tMs + dt * s.speed);
          return { ...s, tMs, playing: tMs < durationMs };
        });
      }
      last = now;
      frame = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frame);
  }, [state.playing, durationMs]);

  const started = useCallback(
    (s: PlaybackState): PlaybackState => ({ ...s, playing: true, tMs: s.tMs >= durationMs ? 0 : s.tMs }),
    [durationMs],
  );
  const play = useCallback(() => setState(started), [started]);
  const pause = useCallback(() => setState((s) => ({ ...s, playing: false })), []);
  const toggle = useCallback(() => setState((s) => (s.playing ? { ...s, playing: false } : started(s))), [started]);
  const seek = useCallback(
    (tMs: number) => setState((s) => ({ ...s, tMs: Math.min(durationMs, Math.max(0, tMs)) })),
    [durationMs],
  );
  const setSpeed = useCallback((speed: number) => setState((s) => ({ ...s, speed })), []);

  // A shorter new run should not leave the playhead past its end.
  const tMs = Math.min(state.tMs, durationMs);
  return { ...state, tMs, speeds, play, pause, toggle, seek, setSpeed };
}
