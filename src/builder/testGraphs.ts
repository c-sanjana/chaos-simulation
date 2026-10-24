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

/**
 * A branched system of nine parts, as on the canvas: Client → Load balancer → three app servers
 * (the top one with a cache); the top two share Database 1, the bottom one hands work to a Queue
 * that feeds Database 2.
 */
export function branchedGraph(): BuilderGraph {
  const node = (id: string, kind: ComponentKind, col: number, row: number) => ({ id, label: id, col, row, settings: defaultSettings(kind) });
  const nodes = [
    node('client', 'client', 1, 3),
    node('lb', 'loadBalancer', 3, 3),
    node('s1', 'server', 5, 1),
    node('s2', 'server', 5, 3),
    node('s3', 'server', 5, 5),
    node('cache', 'cache', 7, 1),
    node('db1', 'database', 7, 3),
    node('queue', 'queue', 7, 5),
    node('db2', 'database', 9, 5),
  ];
  const kindOf = (id: string) => nodes.find((n) => n.id === id)!.settings.kind;
  const edge = (from: string, to: string) => ({ id: `${from}--${to}`, from, to, call: defaultCall(kindOf(from), kindOf(to)) });
  const edges = [edge('client', 'lb'), edge('lb', 's1'), edge('lb', 's2'), edge('lb', 's3'), edge('s1', 'cache'), edge('s1', 'db1'), edge('s2', 'db1'), edge('s3', 'queue'), edge('queue', 'db2')];
  return { nodes, edges };
}
