/**
 * Closed-form two-body propagation around a fixed central body.
 *
 * The state is converted to elements once, the anomaly advanced analytically, and the
 * state rebuilt. This is exact for the two-body problem (to floating-point), which is
 * what makes it usable as a reference for the numerical integrators and as the
 * "fast mode" coast propagator.
 */

import {
  type OrbitalElements,
  type StateVector,
  elementsToState,
  stateToElements,
  orbitalPeriod,
  meanMotion,
} from './elements.js';
import {
  solveKeplerElliptic,
  solveKeplerHyperbolic,
  eccentricToTrueAnomaly,
  hyperbolicToTrueAnomaly,
} from './kepler.js';
import { wrapTwoPi } from '../math/numeric.js';

/**
 * Propagates a two-body state by `dt` seconds around a body of parameter `mu`.
 * `dt` may be negative (backwards in time).
 */
export function propagateTwoBody(state: StateVector, mu: number, dt: number): StateVector {
  if (dt === 0) return state;
  const el = stateToElements(state, mu);
  return elementsToState(propagateElements(el, dt));
}

/** Advances orbital elements by `dt` seconds analytically. */
export function propagateElements(el: OrbitalElements, dt: number): OrbitalElements {
  const { a, e, mu, trueAnomaly } = el;

  if (e < 1) {
    const n = meanMotion(a, mu);
    const M0 = meanAnomalyFromTrue(trueAnomaly, e);
    const M = M0 + n * dt;
    const E = solveKeplerElliptic(M, e);
    return { ...el, trueAnomaly: eccentricToTrueAnomaly(E, e) };
  }

  const n = meanMotion(a, mu); // positive by construction from |a|³
  const M0 = hyperbolicMeanFromTrue(trueAnomaly, e);
  const M = M0 + n * dt;
  const H = solveKeplerHyperbolic(M, e);
  return { ...el, trueAnomaly: hyperbolicToTrueAnomaly(H, e) };
}

/** Mean anomaly (elliptic) from a true anomaly. */
export function meanAnomalyFromTrue(nu: number, e: number): number {
  const E = Math.atan2(Math.sqrt(1 - e * e) * Math.sin(nu), e + Math.cos(nu));
  return wrapTwoPi(E - e * Math.sin(E));
}

/** Hyperbolic mean anomaly from a true anomaly. */
export function hyperbolicMeanFromTrue(nu: number, e: number): number {
  const tanHalf = Math.tan(nu / 2);
  const H = 2 * Math.atanh(Math.sqrt((e - 1) / (e + 1)) * tanHalf);
  return e * Math.sinh(H) - H;
}

/**
 * Number of full revolutions completed between two times on an elliptic orbit; used to
 * draw multi-revolution trails without accumulating integration error.
 */
export function revolutionsInPeriod(dt: number, a: number, mu: number): number {
  return dt / orbitalPeriod(a, mu);
}

/**
 * Samples a two-body conic for plotting. `count` points span `[t0, t0 + duration]`.
 * For elliptic orbits a full-period span closes the ellipse exactly.
 */
export function sampleTwoBodyArc(
  state: StateVector,
  mu: number,
  duration: number,
  count: number,
): StateVector[] {
  if (count < 2) throw new Error('sampleTwoBodyArc: need at least 2 samples');
  const out: StateVector[] = [];
  for (let k = 0; k < count; k++) {
    const t = (duration * k) / (count - 1);
    out.push(propagateTwoBody(state, mu, t));
  }
  return out;
}
