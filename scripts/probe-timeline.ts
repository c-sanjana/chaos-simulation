/** Exploration helper: print the analysis for the retry storm (not part of the app). */
import { runSimulation } from '../src/engine/run';
import { buildRunConfig } from '../src/data/buildConfig';
import { webChain } from '../src/data/topologies';
import { retryStorm } from '../src/data/scenarios';
import { controlConfig } from '../src/analysis/recovery';
import { analyzeRun } from '../src/analysis/analyze';

const labels = Object.fromEntries(Object.entries(webChain.layout).map(([id, l]) => [id, l.label]));
for (const retries of [3, 0]) {
  const cfg = buildRunConfig(webChain, retryStorm, { retries });
  const a = analyzeRun(runSimulation(cfg), runSimulation(controlConfig(cfg)), cfg, labels);
  console.log(`\n=== retries ${retries}: ${a.recovery.verdict} (failed requests ${a.recovery.failedRequests})`);
  for (const e of a.timeline) console.log(`${(e.tMs / 1000).toFixed(0).padStart(4)}s${e.endMs ? '–' + (e.endMs / 1000).toFixed(0) + 's' : ''}  [${e.kind}] ${e.text}`);
  console.log('signals', JSON.stringify(a.signals));
}
