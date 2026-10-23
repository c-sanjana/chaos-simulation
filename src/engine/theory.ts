/**
 * Analytic models of real systems, used as ground truth by the accuracy tests.
 *
 * Every function here is pure and textbook: the simulator's results are compared against them, so
 * they must be right before they are fast. Units: rates in requests per millisecond, times in
 * milliseconds (so a second moment of service time is in ms²). Invalid inputs throw `RangeError`
 * rather than returning NaN, so a broken test setup fails loudly.
 *
 * References:
 * - L. Kleinrock, *Queueing Systems, Vol. 1: Theory*, Wiley, 1975.
 * - D. Gross, C. M. Harris et al., *Fundamentals of Queueing Theory*, Wiley.
 * - M. Harchol-Balter, *Performance Modeling and Design of Computer Systems*, CUP, 2013.
 * - H. Che, Y. Tung, Z. Wang, "Hierarchical Web caching systems: modeling, design and experimental
 *   results", IEEE JSAC 20(7), 2002.
 * - J. Jung, A. W. Berger, H. Balakrishnan, "Modeling TTL-based Internet caches", IEEE INFOCOM 2003.
 */

/** Standard normal 99th percentile, Φ⁻¹(0.99). */
const Z_99 = 2.3263478740408408;

/** Bisection stops once the bracket is this narrow (absolute for σ in (0,1), relative for Che's T). */
const ROOT_TOLERANCE = 1e-12;

/** Safety cap on bisection steps; the tolerance is normally reached in about 40–60 steps. */
const MAX_BISECTION_STEPS = 200;

/** Probabilities must sum to 1 within this tolerance. */
const PROBABILITY_SUM_TOLERANCE = 1e-9;

function requireFinite(name: string, value: number): void {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be a finite number, got ${value}`);
}

function requirePositive(name: string, value: number): void {
  requireFinite(name, value);
  if (value <= 0) throw new RangeError(`${name} must be > 0, got ${value}`);
}

function requireNonNegative(name: string, value: number): void {
  requireFinite(name, value);
  if (value < 0) throw new RangeError(`${name} must be >= 0, got ${value}`);
}

function requirePositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer, got ${value}`);
  }
}

/** Throws unless utilisation ρ is in [0, 1), i.e. the queue is stable. */
function requireStable(rho: number): void {
  if (rho >= 1) throw new RangeError(`unstable queue: utilisation ρ = ${rho} must be < 1`);
}

/** Throws unless `probabilities` is a non-empty distribution: finite, non-negative, summing to 1. */
function requireDistribution(probabilities: ArrayLike<number>): void {
  if (probabilities.length === 0) throw new RangeError('probabilities must not be empty');
  let sum = 0;
  for (let i = 0; i < probabilities.length; i++) {
    requireNonNegative(`probabilities[${i}]`, probabilities[i]);
    sum += probabilities[i];
  }
  if (Math.abs(sum - 1) > PROBABILITY_SUM_TOLERANCE) {
    throw new RangeError(`probabilities must sum to 1, got ${sum}`);
  }
}

/**
 * M/M/1 mean time in system (queueing + service).
 *
 * W = S / (1 − ρ), with ρ = λS.
 *
 * Reference: Kleinrock (1975) Vol. 1, §3.2; Harchol-Balter (2013), M/M/1 chapter.
 *
 * @param lambda arrival rate λ (requests/ms), >= 0
 * @param meanServiceMs mean service time S (ms), > 0
 * @throws RangeError if inputs are invalid or ρ >= 1
 */
export function mm1MeanResponseMs(lambda: number, meanServiceMs: number): number {
  requireNonNegative('lambda', lambda);
  requirePositive('meanServiceMs', meanServiceMs);
  const rho = lambda * meanServiceMs;
  requireStable(rho);
  return meanServiceMs / (1 - rho);
}

/**
 * Erlang C: probability that an arrival to an M/M/c queue has to wait.
 *
 * Computed from the Erlang B recursion, which avoids the factorials and powers of the closed form
 * and is numerically stable for large c:
 *   B(0) = 1,  B(n) = a·B(n−1) / (n + a·B(n−1)),
 *   C(c, a) = c·B(c) / (c − a·(1 − B(c))).
 *
 * Reference: Gross & Harris, *Fundamentals of Queueing Theory* (M/M/c and the Erlang B/C relation);
 * Harchol-Balter (2013), M/M/k chapter.
 *
 * @param servers number of servers c, a positive integer
 * @param offeredLoad offered load a = λS in Erlangs, 0 <= a < c
 * @throws RangeError if inputs are invalid or a >= c
 */
