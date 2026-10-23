import type { RunConfig } from '../engine/config';
import type { RunResult } from '../engine/result';
import { assessRecovery, type RecoveryResult } from './recovery';
import { computeSignals, type Signals } from './signals';
import { buildTimeline, type TimelineEntry } from './timeline';

export interface Analysis {
  recovery: RecoveryResult;
  signals: Signals;
  timeline: TimelineEntry[];
}

/** Everything the UI shows about one run, given the run and its no-failure control. */
export function analyzeRun(run: RunResult, control: RunResult, config: RunConfig, labels: Record<string, string> = {}): Analysis {
  const recovery = assessRecovery(run, control, config);
  const signals = computeSignals(run, config, recovery);
  return { recovery, signals, timeline: buildTimeline(run, config, recovery, signals, labels) };
}
