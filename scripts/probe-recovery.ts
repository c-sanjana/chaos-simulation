/** Exploration helper: recovery verdicts across the retry-storm map (not part of the app). */
import { runSimulation } from '../src/engine/run';
import { buildRunConfig } from '../src/data/buildConfig';
import { webChain } from '../src/data/topologies';
import { retryStorm } from '../src/data/scenarios';
import { assessRecovery, controlConfig } from '../src/analysis/recovery';

console.log('retries \\ rps', retryStorm.map.x.values.join('\t'));
for (const retries of retryStorm.map.y.values) {
  const row = retryStorm.map.x.values.map((rps) => {
    const cfg = buildRunConfig(webChain, retryStorm, { rps, retries });
    const r = assessRecovery(runSimulation(cfg), runSimulation(controlConfig(cfg)), cfg);
    return r.verdict === 'recovered' ? `${(r.recoveryMs! / 1000).toFixed(0)}s` : r.verdict.slice(0, 5);
  });
  console.log(retries, '\t', row.join('\t'));
}