export function erlangC(servers: number, offeredLoad: number): number {
  requirePositiveInteger('servers', servers);
  requireNonNegative('offeredLoad', offeredLoad);
  requireStable(offeredLoad / servers);
  let erlangB = 1;
  for (let n = 1; n <= servers; n++) {
    erlangB = (offeredLoad * erlangB) / (n + offeredLoad * erlangB);
  }
  return (servers * erlangB) / (servers - offeredLoad * (1 - erlangB));
}

/**
 * M/M/c mean time in system.
 *
 * W = C(c, a)·S / (c − a) + S, with a = λS.
 *
 * Reference: Kleinrock (1975) Vol. 1, §3.5; Harchol-Balter (2013), M/M/k chapter.
 *
 * @param lambda total arrival rate λ (requests/ms), >= 0
 * @param meanServiceMs mean service time S (ms), > 0
 * @param servers number of servers c, a positive integer
 * @throws RangeError if inputs are invalid or λS >= c
 */
export function mmcMeanResponseMs(lambda: number, meanServiceMs: number, servers: number): number {
  requireNonNegative('lambda', lambda);
  requirePositive('meanServiceMs', meanServiceMs);
  const offeredLoad = lambda * meanServiceMs;
  const waitProbability = erlangC(servers, offeredLoad);
  return (waitProbability * meanServiceMs) / (servers - offeredLoad) + meanServiceMs;
}

/**
 * M/G/1 mean time in system (Pollaczek–Khinchine mean-value formula).
 *
 * W = λ·E[S²] / (2(1 − ρ)) + E[S], with ρ = λ·E[S].
 *
 * Reference: Kleinrock (1975) Vol. 1, §5.6; Harchol-Balter (2013), M/G/1 chapter.
 *
 * @param lambda arrival rate λ (requests/ms), >= 0
 * @param meanServiceMs E[S] (ms), > 0
 * @param secondMomentMs2 E[S²] (ms²); must be >= E[S]² since variance cannot be negative
 * @throws RangeError if inputs are invalid or ρ >= 1
 */
export function mg1MeanResponseMs(
  lambda: number,
  meanServiceMs: number,
  secondMomentMs2: number,
): number {
  requireNonNegative('lambda', lambda);
  requirePositive('meanServiceMs', meanServiceMs);
  requireFinite('secondMomentMs2', secondMomentMs2);
  if (secondMomentMs2 < meanServiceMs * meanServiceMs) {
    throw new RangeError(
      `secondMomentMs2 (${secondMomentMs2}) must be >= meanServiceMs² (${meanServiceMs * meanServiceMs})`,
    );
  }
  const rho = lambda * meanServiceMs;
  requireStable(rho);
  return (lambda * secondMomentMs2) / (2 * (1 - rho)) + meanServiceMs;
}

/**
 * Mean time in system when a Poisson stream is split round-robin over k identical single-server
 * FIFO instances with exponential service.
 *
 * Instance j receives every k-th arrival, so its interarrival time is the sum of k Exp(λ) gaps:
 * each instance is an E_k/M/1 queue. By the GI/M/1 result, with A*(s) the Laplace–Stieltjes
 * transform of the interarrival time and μ = 1/S:
 *   σ is the unique root in (0, 1) of  σ = A*(μ(1 − σ)),  A*(s) = (λ / (λ + s))^k,
 *   W = 1 / (μ(1 − σ)).
 * For k = 1 this reduces to σ = ρ and the M/M/1 result.
 *
 * σ is found by bisection: f(σ) = A*(μ(1 − σ)) − σ is convex with f(0) > 0, f(σ*) = 0 and f < 0
 * on (σ*, 1) when the per-instance utilisation λS/k < 1.
 *
 * Reference: Kleinrock (1975) Vol. 1, ch. 6 (the queue G/M/m, here m = 1); Gross & Harris (GI/M/1).
 *
 * ASSUMPTION: the round-robin pointer is shared by the whole stream (strict rotation) and all
 * instances are identical, which is what the engine's round-robin load balancer does.
 *
 * @param lambdaTotal total Poisson arrival rate λ before splitting (requests/ms), >= 0
 * @param instances number of instances k, a positive integer
 * @param meanServiceMs mean exponential service time S (ms), > 0
 * @throws RangeError if inputs are invalid or the per-instance utilisation λS/k >= 1
 */
