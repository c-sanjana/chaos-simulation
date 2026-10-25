/**
 * Step 2's sentences about the tipping-point map, as pure functions of the map's results. The
 * tipping point is read from stuck cells only; overload (too much traffic even without the
 * failure) is reported separately and never called a tipping point (PLAN.md, 2026-10-24).
 */
import type { Verdict } from '../analysis/recovery';
import type { Axis } from '../data/types';
import type { TippingPoint } from '../sweep/sweep';
import { countsText, retriesByCaller, type RetryCall } from './draft';
import { axisPhrase } from './viewModels';

export interface TippingSentenceInput {
  /** The tipping point of the row being described (the clicked cell's row). */
  tip: TippingPoint;
  yAxis: Axis;
  /** The viewer's own settings, and how their cell came out (undefined if it isn't on the map). */
  current: { x: number; y: number };
  currentVerdict?: Verdict;
}

/**
 * What the row says, e.g. "With a 5 s failure, the system tips at 100 req/s. Your 200 req/s is
 * past it: everything looks healthy until a failure like this happens." The part about the
 * viewer's own traffic is said only for their own row, and the "healthy until a failure" claim
 * only when their own cell got stuck (not when it is overloaded even without the failure).
 */
export function tippingSentence({ tip, yAxis, current, currentVerdict }: TippingSentenceInput): string {
  const at = `With ${axisPhrase(yAxis, tip.y)}`;
  const overload = tip.overloadedFromX === null ? '' : ` From ${tip.overloadedFromX} req/s there is too much traffic even without the failure.`;
  let row: string;
  if (tip.irregular && tip.firstStuckX !== null && tip.tipsAtX !== null && tip.firstStuckX < tip.tipsAtX) {
    row = `${at}, the system tips around ${tip.firstStuckX}–${tip.tipsAtX} req/s (a noisy boundary: in between, some runs recover and some get stuck).`;
  } else if (tip.irregular && tip.tipsAtX === null && tip.firstStuckX !== null) {
    row = `${at}, some traffic levels get stuck and others recover, so there is no clear tipping point (a noisy boundary).`;
  } else if (tip.tipsAtX !== null) {
    row = `${at}, the system tips at ${tip.tipsAtX} req/s.`;
  } else if (tip.overloadedFromX !== null) {
    row = `${at}, the failure never leaves the system stuck at the traffic shown.`;
  } else {
    row = `${at}, the system recovers at every traffic level shown.`;
  }
  return row + overload + yourPart(tip, current, currentVerdict);
}

function yourPart(tip: TippingPoint, current: { x: number; y: number }, verdict: Verdict | undefined): string {
  if (tip.y !== current.y || verdict === undefined) return '';
  const yours = `Your ${current.x} req/s`;
  if (verdict === 'overloaded') return ` ${yours} is more than the system can carry even without a failure.`;
  if (verdict === 'stuck' && tip.tipsAtX !== null && current.x >= tip.tipsAtX) return ` ${yours} is past it: everything looks healthy until a failure like this happens.`;
  if (verdict === 'stuck') return ` ${yours} gets stuck.`;
  if (tip.tipsAtX !== null && current.x < tip.tipsAtX) return ` ${yours} is below it.`;
  return '';
}

/**
 * Who asks again, using the same every/several rule as the story: "Every layer asks again when it
 * gives up (Client 5×, Load balancer 3×, App server 1×), so one failed answer can come back as many
 * requests." With one retrying caller it names that caller; with none it says nothing.
 */
export function cascadeSentence(calls: RetryCall[], labels: Record<string, string>): string {
  // One entry per caller: a part that calls several parts reads "App server 1× / 2×".
  const retrying = retriesByCaller(calls.filter((c) => c.retries > 0));
  if (retrying.length === 0) return '';
  const name = (id: string) => labels[id] ?? id;
  const list = retrying.map((g) => `${name(g.caller)} ${countsText(g.counts)}`).join(', ');
  if (retrying.length === 1) {
    const g = retrying[0];
    return `${name(g.caller)} asks again when it gives up (${countsText(g.counts)}), so one failed answer can come back as more requests.`;
  }
  const every = retrying.length === retriesByCaller(calls).length;
  return `${every ? 'Every layer asks again when it gives' : 'Several layers ask again when they give'} up (${list}), so one failed answer can come back as many requests.`;
}
