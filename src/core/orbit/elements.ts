/**
 * Classical (Keplerian) orbital elements and Cartesian state conversion.
 *
 * Conventions: SI units; angles in radians; two-body problem around a fixed central
 * body of gravitational parameter `mu`. Handles elliptic (0 <= e < 1), parabolic
 * (rejected: see below) and hyperbolic (e > 1) orbits.
 *
 * A parabolic orbit has zero specific energy and cannot be represented with a
 * semi-major axis; `e == 1` therefore throws, and callers should treat such orbits via
 * their state vectors. Practically, a e == 1 orbit has measure zero and no bundled
 * scenario uses one.
 */

import { type Vec3, vec3, add, scale, cross, dot, length, sub, normalize } from '../math/vec3.js';
import { wrapTwoPi, wrapPi } from '../math/numeric.js';

export type OrbitType = 'elliptic' | 'hyperbolic';

export interface OrbitalElements {
  /** Semi-major axis in metres. Negative for hyperbolic orbits. */
  readonly a: number;
  readonly e: number;
  readonly i: number;
  /** Right ascension of the ascending node, radians. */
  readonly raan: number;
  /** Argument of periapsis, radians. */
  readonly argPeriapsis: number;
  /** True anomaly, radians. */
  readonly trueAnomaly: number;
  readonly mu: number;
}

export interface StateVector {
  readonly r: Vec3;
  readonly v: Vec3;
}

const TWO_PI = 2 * Math.PI;

/** Eccentricity tolerance below which e is treated as exactly zero (avoids noise in arguments). */
export const ECC_EPS = 1e-11;

/**
 * Converts a Cartesian state to classical elements.
 * Throws if the state is rectilinear (r × v ≈ 0) with non-zero speed, which has no
 * unique orbital plane.
 */
export function stateToElements(state: StateVector, mu: number): OrbitalElements {
  const { r, v } = state;
  const rMag = length(r);
  if (rMag === 0) throw new Error('stateToElements: position is zero');

  const h = cross(r, v);
  const hMag = length(h);
  const vMag = length(v);

  const energy = (vMag * vMag) / 2 - mu / rMag;
  const a = Math.abs(energy) < 1e-14 ? Infinity : -mu / (2 * energy);

  const eVec = scale(sub(scale(r, vMag * vMag - mu / rMag), scale(v, dot(r, v))), 1 / mu);
  const e = length(eVec);

  if (hMag < 1e-9 * rMag * Math.max(vMag, 1e-12)) {
    throw new Error('stateToElements: rectilinear state has no defined orbital plane');
  }
  if (!Number.isFinite(a)) {
    throw new Error('stateToElements: parabolic orbit (e = 1) is not representable');
  }
  const type: OrbitType = e < 1 ? 'elliptic' : 'hyperbolic';

  const hHat = scale(h, 1 / hMag);
  // atan2 rather than acos: acos loses half the mantissa near i = 0 or π, which showed
  // up as a 1.5e-8 rad inclination error for equatorial orbits (a real, measured defect).
  const i = Math.atan2(Math.hypot(h.x, h.y), h.z);

  // Node vector n = ẑ × h
  const n = cross(vec3(0, 0, 1), h);
  const nMag = length(n);

  let raan = 0;
  let argPeriapsis = 0;
  let trueAnomaly = 0;

  if (nMag > 1e-12 * hMag) {
    raan = wrapTwoPi(Math.atan2(n.y, n.x));
  }

  /**
   * Equatorial orbits (i ≈ 0 or i ≈ π) have no line of nodes, so the argument of
   * latitude is measured from the x axis. For a retrograde equatorial orbit (i = π)
   * the direction of motion is reversed, so the in-plane angle carries the opposite
   * sign. Getting this wrong produced a 130% velocity error before it was caught by
   * the property test, so it is handled explicitly with a sign factor.
   */
  const retrograde = i > Math.PI / 2;
  const s = retrograde ? -1 : 1;
  const equatorial = nMag <= 1e-12 * hMag;

  if (e > ECC_EPS) {
    if (!equatorial) {
      const cosw = dot(n, eVec) / (nMag * e);
      const sign = eVec.z >= 0 ? 1 : -1;
      argPeriapsis = wrapTwoPi(sign * Math.acos(Math.max(-1, Math.min(1, cosw))));
    } else {
      argPeriapsis = wrapTwoPi(s * Math.atan2(eVec.y, eVec.x));
    }
    const cosNu = dot(eVec, r) / (e * rMag);
    const signNu = dot(cross(eVec, r), hHat) >= 0 ? 1 : -1;
    trueAnomaly = wrapPi(signNu * Math.acos(Math.max(-1, Math.min(1, cosNu))));
  } else {
    // Circular orbit: argPeriapsis = 0 by convention and the anomaly carries the
    // argument of latitude.
    argPeriapsis = 0;
    if (!equatorial) {
      const cosU = dot(n, r) / (nMag * rMag);
      const signU = r.z >= 0 ? 1 : -1;
      trueAnomaly = wrapPi(signU * Math.acos(Math.max(-1, Math.min(1, cosU))));
    } else {
      trueAnomaly = wrapPi(s * Math.atan2(r.y, r.x));
    }
  }

  void type;
  return { a, e, i, raan, argPeriapsis, trueAnomaly, mu };
}

