import { callWithRetries, type CallTarget } from './caller';
import type { ClientConfig } from './config';
import { exponential } from './distributions';
import type { ClientMetrics } from './metrics';
import { Stream, uniform } from './rng';
import type { Simulation } from './simulation';

/**
 * Open-loop traffic: requests arrive as a Poisson process at `rps` regardless of how the system is
 * doing, the way independent users behave. Arrival n's time depends only on the seed and n, so every
 * run with the same seed and rate sees exactly the same traffic.
 */
export class Client {
  constructor(
    private readonly sim: Simulation,
    private readonly config: ClientConfig,
    private readonly entry: CallTarget,
    private readonly metrics: ClientMetrics,
    private readonly durationMs: number,
  ) {}

  start(): void {
    this.scheduleArrival(0, 0);
  }

  private scheduleArrival(previousMs: number, n: number): void {
    const gap = exponential(uniform(this.sim.seed, Stream.Arrival, n), 1000 / this.config.rps);
    const at = previousMs + gap;
    if (at >= this.durationMs) return;
    this.sim.schedule(at, () => {
      this.send(n);
      this.scheduleArrival(at, n + 1);
    });
  }

  private send(requestId: number): void {
    this.metrics.requestSent(requestId, this.sim.now);
    callWithRetries(this.sim, this.config.call, this.entry, requestId, 0, null, (ok) =>
      this.metrics.requestDone(requestId, this.sim.now, ok),
    );
  }
}
