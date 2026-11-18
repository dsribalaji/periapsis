/**
 * Kepler's equation solvers.
 *
 * Elliptic: M = E - e·sin E. Hyperbolic: M = e·sinh H - H.
 *
 * Both equations are strictly monotonic in their unknown (dM/dE = 1 - e·cos E ≥ 1-e > 0
 * for elliptic; dM/dH = e·cosh H - 1 > 0 for hyperbolic), so a bracketing method with
 * Newton acceleration is guaranteed to converge. Bare Newton-Raphson was measured to
 * oscillate for e = 0.9999 with tiny M, so both solvers here are *safeguarded*: Newton
 * steps are taken only while they stay inside the bracket, otherwise a bisection step
 * is used. A non-converged solve throws rather than returning a quietly wrong angle.
 */

import { wrapTwoPi } from '../math/numeric.js';

export const KEPLER_MAX_ITERATIONS = 200;

const ELLIPTIC_TOL = 1e-15;
const HYPERBOLIC_TOL = 1e-15;

/**
 * Elliptic: solve M = E - e sin E for the eccentric anomaly E, in [0, 2π).
 * `e` must satisfy 0 <= e < 1.
 */
export function solveKeplerElliptic(meanAnomaly: number, e: number): number {
  if (!(e >= 0 && e < 1)) throw new Error(`solveKeplerElliptic: e out of range [0,1): ${e}`);
  const M = wrapTwoPi(meanAnomaly);

  if (e < 1e-12) return M;

  // |E - M| = e|sin E| <= e, so this bracket is guaranteed to contain the root.
  let lo = M - e;
  let hi = M + e;

  // Initial guess: M for moderate e, shifted toward the root for high e where the
  // equation is very flat near E = 0 (Vallado, *Fundamentals of Astrodynamics*, 4th ed.).
  let E = e < 0.8 ? M : M + 0.85 * e * (Math.sin(M) >= 0 ? 1 : -1);
  E = Math.min(hi, Math.max(lo, E));

  for (let iter = 0; iter < KEPLER_MAX_ITERATIONS; iter++) {
    const f = E - e * Math.sin(E) - M;
    if (Math.abs(f) <= ELLIPTIC_TOL * Math.max(1, Math.abs(M))) return E;

    if (f > 0) hi = E;
    else lo = E;

    const fp = 1 - e * Math.cos(E);
    let next = E - f / fp;
    if (!(next > lo && next < hi)) next = 0.5 * (lo + hi);

    if (Math.abs(next - E) <= ELLIPTIC_TOL * Math.max(1, Math.abs(next))) return next;
    E = next;
  }
  throw new Error(`solveKeplerElliptic: did not converge (M=${M}, e=${e})`);
}

/** Elliptic: E -> true anomaly ν. */
export function eccentricToTrueAnomaly(E: number, e: number): number {
  return Math.atan2(Math.sqrt(1 - e * e) * Math.sin(E), Math.cos(E) - e);
}

/** Elliptic: true anomaly ν -> E. */
export function trueToEccentricAnomaly(nu: number, e: number): number {
  return Math.atan2(Math.sqrt(1 - e * e) * Math.sin(nu), e + Math.cos(nu));
}

/** Mean anomaly from E (elliptic). */
export const eccentricToMeanAnomaly = (E: number, e: number): number => E - e * Math.sin(E);

/**
 * Hyperbolic: solve M = e sinh H - H for H. `e` must exceed 1.
 *
 * The equation is odd in (M, H): M(-H) = -M(H). So this solves the positive branch,
 * where the root is positive, and negates. That keeps the bracket monotonic and the
 * safeguards simple. Newton steps are used while they stay inside the bracket,
 * otherwise bisection.
 */
export function solveKeplerHyperbolic(meanAnomaly: number, e: number): number {
  if (!(e > 1)) throw new Error(`solveKeplerHyperbolic: e must exceed 1, got ${e}`);
  if (meanAnomaly === 0) return 0;
  const sign = meanAnomaly < 0 ? -1 : 1;
  const M = Math.abs(meanAnomaly);

  const g = (H: number) => e * Math.sinh(H) - H - M;

  // g(0) = -M < 0 and g is strictly increasing, so the root is above 0.
  let lo = 0;
  let hi = Math.max(1, M);
  let guard = 0;
  while (g(hi) < 0) {
    hi *= 1.6;
    if (++guard > 200) {
      throw new Error(`solveKeplerHyperbolic: could not bracket (M=${M}, e=${e})`);
    }
  }

  // Log-based initial guess (standard for large M), clamped into the bracket.
  let H = M > 6 ? Math.log((2 * M) / e + 1.8) : M;
  H = Math.min(hi, Math.max(lo, H));

  for (let iter = 0; iter < KEPLER_MAX_ITERATIONS; iter++) {
    const value = g(H);
    if (Math.abs(value) <= HYPERBOLIC_TOL * Math.max(1, M)) return sign * H;

    if (value > 0) hi = H;
    else lo = H;

    const fp = e * Math.cosh(H) - 1;
    let next = H - value / fp;
    if (!(next > lo && next < hi)) next = 0.5 * (lo + hi);

    if (Math.abs(next - H) <= HYPERBOLIC_TOL * Math.max(1, Math.abs(next))) {
      return sign * next;
    }
    H = next;
  }
  throw new Error(`solveKeplerHyperbolic: did not converge (M=${M}, e=${e})`);
}

/** Hyperbolic: H -> true anomaly ν. */
export function hyperbolicToTrueAnomaly(H: number, e: number): number {
  return Math.atan2(Math.sqrt(e * e - 1) * Math.sinh(H), e - Math.cosh(H));
}

/** Hyperbolic: true anomaly ν -> H, via the half-angle form (stable over the full range). */
export function trueToHyperbolicAnomaly(nu: number, e: number): number {
  return 2 * Math.atanh(Math.sqrt((e - 1) / (e + 1)) * Math.tan(nu / 2));
}

/** Hyperbolic mean anomaly from H. */
export const hyperbolicToMeanAnomaly = (H: number, e: number): number =>
  e * Math.sinh(H) - H;
