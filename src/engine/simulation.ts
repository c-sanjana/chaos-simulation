import { EventQueue } from './eventQueue';

/**
 * The event loop: a clock plus a time-ordered queue of callbacks.
 * Ties are broken in scheduling order, so a run is bit-for-bit repeatable.
 */
export class Simulation {
  now = 0;
  eventsProcessed = 0;
  private readonly events = new EventQueue();

  constructor(readonly seed: number) {}

  /** Runs `fire` at absolute time `timeMs` (never earlier than now). */
  schedule(timeMs: number, fire: () => void): void {
    this.events.push(Math.max(timeMs, this.now), fire);
  }

  /** Processes events up to and including `untilMs`; later events are left unprocessed. */
  run(untilMs: number): void {
    while (this.events.size > 0 && this.events.peekTime() <= untilMs) {
      this.now = this.events.peekTime();
      const fire = this.events.pop()!;
      fire();
      this.eventsProcessed++;
    }
    this.now = untilMs;
  }
}
