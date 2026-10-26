/** Chooses which instance (copy) of a tier receives an attempt: the tier's instance router. */
export interface LoadBalancer {
  pick(instanceCount: number): number;
}

/**
 * Round-robin across instances, counting every attempt (including retries).
 * ASSUMPTION: routing between a tier's own copies is free: no capacity or timeouts of its own (PLAN.md
 * 9.4). Not to be confused with the "Load balancer" part users draw, which is a tier with workers,
 * cores and timeouts like any other.
 */
export class RoundRobin implements LoadBalancer {
  private next = 0;

  pick(instanceCount: number): number {
    const i = this.next % instanceCount;
    this.next++;
    return i;
  }
}
