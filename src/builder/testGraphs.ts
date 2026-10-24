import { defaultCall, defaultSettings, type BuilderGraph, type ComponentKind } from './graph';

/** A chain of components in a row (client first), each calling the next with its default call. */
export function chainGraph(kinds: ComponentKind[], cacheBeside?: number): BuilderGraph {
  const nodes = kinds.map((kind, i) => ({ id: `n${i}`, label: `${kind} ${i}`, col: 1 + 2 * i, row: 3, settings: defaultSettings(kind) }));
  const edges = kinds.slice(1).map((kind, i) => ({ id: `e${i}`, from: `n${i}`, to: `n${i + 1}`, call: defaultCall(kinds[i], kind) }));
  if (cacheBeside !== undefined) {
    nodes.push({ id: 'c', label: 'cache', col: 1 + 2 * cacheBeside, row: 1, settings: defaultSettings('cache') });
    edges.push({ id: 'ec', from: `n${cacheBeside}`, to: 'c', call: defaultCall('server', 'cache') });
  }
  return { nodes, edges };
}
