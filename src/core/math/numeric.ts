/** Small numerical helpers shared by the physics core. Pure functions only. */

/** Clamps `x` into [lo, hi]. */
export const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);

/** Normalises an angle into [0, 2π). */
export const wrapTwoPi = (angle: number): number => {
  const twoPi = Math.PI * 2;
  const r = angle % twoPi;
  return r < 0 ? r + twoPi : r;
};

/** Normalises an angle into (-π, π]. */
export const wrapPi = (angle: number): number => {
  const twoPi = Math.PI * 2;
  let r = angle % twoPi;
  if (r <= -Math.PI) r += twoPi;
  else if (r > Math.PI) r -= twoPi;
  return r;
};

export const degToRad = (deg: number): number => (deg * Math.PI) / 180;
export const radToDeg = (rad: number): number => (rad * 180) / Math.PI;

/** Finite-number guard used by validators so NaN can never enter the simulation. */
export const isFiniteNumber = (x: unknown): x is number =>
  typeof x === 'number' && Number.isFinite(x);

/** Relative difference of two non-negative magnitudes, safe at zero. */
export const relativeDifference = (a: number, b: number): number => {
  const denom = Math.max(Math.abs(a), Math.abs(b));
  return denom === 0 ? 0 : Math.abs(a - b) / denom;
};
