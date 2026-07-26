/**
 * Deterministic pseudo-random number generation.
 *
 * Every value in the mock dataset derives from a string seed, so the same
 * seed always produces the same dataset. This is what makes submissions
 * comparable: reviewer and candidate see identical data.
 */

/** cyrb128 — string -> 128-bit hash, used to seed mulberry32. */
function hashSeed(str: string): number {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < str.length; i += 1) {
    const k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  return (h1 ^ h2 ^ h3 ^ h4) >>> 0;
}

export interface Rng {
  /** Float in [0, 1). */
  next(): number;
  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number;
  /** Float in [min, max). */
  float(min: number, max: number): number;
  /** Uniform pick from a non-empty array. */
  pick<T>(items: readonly T[]): T;
  /** True with the given probability. */
  chance(probability: number): boolean;
  /** Weighted pick: [[value, weight], ...]. */
  weighted<T>(entries: ReadonlyArray<readonly [T, number]>): T;
  /** New array, shuffled (Fisher-Yates). Does not mutate the input. */
  shuffle<T>(items: readonly T[]): T[];
}

/** mulberry32 — small, fast, good enough for fixtures. */
export function createRng(seed: string): Rng {
  let state = hashSeed(seed);

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const int = (min: number, max: number): number => min + Math.floor(next() * (max - min + 1));

  const pick = <T,>(items: readonly T[]): T => {
    if (items.length === 0) throw new Error('rng.pick called with an empty array');
    return items[int(0, items.length - 1)] as T;
  };

  return {
    next,
    int,
    float: (min, max) => min + next() * (max - min),
    pick,
    chance: (probability) => next() < probability,
    weighted<T>(entries: ReadonlyArray<readonly [T, number]>): T {
      const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
      let roll = next() * total;
      for (const [value, weight] of entries) {
        roll -= weight;
        if (roll <= 0) return value;
      }
      return entries[entries.length - 1]![0];
    },
    shuffle<T>(items: readonly T[]): T[] {
      const copy = [...items];
      for (let i = copy.length - 1; i > 0; i -= 1) {
        const j = int(0, i);
        [copy[i], copy[j]] = [copy[j] as T, copy[i] as T];
      }
      return copy;
    },
  };
}

/** Smooth, seeded 1-D noise in [-1, 1]. Used to make telemetry look organic. */
export function smoothNoise(seed: string, x: number): number {
  const at = (i: number): number => {
    const rng = createRng(`${seed}:${i}`);
    return rng.next() * 2 - 1;
  };
  const i = Math.floor(x);
  const frac = x - i;
  const eased = frac * frac * (3 - 2 * frac);
  return at(i) * (1 - eased) + at(i + 1) * eased;
}
