/**
 * Deterministic keyed randomness.
 *
 * Every random value is a pure function of its key (seed, stream, and up to three integers such as
 * request id, attempt path and tier), never drawn from a sequence. So two runs with different
 * settings but the same seed see identical random values for the same request and attempt: a fix
 * that changes how many events happen cannot shift the random numbers of unrelated requests.
 *
 * All functions here are allocation-free; they only use 32-bit integer arithmetic via Math.imul.
 */

/** Separates independent uses of randomness, so e.g. arrival gaps and service times never coincide. */
export const Stream = { Arrival: 1, Service: 2, Jitter: 3, CacheKey: 4, Split: 5 } as const;

/**
 * 32-bit integer finaliser "lowbias32" (Chris Wellons, hash-prospector). A bijection on 32-bit
 * integers with very good avalanche: flipping one input bit flips each output bit with probability
 * close to 1/2. Returns an unsigned 32-bit integer. Inputs are reduced to 32 bits (ToInt32).
 */
export function mix32(x: number): number {
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

/** 2^32 / golden ratio, odd: multiplying by it is a bijection on 32-bit integers. */
const GOLDEN = 0x9e3779b9;

/**
 * Hash of a child attempt path: the parent path's hash extended by a number for this step.
 * callWithRetries numbers a call's tries from 1 (1 = first try, 2 = first retry, ...); a queue's
 * consumer call uses 0, and a tier's further calls use −1, −2, ... (see Tier.makeCall), so the
 * three never coincide. Returns an unsigned 32-bit integer.
 *
 * For a fixed parent, distinct attempt numbers (mod 2^32) always give distinct results, and for a
 * fixed attempt number, distinct parents always give distinct results, because every step is a
 * bijection. Different (parent, attempt) pairs can collide only by chance (probability ~2^-32).
 */
export function hashPath(parent: number, attemptNo: number): number {
  return mix32(mix32(parent) + Math.imul(attemptNo + 1, GOLDEN));
}

// Two independent hash lanes with different starting constants and absorb steps, so a uniform has
// 64 bits of key-dependent state rather than 32.
const LANE1_INIT = 0x243f6a88; // digits of pi
const LANE2_INIT = 0x85a308d3;
const LANE2_MUL = 0xcc9e2d51; // odd, so absorbing x is a bijection in x

/** 2^-53. */
const TWO_POW_M53 = 1 / 9007199254740992;

/**
 * Combines two 32-bit words into a double strictly inside (0, 1) with 53 bits of resolution:
 * the top 27 bits of `w1` and the top 26 bits of `w2` form k in [0, 2^53), and the result is
 * k × 2^-53, except k = 0 maps to 2^-54 so the result is never 0 (ln(u) must stay finite).
 * The largest result is 1 − 2^-53 < 1.
 */
export function wordsToUnit(w1: number, w2: number): number {
  const k = (w1 >>> 5) * 67108864 + (w2 >>> 6); // 2^26
  return Math.max(k, 0.5) * TWO_POW_M53;
}

/**
 * A uniform double strictly in (0, 1), determined only by its key.
 *
 * Key parts are treated as 32-bit integers (values >= 2^32 wrap; fractions are truncated), so
 * callers should pass integer ids. `a` may be up to ~2^31 (e.g. a request id).
 */
export function uniform(seed: number, stream: number, a = 0, b = 0, c = 0): number {
  // Each absorb step is a bijection in the absorbed value for a fixed lane state.
  let h1 = mix32(LANE1_INIT ^ seed);
  h1 = mix32(h1 ^ stream);
  h1 = mix32(h1 ^ a);
  h1 = mix32(h1 ^ b);
  h1 = mix32(h1 ^ c);

  let h2 = mix32(LANE2_INIT + Math.imul(seed, LANE2_MUL));
  h2 = mix32(h2 + Math.imul(stream, LANE2_MUL));
  h2 = mix32(h2 + Math.imul(a, LANE2_MUL));
  h2 = mix32(h2 + Math.imul(b, LANE2_MUL));
  h2 = mix32(h2 + Math.imul(c, LANE2_MUL));

  // A final cross-mix so each output word depends on both lanes.
  return wordsToUnit(mix32(h1 ^ h2), mix32(h2 + h1 + GOLDEN));
}
