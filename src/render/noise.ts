/**
 * Deterministic value noise, for procedural body surfaces.
 *
 * The physics layers are forbidden from `Math.random` (ESLint, D-002) so that results replay
 * identically, and the starfield already follows the same rule with a fixed lattice hash. Body
 * textures are as visible as anything in the app, so they follow it too: every surface is a pure
 * function of its coordinates and a seed, and the same build produces the same pixels.
 *
 * 3D noise sampled on the unit sphere rather than 2D noise on (u, v). A 2D field has a seam at
 * the wrap of longitude, where v = 0 and v = 1 are the same meridian but unrelated noise
 * columns, and a visible vertical scar down the middle of every planet is a bug, not a style.
 * Sampling a 3D field at the sphere's surface direction is seamless by construction.
 *
 * Pure: no DOM, no clock, no randomness. Unit-tested directly.
 */

/** Deterministic pseudo-random in [0, 1) from an integer. The lattice hash. */
export function hash01(n: number): number {
  let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

/** Hash of a 3D lattice point and a seed, in [0, 1). */
export function hash3(ix: number, iy: number, iz: number, seed: number): number {
  // Mix the three coordinates into one integer before hashing, so neighbouring lattice points
  // are uncorrelated. The multipliers are the standard large odd primes used for this.
  const h = Math.imul(ix, 73856093) ^ Math.imul(iy, 19349663) ^ Math.imul(iz, 83492791);
  return hash01((h ^ Math.imul(seed, 2654435761)) | 0);
}

/** Smoothstep, the standard C1 easing used between lattice cells. */
const smooth = (t: number): number => t * t * (3 - 2 * t);

/** Linear interpolation. */
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/**
 * Trilinear value noise in [0, 1).
 *
 * Smoothed between the eight lattice corners, so the field is continuous with continuous first
 * derivative everywhere — which is what stops the texture looking like a grid of cubes.
 */
export function valueNoise3(x: number, y: number, z: number, seed = 0): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const z0 = Math.floor(z);
  const fx = smooth(x - x0);
  const fy = smooth(y - y0);
  const fz = smooth(z - z0);

  const c000 = hash3(x0, y0, z0, seed);
  const c100 = hash3(x0 + 1, y0, z0, seed);
  const c010 = hash3(x0, y0 + 1, z0, seed);
  const c110 = hash3(x0 + 1, y0 + 1, z0, seed);
  const c001 = hash3(x0, y0, z0 + 1, seed);
  const c101 = hash3(x0 + 1, y0, z0 + 1, seed);
  const c011 = hash3(x0, y0 + 1, z0 + 1, seed);
  const c111 = hash3(x0 + 1, y0 + 1, z0 + 1, seed);

  const x00 = lerp(c000, c100, fx);
  const x10 = lerp(c010, c110, fx);
  const x01 = lerp(c001, c101, fx);
  const x11 = lerp(c011, c111, fx);

  return lerp(lerp(x00, x10, fy), lerp(x01, x11, fy), fz);
}

/**
 * Fractal Brownian motion: octaves of `valueNoise3` at doubling frequency and halving amplitude.
 *
 * This is what turns flat noise into terrain — continents, cloud, turbulence — because the
 * sum of scales is a rough surface rather than a single blobby frequency.
 */
export function fbm3(
  x: number,
  y: number,
  z: number,
  octaves = 5,
  seed = 0,
  lacunarity = 2,
  gain = 0.5,
): number {
  let sum = 0;
  let amplitude = 1;
  let frequency = 1;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amplitude * valueNoise3(x * frequency, y * frequency, z * frequency, seed + o * 131);
    norm += amplitude;
    frequency *= lacunarity;
    amplitude *= gain;
  }
  return norm > 0 ? sum / norm : 0;
}

/**
 * Ridged fbm, which produces sharp crests instead of soft blobs.
 *
 * Used for the brighter continental interiors and for the gas giants' turbulent band edges.
 */
export function ridged3(x: number, y: number, z: number, octaves = 4, seed = 0): number {
  let sum = 0;
  let amplitude = 1;
  let frequency = 1;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    const n =
      1 - Math.abs(valueNoise3(x * frequency, y * frequency, z * frequency, seed + o * 97) * 2 - 1);
    sum += amplitude * n * n;
    norm += amplitude;
    frequency *= 2;
    amplitude *= 0.5;
  }
  return norm > 0 ? sum / norm : 0;
}

/** Clamps to [0, 1]. */
export const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Smoothstep between two edges, clamped. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge1 === edge0) return x < edge0 ? 0 : 1;
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}
