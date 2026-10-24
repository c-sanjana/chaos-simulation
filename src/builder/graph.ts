/**
 * The topology builder's data: components placed on a grid and the calls between them.
 *
 * Plain, serialisable data (it is saved and turned into a simulation config by `compile.ts`).
 * Settings use the same units as the engine: times in ms, traffic in requests per second.
 */

export type ComponentKind = 'client' | 'loadBalancer' | 'server' | 'cache' | 'database' | 'queue';

/** Service time as engineers describe it: a median and a 99th percentile (long-tailed). */
export interface ServiceSettings {
  medianMs: number;
  p99Ms: number;
}

export interface ClientSettings {
  kind: 'client';
  /** Requests per second users send (open loop: they keep coming whatever happens). */
  rps: number;
}

/** A pool of identical machines: load balancer, server or database. */
export interface PoolSettings {
  kind: 'loadBalancer' | 'server' | 'database';
  instances: number;
  /** Requests one instance can hold at once (thread pool or connection limit). */
  workersPerInstance: number;
  coresPerInstance: number;
  service: ServiceSettings;
  /** Max requests waiting per instance; null = no limit. */
  queueLimit: number | null;
  /** Skip requests whose caller has already given up. */
  dropExpired: boolean;
}

export interface CacheSettings {
  kind: 'cache';
  instances: number;
  workersPerInstance: number;
  coresPerInstance: number;
  service: ServiceSettings;
  /** Keys it can hold. */
  capacity: number;
  /** Entries expire this long after being written; null = never. */
  ttlMs: number | null;
  /** Distinct keys requests ask for. */
  keys: number;
  /** How uneven key popularity is (0 = even; about 1 is typical of web traffic). */
  skew: number;
}

/**
 * A message queue between a producer and its consumers.
 * ASSUMPTION (provisional until the queue's semantics are decided, see PLAN.md): the producer is
 * answered once the message is stored; `consumers` workers take messages in order and call the
 * next component, retrying by its call settings.
 */
export interface QueueSettings {
  kind: 'queue';
  /** Messages it can hold; when full, new messages are refused. */
  maxDepth: number;
  /** Messages handled at once by the consumers. */
  consumers: number;
  /** Time to store or hand out one message. */
  service: ServiceSettings;
}

export type NodeSettings = ClientSettings | PoolSettings | CacheSettings | QueueSettings;

export interface BuilderNode {
  id: string;
  label: string;
  /** Grid position (1-based), the same grid the topology diagram draws on. */
  col: number;
  row: number;
  settings: NodeSettings;
}

/** How the caller calls: give up after `timeoutMs`, then ask again up to `retries` times. */
export interface CallSettings {
  timeoutMs: number | null;
  retries: number;
  backoffBaseMs: number;
  jitter: boolean;
}

/** A call from one component to another. */
export interface BuilderEdge {
  id: string;
  from: string;
  to: string;
  call: CallSettings;
}

export interface BuilderGraph {
  nodes: BuilderNode[];
  edges: BuilderEdge[];
}

export const KIND_LABELS: Record<ComponentKind, string> = {
  client: 'Client',
  loadBalancer: 'Load balancer',
  // Runs your app's own code: it does some work, then calls what it needs. "Server" alone was
  // vague (databases and caches run on servers too); "API service" was jargon (user decision).
  server: 'App server',
  cache: 'Cache',
  database: 'Database',
  queue: 'Queue',
};

/** The kind in the middle of a sentence. */
export const KIND_NOUNS: Record<ComponentKind, string> = {
  client: 'client',
  loadBalancer: 'load balancer',
  server: 'app server',
  cache: 'cache',
  database: 'database',
  queue: 'queue',
};

/** "a database", "an app server"; `capital` for the start of a sentence. */
export function aKind(kind: ComponentKind, capital = false): string {
  const a = /^[aeiou]/i.test(KIND_NOUNS[kind]) ? 'an' : 'a';
  return `${capital ? a.charAt(0).toUpperCase() + a.slice(1) : a} ${KIND_NOUNS[kind]}`;
}

/** One line on what each component is, for the palette. */
export const KIND_BLURBS: Record<ComponentKind, string> = {
  client: 'Users sending requests',
  loadBalancer: 'Spreads requests over the next component',
  server: 'Runs your app’s code: does some work, then calls what it needs',
  cache: 'Remembers answers so the database is asked less',
  database: 'Stores the data; usually the slowest part',
  queue: 'Holds work for consumers to do later',
};

/**
 * Reasonable defaults for a new component, in realistic ranges ("intuition, not prediction"):
 * - Load balancers are fast and roomy: they forward, they don't compute.
 * - Servers run a few hundred workers (e.g. Tomcat's default of 200) on 4 cores.
 * - A database answers in ~20 ms median with a long tail; 4 cores ≈ 160 queries/s.
 * - The cache holds a fifth of the keys; with typical skew that's most requests.
 */
export function defaultSettings(kind: ComponentKind): NodeSettings {
  switch (kind) {
    case 'client':
      return { kind, rps: 100 };
    case 'loadBalancer':
      return { kind, instances: 2, workersPerInstance: 1024, coresPerInstance: 4, service: { medianMs: 0.5, p99Ms: 2 }, queueLimit: null, dropExpired: false };
    case 'server':
      return { kind, instances: 4, workersPerInstance: 200, coresPerInstance: 4, service: { medianMs: 4, p99Ms: 20 }, queueLimit: null, dropExpired: false };
    case 'database':
      return { kind, instances: 1, workersPerInstance: 64, coresPerInstance: 4, service: { medianMs: 20, p99Ms: 100 }, queueLimit: null, dropExpired: false };
    case 'cache':
      return { kind, instances: 1, workersPerInstance: 512, coresPerInstance: 8, service: { medianMs: 0.3, p99Ms: 1.5 }, capacity: 2000, ttlMs: 60_000, keys: 10_000, skew: 1 };
    case 'queue':
      return { kind, maxDepth: 10_000, consumers: 16, service: { medianMs: 1, p99Ms: 5 } };
  }
}

/**
 * Default call settings by who calls whom. Timeouts shrink going down the stack (users wait
 * longest), a common configuration; a cache is asked once, briefly, since the database is the
 * fallback.
 */
export function defaultCall(from: ComponentKind, to: ComponentKind): CallSettings {
  if (to === 'cache') return { timeoutMs: 100, retries: 0, backoffBaseMs: 0, jitter: false };
  if (from === 'client') return { timeoutMs: 3000, retries: 2, backoffBaseMs: 100, jitter: true };
  if (to === 'database') return { timeoutMs: 1000, retries: 1, backoffBaseMs: 50, jitter: true };
  return { timeoutMs: 2000, retries: 1, backoffBaseMs: 50, jitter: true };
}

/** Which component may call which. Fixed by what each one is; `validate.ts` checks the rest. */
export function canConnect(from: ComponentKind, to: ComponentKind): boolean {
  if (to === 'client' || from === 'database' || from === 'cache') return false;
  if (from === 'client') return to === 'loadBalancer' || to === 'server' || to === 'queue';
  if (to === 'cache') return from === 'server';
  return true;
}
