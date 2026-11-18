/**
 * Prescribed analytic ephemerides for the built-in bodies.
 *
 * Each massive body moves on a Keplerian ellipse from JPL's mean elements, with the
 * elements advanced linearly in time. Nothing here is numerically integrated: this is
 * the "prescribed dynamics" half of the architecture (ADR-0003).
 *
 * Frames: heliocentric J2000 mean ecliptic and equinox (the frame JPL Table 1 uses).
 * `position()` returns heliocentric position for every body, obtained by walking the
 * parent chain (Moon -> Earth -> Sun).
 */

import { type Vec3, vec3, add } from '../math/vec3.js';
import { AU_M, J2000_JD, SECONDS_PER_DAY } from '../constants.js';
import { BODIES, type BodyId, type MeanElements } from './solarSystem.js';
import { solveKeplerElliptic } from '../orbit/kepler.js';
import { degToRad, wrapTwoPi } from '../math/numeric.js';

const DEG = Math.PI / 180;

/** Element values at a time, already advanced to the requested epoch. */
export interface InstantElements {
  readonly a: number; // AU
  readonly e: number;
  readonly i: number; // rad
  readonly node: number; // rad
  readonly argPeriapsis: number; // rad
  readonly meanAnomaly: number; // rad
}

/**
 * Advances mean elements by `centuries` Julian centuries and converts to
 * argument-of-periapsis / mean-anomaly form, exactly as JPL's procedure step 1-2.
 */
export function advanceElements(el: MeanElements, centuries: number): InstantElements {
  const a = el.a + el.aDot * centuries;
  const e = el.e + el.eDot * centuries;
  const i = (el.i + el.iDot * centuries) * DEG;
  const L = el.L + el.LDot * centuries;
  const varpi = el.varpi + el.varpiDot * centuries;
  const node = el.node + el.nodeDot * centuries;

  // ω = ϖ - Ω, M = L - ϖ  (JPL steps 2a and 2b)
  const argPeriapsis = wrapTwoPi((varpi - node) * DEG);
  const meanAnomaly = wrapTwoPi((L - varpi) * DEG);
  return { a, e, i, node: wrapTwoPi(node * DEG), argPeriapsis, meanAnomaly };
}

/** Julian centuries from J2000.0 for a TT Julian Date. */
export const centuriesFromJd = (jdTt: number): number => (jdTt - J2000_JD) / 36525;

/**
 * Heliocentric position of a body in metres, in the J2000 mean ecliptic frame.
 * The result walks the parent chain so a Moon position is Earth + Moon-relative.
 */
export function bodyPosition(id: BodyId, jdTt: number): Vec3 {
  const body = BODIES[id];
  if (!body.elements) return vec3(0, 0, 0); // the Sun is the origin

  const local = relativePosition(body.elements, jdTt);
  return body.parent ? add(bodyPosition(body.parent, jdTt), local) : local;
}

/** Position relative to the parent body, in metres. */
export function relativePosition(el: MeanElements, jdTt: number): Vec3 {
  const T = centuriesFromJd(jdTt);
  const cur = advanceElements(el, T);
  return positionFromElements(cur);
}

/** Position in metres from instantaneous elements (AU in, metres out), ecliptic frame. */
export function positionFromElements(cur: InstantElements): Vec3 {
  const E = solveKeplerElliptic(cur.meanAnomaly, cur.e);
  const cosE = Math.cos(E);
  const sinE = Math.sin(E);
  const aM = cur.a * AU_M;

  // In-plane coordinates with the x axis toward perihelion (JPL step 4).
  const xOrb = aM * (cosE - cur.e);
  const yOrb = aM * Math.sqrt(1 - cur.e * cur.e) * sinE;

  return orbToEcliptic(xOrb, yOrb, cur.argPeriapsis, cur.i, cur.node);
}

/** Rotates in-plane (perifocal) coordinates into the ecliptic frame (JPL step 5). */
export function orbToEcliptic(
  xOrb: number,
  yOrb: number,
  argPeriapsis: number,
  i: number,
  node: number,
): Vec3 {
  const cw = Math.cos(argPeriapsis);
  const sw = Math.sin(argPeriapsis);
  const cO = Math.cos(node);
  const sO = Math.sin(node);
  const cI = Math.cos(i);
  const sI = Math.sin(i);

  // x_ecl = (cosω cosΩ - sinω sinΩ cosI) x - (sinω cosΩ + cosω sinΩ cosI) y
  // y_ecl = (cosω sinΩ + sinω cosΩ cosI) x + (cosω cosΩ cosI - sinω sinΩ) y
  // z_ecl = (sinω sinI) x + (cosω sinI) y
  const p11 = cw * cO - sw * sO * cI;
  const p21 = cw * sO + sw * cO * cI;
  const p31 = sw * sI;
  const p12 = -sw * cO - cw * sO * cI;
  const p22 = -sw * sO + cw * cO * cI;
  const p32 = cw * sI;

  return vec3(p11 * xOrb + p12 * yOrb, p21 * xOrb + p22 * yOrb, p31 * xOrb + p32 * yOrb);
}

/**
 * Velocity relative to the parent in m/s.
 *
 * This is a central difference of `positionFromElements`, NOT an analytic derivative of
 * a fixed set of elements. The reason is that the position model advances every element
 * linearly with time (a, e, i, Ω and ϖ all have secular rates), so an analytic derivative
 * that treats the elements as constant omits the rate terms. Measured on Neptune, that
 * omission is a 0.148% velocity error — small in absolute terms but exactly the kind of
 * silent inconsistency that would corrupt every ground-track and relative-velocity
 * readout. Differentiating the actual shipped position function is correct by
 * construction and cannot drift out of sync with it.
 *
 * Step size: 600 s, which is ~1e-5 of Neptune's period and ~1e-8 of Mercury's. Measured
 * relative error against the fixed-element analytic derivative is ~6e-9 (Neptune),
 * approaching the truncation/cancellation optimum. This function is used for readouts
 * and camera work, not inside the integrator, so its cost is irrelevant.
 */
const VELOCITY_STEP_SECONDS = 600;

export function relativeVelocity(el: MeanElements, jdTt: number): Vec3 {
  const h = VELOCITY_STEP_SECONDS / SECONDS_PER_DAY;
  const pPlus = positionFromElements(advanceElements(el, centuriesFromJd(jdTt + h)));
  const pMinus = positionFromElements(advanceElements(el, centuriesFromJd(jdTt - h)));
  return vec3(
    (pPlus.x - pMinus.x) / (2 * VELOCITY_STEP_SECONDS),
    (pPlus.y - pMinus.y) / (2 * VELOCITY_STEP_SECONDS),
    (pPlus.z - pMinus.z) / (2 * VELOCITY_STEP_SECONDS),
  );
}

/**
 * Mean motion in rad/s taken from the tabulated element rates: M = L - ϖ, so the fitted
 * mean motion is L̇ - ϖ̇. This is the rate at which the position model advances the
 * anomaly.
 */
export function meanMotionFromElementRates(el: MeanElements): number {
  const degPerCentury = el.LDot - el.varpiDot;
  const radPerCentury = degPerCentury * DEG;
  return radPerCentury / (36525 * SECONDS_PER_DAY);
}

/** Days -> Julian date offset helper for callers working in seconds. */
export const jdPlusSeconds = (jd: number, seconds: number): number =>
  jd + seconds / SECONDS_PER_DAY;

/** Seconds between two Julian dates. */
export const secondsBetweenJd = (jdA: number, jdB: number): number => (jdB - jdA) * SECONDS_PER_DAY;

export { degToRad };
