import type { Fault } from '../engine/config';
import type { Axis, TopologyPreset } from './types';

/*
 * The failure is set up in one place, the failure editor's "What fails" (user decision, 2026-10-25:
 * preset cards beside it were a second, less complete way to do the same thing). What a scenario
 * says about its failure (its name, and the failure lengths on the tipping map) therefore follows
 * from the failure itself, by these rules, for the example and built systems alike.
 */

/**
 * The tipping map's failure lengths (seconds, longest first) for the failure that matters most (the
 * first): measured per kind of failure with the default retries (see PLAN.md), so the map shows
 * where it starts to tip.
 * - a cache going down and coming back empty: 1 s recovers everywhere; it tips from ~3 s;
 * - the front door (the part users call) slowing: it has lots of spare capacity, so it takes longer;
 * - the work behind a queue slowing: the queue absorbs it for longest;
 * - anything else (a database slowing, a part going down), or no failure: up to 2 s always recovers.
 */
export function failureLengths(topology: TopologyPreset, fault: Fault | undefined): number[] {
  const tier = topology.tiers.find((t) => t.id === fault?.tier);
  if (tier?.cache && fault?.kind === 'dead' && fault.flushAtEnd) return [20, 10, 5, 3, 1];
  if (fault?.kind === 'slow' && fault.tier === topology.clientCall.target) return [30, 20, 10, 5, 2];
  if (fault?.kind === 'slow' && behindQueue(topology, fault.tier)) return [40, 20, 10, 5, 2];
  return [12, 8, 5, 3, 2, 1];
}

/** The map's failure-length axis for these failures. */
export function failureAxis(topology: TopologyPreset, faults: Fault[]): Axis {
  return { param: 'outageMs', label: 'failure length', values: failureLengths(topology, faults[0]).map((s) => s * 1000) };
}

/**
 * The scenario's name, from its first failure: "DB slows down", "Cache restarts empty", "One App
 * server copy goes down"; "+ 1 more failure" when there are more. Plain about the part itself,
 * even behind a queue (the map's lengths account for the queue).
 */
export function failureTitle(topology: TopologyPreset, faults: Fault[]): string {
  const f = faults[0];
  if (!f) return 'No failure';
  const label = (id: string) => topology.layout[id]?.label ?? id;
  const main =
    f.kind === 'slow'
      ? f.instance === undefined
        ? `${label(f.tier)} slows down`
        : `One ${label(f.tier)} copy slows down`
      : f.flushAtEnd
        ? `${label(f.tier)} restarts empty`
        : f.instance === undefined
          ? `${label(f.tier)} goes down`
          : `One ${label(f.tier)} copy goes down`;
  const more = faults.length - 1;
  return more > 0 ? `${main} + ${more} more failure${more === 1 ? '' : 's'}` : main;
}

/** The queue whose consumers call `tierId` (the work behind it), or undefined. */
function behindQueue(topology: TopologyPreset, tierId: string): string | undefined {
  return topology.tiers.find((t) => t.queue && t.downstream?.target === tierId)?.id;
}
