/**
 * Progress of the simulation running on this thread, for long single runs ("Simulating… 40%").
 *
 * ASSUMPTION: the engine is synchronous, so a thread runs one simulation at a time and a single
 * module-level listener can't be confused between runs. Reporting never schedules events or
 * touches the run's state, so a run gives the same result with or without a listener.
 */

/** The event loop reports every this many events (a power of two, minus one, as a bit mask). */
export const PROGRESS_EVERY_EVENTS_MASK = 0x3fff;

let listener: ((simulatedMs: number) => void) | null = null;

/** Runs `f` with `onTick` hearing the simulated time now and then; restores the previous listener after. */
export function withSimulationProgress<T>(onTick: ((simulatedMs: number) => void) | null, f: () => T): T {
  const previous = listener;
  listener = onTick;
  try {
    return f();
  } finally {
    listener = previous;
  }
}

/** Called by the event loop. */
export function reportSimulationProgress(simulatedMs: number): void {
  listener?.(simulatedMs);
}