export function roundRobinMeanResponseMs(
  lambdaTotal: number,
  instances: number,
  meanServiceMs: number,
): number {
  requireNonNegative('lambdaTotal', lambdaTotal);
  requirePositiveInteger('instances', instances);
  requirePositive('meanServiceMs', meanServiceMs);
  requireStable((lambdaTotal * meanServiceMs) / instances);
  if (lambdaTotal === 0) return meanServiceMs; // σ = 0: nobody ever waits.

  const sigma = roundRobinSigma(lambdaTotal, instances, meanServiceMs);
  const mu = 1 / meanServiceMs;
  return 1 / (mu * (1 - sigma));
}

/**
 * The GI/M/1 root σ for one instance behind a round-robin split (see `roundRobinMeanResponseMs`).
 * Assumes valid, stable inputs with lambdaTotal > 0.
 */
function roundRobinSigma(lambdaTotal: number, instances: number, meanServiceMs: number): number {
  const mu = 1 / meanServiceMs;
  const f = (sigma: number) => (lambdaTotal / (lambdaTotal + mu * (1 - sigma))) ** instances - sigma;
  let lo = 0;
  let hi = 1;
  for (let step = 0; step < MAX_BISECTION_STEPS && hi - lo > ROOT_TOLERANCE; step++) {
    const mid = (lo + hi) / 2;
    if (f(mid) > 0) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Parameters and moments of a lognormal distribution. */
export interface LognormalMoments {
  /** E[X] (ms). */
  mean: number;
  /** E[X²] (ms²). */
  secondMoment: number;
  /** Shape σ: standard deviation of ln X. */
  sigma: number;
  /** Location μ: mean (and median) of ln X. */
  mu: number;
}

/**
 * Lognormal distribution described by its median and 99th percentile, as engineers describe latency.
 *
 *   μ = ln(median),  σ = (ln(p99) − ln(median)) / z₀.₉₉,
 *   E[X] = e^{μ + σ²/2},  E[X²] = e^{2μ + 2σ²}.
 *
 * Reference: any standard text, e.g. Johnson, Kotz & Balakrishnan, *Continuous Univariate
 * Distributions*, Vol. 1, ch. 14 (lognormal moments E[Xⁿ] = e^{nμ + n²σ²/2}).
 *
 * @param medianMs median (ms), > 0
 * @param p99Ms 99th percentile (ms), >= median (equal means a deterministic value)
 * @throws RangeError if inputs are invalid
 */
export function lognormalMoments(medianMs: number, p99Ms: number): LognormalMoments {
  requirePositive('medianMs', medianMs);
  requirePositive('p99Ms', p99Ms);
  if (p99Ms < medianMs) throw new RangeError(`p99Ms (${p99Ms}) must be >= medianMs (${medianMs})`);
  const mu = Math.log(medianMs);
  const sigma = (Math.log(p99Ms) - mu) / Z_99;
  return {
    mean: Math.exp(mu + (sigma * sigma) / 2),
    secondMoment: Math.exp(2 * mu + 2 * sigma * sigma),
    sigma,
    mu,
  };
}

/**
 * Zipf popularity: p_i ∝ 1 / i^skew for keys i = 1..keys, normalised to sum to 1.
 * Index 0 of the result is the most popular key (rank 1). skew = 0 is uniform.
 *
 * @param keys number of keys, a positive integer
 * @param skew Zipf exponent, >= 0
 * @throws RangeError if inputs are invalid
 */
export function zipfProbabilities(keys: number, skew: number): Float64Array {
  requirePositiveInteger('keys', keys);
  requireNonNegative('skew', skew);
  const probabilities = new Float64Array(keys);
  let total = 0;
  // Sum from the smallest term up to reduce floating-point error.
  for (let rank = keys; rank >= 1; rank--) {
    const weight = rank ** -skew;
    probabilities[rank - 1] = weight;
    total += weight;
  }
  for (let i = 0; i < keys; i++) probabilities[i] /= total;
  return probabilities;
}

/**
 * Che approximation of the hit rate of an LRU cache under the independent reference model.
 *
 * With request probabilities p_i (total request rate normalised to 1, so time is counted in
 * requests), the characteristic time T is the root of
 *   Σ_i (1 − e^{−p_i·T}) = C,
 * and the hit rate is
 *   Σ_i p_i·(1 − e^{−p_i·T}).
 *
 * T is found by bisection on [0, T_max], where T_max = −ln(1 − C/N⁺)/p_min, with N⁺ the number of
 * keys with p_i > 0 and p_min the smallest such p_i: every term is at least 1 − e^{−p_min·T}, so the
 * left side already reaches C at T_max.
 *
 * Reference: Che, Tung & Wang (2002); accuracy analysed in Fricker, Robert & Roberts, "A versatile
 * and accurate approximation for LRU cache performance", ITC 2012.
 *
 * ASSUMPTION: keys with p_i = 0 are never requested, so they never occupy the cache. The hit rate is
 * therefore 1 whenever the capacity covers every requested key (in particular when C >= number of
 * keys).
 *
 * @param probabilities request probability per key; non-negative, summing to 1
 * @param capacity cache capacity C in keys, >= 0 (need not be an integer)
 * @throws RangeError if inputs are invalid
 */
export function cheLruHitRate(probabilities: ArrayLike<number>, capacity: number): number {
  requireDistribution(probabilities);
  requireNonNegative('capacity', capacity);

  let requestedKeys = 0;
  let minProbability = Infinity;
  for (let i = 0; i < probabilities.length; i++) {
    const p = probabilities[i];
    if (p > 0) {
      requestedKeys++;
      minProbability = Math.min(minProbability, p);
    }
  }
  if (capacity >= requestedKeys) return 1;
  if (capacity === 0) return 0;

  const expectedOccupancy = (t: number) => {
    let sum = 0;
    for (let i = 0; i < probabilities.length; i++) sum += -Math.expm1(-probabilities[i] * t);
    return sum;
  };
  let lo = 0;
  let hi = -Math.log1p(-capacity / requestedKeys) / minProbability;
  for (let step = 0; step < MAX_BISECTION_STEPS && hi - lo > ROOT_TOLERANCE * hi; step++) {
    const mid = (lo + hi) / 2;
    if (expectedOccupancy(mid) < capacity) lo = mid;
    else hi = mid;
  }
  const characteristicTime = (lo + hi) / 2;

  let hitRate = 0;
  for (let i = 0; i < probabilities.length; i++) {
    const p = probabilities[i];
    hitRate += p * -Math.expm1(-p * characteristicTime);
  }
  return hitRate;
}

/**
 * Hit rate of a non-renewing TTL cache with unlimited capacity, under Poisson requests.
 *
 * A miss loads key i and starts a TTL timer; hits do not extend it. Each cycle is therefore one
 * miss followed by a TTL window holding on average λ_i·TTL hits, so per key
 *   h_i = λ_i·TTL / (1 + λ_i·TTL),  λ_i = p_i·λ,
 * and the overall hit rate is Σ_i p_i·h_i.
 *
 * Reference: Jung, Berger & Balakrishnan (2003), Poisson-arrival TTL cache model.
 *
 * ASSUMPTION: the time to fill the cache after a miss is negligible (the TTL starts at the miss),
 * and capacity never forces an eviction.
 *
 * @param probabilities request probability per key; non-negative, summing to 1
 * @param lambdaTotal total request rate λ (requests/ms), > 0
 * @param ttlMs time to live (ms), >= 0
 * @throws RangeError if inputs are invalid
 */
export function ttlCacheHitRate(
  probabilities: ArrayLike<number>,
  lambdaTotal: number,
  ttlMs: number,
): number {
  requireDistribution(probabilities);
  requirePositive('lambdaTotal', lambdaTotal);
  requireNonNegative('ttlMs', ttlMs);
  let hitRate = 0;
  for (let i = 0; i < probabilities.length; i++) {
    const hitsPerCycle = probabilities[i] * lambdaTotal * ttlMs;
    hitRate += (probabilities[i] * hitsPerCycle) / (1 + hitsPerCycle);
  }
  return hitRate;
}