/** Converts classical elements to a Cartesian state. `e` must not equal 1. */
export function elementsToState(el: OrbitalElements): StateVector {
  const { a, e, i, raan, argPeriapsis, trueAnomaly, mu } = el;
  if (Math.abs(1 - e) < 1e-12) {
    throw new Error('elementsToState: parabolic orbit (e = 1) is not representable');
  }

  const p = a * (1 - e * e); // semi-latus rectum; positive for hyperbolic (a < 0, e > 1)
  const cosNu = Math.cos(trueAnomaly);
  const sinNu = Math.sin(trueAnomaly);
  const denom = 1 + e * cosNu;
  const rMag = p / denom;

  // Position and velocity in the perifocal frame (PQW).
  const rPqw = vec3(rMag * cosNu, rMag * sinNu, 0);
  const factor = Math.sqrt(mu / p);
  const vPqw = vec3(-factor * sinNu, factor * (e + cosNu), 0);

  const rot = perifocalToInertialRotation(raan, i, argPeriapsis);
  return { r: rot(rPqw), v: rot(vPqw) };
}

/** Returns the linear map from perifocal (PQW) coordinates to inertial coordinates. */
export function perifocalToInertialRotation(
  raan: number,
  i: number,
  argPeriapsis: number,
): (v: Vec3) => Vec3 {
  const cO = Math.cos(raan);
  const sO = Math.sin(raan);
  const cI = Math.cos(i);
  const sI = Math.sin(i);
  const cW = Math.cos(argPeriapsis);
  const sW = Math.sin(argPeriapsis);

  // Standard 313 rotation matrix, columns are the P, Q, W unit vectors in inertial frame.
  const px = cO * cW - sO * sW * cI;
  const py = sO * cW + cO * sW * cI;
  const pz = sW * sI;
  const qx = -cO * sW - sO * cW * cI;
  const qy = -sO * sW + cO * cW * cI;
  const qz = cW * sI;
  const wx = sO * sI;
  const wy = -cO * sI;
  const wz = cI;

  return (v: Vec3) =>
    vec3(
      px * v.x + qx * v.y + wx * v.z,
      py * v.x + qy * v.y + wy * v.z,
      pz * v.x + qz * v.y + wz * v.z,
    );
}

/** Specific orbital energy per unit mass, J/kg (negative for elliptic). */
export const specificEnergy = (state: StateVector, mu: number): number =>
  (dot(state.v, state.v) / 2) - mu / length(state.r);

/** Specific angular momentum magnitude, m²/s. */
export const specificAngularMomentum = (state: StateVector): number =>
  length(cross(state.r, state.v));

/** Orbital period in seconds. Throws for non-elliptic orbits. */
export function orbitalPeriod(a: number, mu: number): number {
  if (a <= 0) throw new Error('orbitalPeriod: only elliptic orbits have a period');
  return TWO_PI * Math.sqrt((a * a * a) / mu);
}

/** Mean motion in rad/s. */
export const meanMotion = (a: number, mu: number): number =>
  Math.sqrt(mu / Math.abs(a * a * a));

/** Periapsis and apoapsis radii in metres (apoapsis is Infinity for hyperbolic). */
export const apsides = (a: number, e: number): { periapsis: number; apoapsis: number } => ({
  periapsis: a * (1 - e),
  apoapsis: e < 1 ? a * (1 + e) : Infinity,
});

/** Unit vectors of the local orbital frame (prograde, normal, radial) at a state. */
export function localOrbitalFrame(state: StateVector): {
  prograde: Vec3;
  normal: Vec3;
  radial: Vec3;
} {
  const radial = normalize(state.r);
  const normal = normalize(cross(state.r, state.v));
  // Prograde is the velocity component in the orbital plane, so a burn cannot
  // accidentally tilt the plane by injecting the out-of-plane part of v.
  const prograde = normalize(sub(state.v, scale(radial, dot(state.v, radial))));
  return { prograde, normal, radial };
}

/** Applies an impulsive delta-v expressed in the local orbital frame. */
export function applyImpulse(
  state: StateVector,
  deltaV: { prograde: number; normal: number; radial: number },
): StateVector {
  const frame = localOrbitalFrame(state);
  const dv = add(
    add(scale(frame.prograde, deltaV.prograde), scale(frame.normal, deltaV.normal)),
    scale(frame.radial, deltaV.radial),
  );
  return { r: state.r, v: add(state.v, dv) };
}
