/** Chooses which instance of a tier receives an attempt. */
export interface LoadBalancer {
  pick(instanceCount: number): number;
}

/**
 * Round-robin across instances, counting every attempt (including retries).
 * ASSUMPTION: the load balancer is a routing policy with no capacity or timeouts of its own (PLAN.md 9.4).
 */
export class RoundRobin implements LoadBalancer {
  private next = 0;

  pick(instanceCount: number): number {
    const i = this.next % instanceCount;
    this.next++;
    return i;
  }
}
