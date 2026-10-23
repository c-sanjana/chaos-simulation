/** Exploration helper (not part of the app): prints recovered/stuck across traffic × retries. */
import { runSimulation } from '../src/engine/run';
import { buildRunConfig } from '../src/data/buildConfig';
import { webChain } from '../src/data/topologies';
import { retryStorm } from '../src/data/scenarios';

const rpsValues = retryStorm.map.x.values;
console.log('retries \\ rps', rpsValues.join('\t'));
for (const retries of retryStorm.map.y.values) {
  const row: string[] = [];
  for (const rps of rpsValues) {
    const r = runSimulation(buildRunConfig(webChain, retryStorm, { rps, retries }));
    const n = r.client.ok.length;
    const tail = (xs: number[]) => xs.slice(n - 20).reduce((a, b) => a + b, 0);
    const success = tail(r.client.ok) / Math.max(1, tail(r.client.sent));
    row.push(success > 0.95 ? 'ok' : `${(success * 100).toFixed(0)}%`);
  }
  console.log(retries, '\t', row.join('\t'));
}
const base = runSimulation(buildRunConfig(webChain, retryStorm, { rps: 200, retries: 0 }));
const t = base.tiers;
const hit = t.cache.totals.ok ? t.cache.hits.reduce((a, b) => a + b, 0) / t.cache.totals.ok : 0;
console.log('cache hit rate', hit.toFixed(3), 'db util (cores)', (t.db.totals.busyCoresArea / base.durationMs / t.db.cores).toFixed(3));
