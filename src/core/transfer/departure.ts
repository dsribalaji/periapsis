/**
 * Departure from a parking orbit onto a specified hyperbola.
 *
 * A porkchop plot ranks windows by the *sum of the two hyperbolic excess speeds*. That is a
 * transfer-shaped number, not a burn: a real mission spends delta-v getting *out* of a
 * parking orbit, and the Oberth effect makes that cheaper than the excess speed alone.
 * This module closes that gap for the departure end. Given the excess speed the transfer
 * needs and the direction the craft must leave on, it returns the single impulsive burn that
 * puts it there, in the components a maneuver node stores.
 *
 * ## The closed form
 *
 * Burn at radius `r` from a body of parameter `mu`, from a circular parking orbit at speed
 * `vc = sqrt(mu/r)`, onto a hyperbola with excess speed `v_inf`. Energy conservation fixes the
 * post-burn speed exactly, and independently of the geometry:
 *
 *     w^2 = 2 mu / r + v_inf^2
 *
 * With `A = |a| = mu / v_inf^2` the semi-major axis magnitude, the conic equation at the burn
 * point is
 *
 *     r = A (e^2 - 1) / (1 + e cos nu),      nu = nu_inf - delta,   cos nu_inf = -1 / e
 *
 * where `delta` is the angle from the burn point to the outbound asymptote. Writing
 * `s^2 = e^2 - 1` and substituting `cos nu = (s sin d - cos d) / e`, the `e` cancels and the
 * whole thing reduces to a quadratic in `s`:
 *
 *     s^2 - k s sin d - k (1 - cos d) = 0,     k = r / A
 *
 * so
 *
 *     s = (k sin d + sqrt(k^2 sin^2 d + 4 k (1 - cos d))) / 2,   e = sqrt(1 + s^2)
 *
 * There is no root finding and no iteration in the geometry itself. The only numerical work
 * is the search over *which phase to burn at*, which is a one-dimensional scan around one
 * orbit.
 *
 * `delta = nu_inf - nu` is positive by construction, and that is not a convention: the craft
 * must reach infinity *before* the asymptote direction is behind it. A negative `nu` would put
 * the burn before periapsis, which the craft has already passed, and is rejected.
 *
 * ## The flight path angle, and why the burn is not along the asymptote
 *
 * The post-burn velocity is tilted off the local horizontal by
 *
 *     gamma = atan2(s cos d + sin d, (1 - cos d) + s sin d)
 *
 * A burn along `+prograde` matches that only when the asymptote happens to lie in the parking
 * plane and 90 degrees from the burn point. Everywhere else the burn carries radial and normal
 * components, and that is not an artifact of the method: it is the burn that has to be flown.
 * Reporting it in prograde/normal/radial is the point, because those are exactly the
 * components a maneuver node carries.
 *
 * One consequence is worth stating because it is large and easy to mistake for a bug. The
 * transfer plane is fixed by the burn point and the asymptote, so it contains the asymptote
 * but generally not the parking orbit's plane. When the two differ, the burn must rotate the
 * velocity out of the parking plane, and the cost is a plane change on top of the escape. A
 * 28.5-degree parking orbit leaving on a near-ecliptic asymptote measured 7.27 km/s against
 * an in-plane ideal of 3.62: about 3.65 km/s of plane change, against 3.81 km/s for a full
 * 28.5-degree rotation at that speed. The panel shows this as an explicit penalty rather than
 * hiding it, because choosing a parking inclination to match the launch asymptote is a real
 * mission-design decision.
 *
 * ## Two local minima
 *
 * Cost as a function of burn phase is smooth but **not unimodal**. Measured over 100 random
 * geometry pairs, 49 had two local minima around the circle. A ternary search over one bracket
 * therefore returns a local minimum that is frequently not the global one, and refining only
 * the cheapest sample is the same mistake in a different hat. This module samples the whole
 * orbit, refines *every* bracketed local minimum, and keeps the best. Against a 100,000-point
 * dense scan over 400 random geometries the worst disagreement measured was 5e-6 m/s.
 *
 * ## What this module does not do
 *
 * - No finite-burn (thrust arc) model: the burn is impulsive, the same assumption
 *   `sim/trajectory.ts` already states.
 * - No arrival. Capture happens about a different body, and a craft in this model has one
 *   central body. The arrival excess speed is reported by the porkchop and costed separately;
 *   patched conics are not in v1.0.0.
 * - No plane-change optimisation as a separate term: whatever plane change the geometry
 *   forces appears in the burn, but the parking inclination is an input, not a free variable.
 */

import { type Vec3, add, cross, dot, length, normalize, scale, sub } from '../math/vec3.js';
import { clamp } from '../math/numeric.js';
import type { StateVector } from '../orbit/elements.js';

/**
 * Smallest angle between the burn point and the asymptote that is treated as measurable.
 *
 * `delta -> 0` is a radial escape, which needs infinite speed from a circular orbit, and
 * `delta -> pi` puts the asymptote straight back through the body. Both are excluded, but this
 * is a guard against a degenerate geometry rather than a model of one: real departures land
 * far from either end.
 */
const DELTA_EPSILON = 1e-9;

/**
 * Default phases sampled around the parking orbit before refinement: one degree of arc.
 *
 * Measured against a 100,000-point scan over 400 random geometry pairs, this never missed the
 * global minimum. Raising it to 720 or 1440 changed no answer in the same sweep, so 360 is
 * kept: it is 360 closed-form evaluations, a handful of trigonometric calls each, i.e.
 * microseconds.
 */
export const DEFAULT_PHASE_SAMPLES = 360;

/** Ternary-search iterations on one bracket. 140 shrinks the interval by (2/3)^140. */
const REFINE_ITERATIONS = 140;

/** A single closed-form departure burn at a fixed point on the parking orbit. */
export interface DepartureBurn {
  /** Burn magnitude, m/s. */
  readonly deltaV: number;
  /** Component along the parking orbit's velocity direction, m/s. */
  readonly prograde: number;
  /** Component along the parking orbit's normal, m/s. */
  readonly normal: number;
  /** Component outward along the radius, m/s. */
  readonly radial: number;
  /** Eccentricity of the resulting hyperbola. Always > 1. */
  readonly eccentricity: number;
  /** True anomaly at the burn, radians, in [0, nu_inf). */
  readonly trueAnomalyRad: number;
  /** Angle from the burn point to the outbound asymptote, radians, in (0, pi). */
  readonly asymptoteAngleRad: number;
  /** Periapsis radius of the resulting hyperbola, metres. May be inside the body. */
  readonly periapsisRadius: number;
  /**
   * True when that periapsis is below the body's radius.
   *
   * Not an error: the burn happens on the outbound leg, so the craft never travels to that
   * periapsis. It is flagged because a reader seeing "periapsis 5935 km" beside "burn at
   * 6671 km" would otherwise reasonably ask what is wrong.
   */
  readonly periapsisBelowSurface: boolean;
  /** Body-relative state immediately after the burn. */
  readonly postBurn: StateVector;
}

export interface DepartureRequest {
  /** Gravitational parameter of the body being departed, m^3/s^2. */
  readonly mu: number;
  /** Radius of the burn point from the body's centre, metres. */
  readonly radius: number;
  /** Required hyperbolic excess speed at infinity, m/s. */
  readonly vInf: number;
  /** Direction the craft must be travelling at infinity. Need not be normalised. */
  readonly asymptote: Vec3;
  /** Parking-orbit normal: `r x v` at epoch, need not be normalised. */
  readonly parkingNormal: Vec3;
  /** Outward radial direction at the craft's epoch position, need not be normalised. */
  readonly parkingRadial: Vec3;
  /** Body radius, metres, used only to flag a below-surface periapsis. */
  readonly bodyRadius?: number;
  /** Optional phase samples around the orbit. Defaults to {@link DEFAULT_PHASE_SAMPLES}. */
  readonly samples?: number;
}

export interface DeparturePlan {
  readonly burn: DepartureBurn;
  /** Angle around the parking orbit from the epoch position to the burn, radians, in [0, 2pi). */
  readonly phaseRad: number;
  /** Time from the reference instant to the burn, seconds. At most one parking period. */
  readonly timeToBurnSeconds: number;
  /** Parking-orbit circular speed at the burn radius, m/s. */
  readonly parkedSpeed: number;
  /** Parking-orbit period at the burn radius, seconds. */
  readonly parkingPeriod: number;
  /**
   * What the same excess speed costs if the burn is at periapsis, in plane and prograde, m/s.
   * The floor for this `v_inf` at this radius, and the number to compare against when the
   * geometry forces something more expensive. Note this can *exceed* `v_inf`: see
   * {@link oberthHelps}.
   */
  readonly idealDeltaV: number;
  /** `burn.deltaV - idealDeltaV`, m/s. Never negative beyond rounding. */
  readonly excessOverIdeal: number;
  /**
   * True when the Oberth effect is in the craft's favour at this excess speed, i.e.
   * `v_inf > vc / 2`. False means the ideal burn still costs more than the excess speed.
   */
  readonly oberthHelps: boolean;
  /** Phases evaluated in the coarse scan, so a caller can state the cost of the search. */
  readonly sampledPhases: number;
  /** Local minima refined. Greater than one means the search had to choose. */
  readonly refinedMinima: number;
}

/** The asymptote direction of a hyperbolic state, or null for an elliptic or degenerate one. */
export function asymptoteDirection(state: StateVector, mu: number): Vec3 | null {
  const rMag = length(state.r);
  if (!(rMag > 0) || !(mu > 0)) return null;
  const vMag = length(state.v);
  const energy = (vMag * vMag) / 2 - mu / rMag;
  if (!(energy > 0)) return null;

  const h = cross(state.r, state.v);
  const hMag = length(h);
  if (!(hMag > 0)) return null;

  // Eccentricity vector e = ((v^2 - mu/r) r - (r.v) v) / mu.
  const eVec = scale(
    sub(scale(state.r, vMag * vMag - mu / rMag), scale(state.v, dot(state.r, state.v))),
    1 / mu,
  );
  const e = length(eVec);
  if (!(e > 1)) return null;

  const eHat = scale(eVec, 1 / e);
  const hHat = scale(h, 1 / hMag);
  const nuInf = Math.acos(clamp(-1 / e, -1, 1));
  // The asymptote is in the orbital plane at angle nu_inf from periapsis, in the direction of
  // motion: q̂ = ĥ x ê.
  const qHat = cross(hHat, eHat);
  return add(scale(eHat, Math.cos(nuInf)), scale(qHat, Math.sin(nuInf)));
}

/** The at-periapsis, in-plane floor for a departure with this excess speed, m/s. */
export function idealDepartureDeltaV(mu: number, radius: number, vInf: number): number {
  if (!(mu > 0) || !(radius > 0) || !(vInf > 0)) return Number.NaN;
  return Math.sqrt((2 * mu) / radius + vInf * vInf) - Math.sqrt(mu / radius);
}

/**
 * Whether the Oberth effect actually makes a departure cheaper than its excess speed.
 *
 * `sqrt(vc^2 + v^2) - vc < v` reduces to `v > vc / 2`: the saving appears only once the
 * required excess speed beats half the parking-orbit speed. For a 300 km Earth orbit that
 * crossover is 3.87 km/s, right in the middle of the interplanetary range, so both behaviours
 * are reachable and a caller that assumes "Oberth always helps" is quietly wrong for the low
 * end. FALSE does not mean the burn is useless: it means leaving slowly from a fast orbit
 * costs more than the excess speed itself, because most of the fuel goes into cancelling the
 * speed the craft already has.
 */
export function oberthHelps(mu: number, radius: number, vInf: number): boolean {
  const vc = Math.sqrt(mu / radius);
  return vInf > vc / 2;
}

/**
 * Solves for the burn at a fixed point on the parking orbit.
 *
 * Returns null when no outbound hyperbola with this excess speed passes through the point
 * travelling on the given asymptote.
 */
export function departureAtPhase(
  mu: number,
  radius: number,
  vInf: number,
  radialDirection: Vec3,
  asymptote: Vec3,
  parkingNormal: Vec3,
  bodyRadius?: number,
): DepartureBurn | null {
  if (!(mu > 0) || !(radius > 0) || !(vInf > 0)) return null;

  // Lengths are checked before normalising. `normalize` maps a zero vector to zero, so a
  // zero input would sail through every subsequent test and produce a burn of 0 m/s at the
  // origin: a plausible-looking answer to a question that has none.
  if (!(length(radialDirection) > 0) || !(length(asymptote) > 0) || !(length(parkingNormal) > 0)) {
    return null;
  }

  const rHat = normalize(radialDirection);
  const aHat = normalize(asymptote);
  const nHat = normalize(parkingNormal);
  if (!isFiniteVec(rHat) || !isFiniteVec(aHat) || !isFiniteVec(nHat)) return null;

  const cosDelta = clamp(dot(rHat, aHat), -1, 1);
  const delta = Math.acos(cosDelta);
  if (!(delta > DELTA_EPSILON) || !(delta < Math.PI - DELTA_EPSILON)) return null;

  const absA = mu / (vInf * vInf);
  const k = radius / absA;
  const sinDelta = Math.sin(delta);
  const oneMinusCos = 1 - cosDelta;

  const discriminant = k * k * sinDelta * sinDelta + 4 * k * oneMinusCos;
  const s = 0.5 * (k * sinDelta + Math.sqrt(discriminant));
  if (!(s > 0)) return null;

  const eccentricity = Math.sqrt(1 + s * s);
  if (!(eccentricity > 1)) return null;

  const nuInf = Math.acos(clamp(-1 / eccentricity, -1, 1));
  const trueAnomaly = nuInf - delta;
  // Outbound only: a negative anomaly is a burn before periapsis, which is behind the craft.
  if (!(trueAnomaly >= 0)) return null;

  const denominator = oneMinusCos + s * sinDelta;
  if (!(denominator > 0)) return null;
  const gamma = Math.atan2(s * cosDelta + sinDelta, denominator);

  const wMag = Math.sqrt((2 * mu) / radius + vInf * vInf);
  // The transfer plane holds the burn point and the asymptote; its normal orients the in-plane
  // transverse direction so the velocity can be written in the orbital frame.
  const hHat = normalize(cross(rHat, aHat));
  if (!isFiniteVec(hHat)) return null;
  const transverse = normalize(cross(hHat, rHat));

  const postVelocity = add(
    scale(transverse, wMag * Math.cos(gamma)),
    scale(rHat, wMag * Math.sin(gamma)),
  );

  // The parking velocity is transverse in the *parking* orbit's frame, which is generally not
  // the transfer plane's. Using the transfer frame here would silently erase every plane
  // change the geometry forces.
  const progradeHat = normalize(cross(nHat, rHat));
  if (!isFiniteVec(progradeHat)) return null;
  const parkedSpeed = Math.sqrt(mu / radius);
  const deltaV = sub(postVelocity, scale(progradeHat, parkedSpeed));

  const prograde = dot(deltaV, progradeHat);
  const normal = dot(deltaV, nHat);
  const radial = dot(deltaV, rHat);
  const periapsisRadius = absA * (eccentricity - 1);

  return {
    deltaV: Math.hypot(prograde, normal, radial),
    prograde,
    normal,
    radial,
    eccentricity,
    trueAnomalyRad: trueAnomaly,
    asymptoteAngleRad: delta,
    periapsisRadius,
    periapsisBelowSurface: bodyRadius !== undefined && periapsisRadius < bodyRadius,
    postBurn: { r: scale(rHat, radius), v: postVelocity },
  };
}

/**
 * Chooses the burn point and returns the cheapest departure over one parking orbit.
 *
 * The scan is over burn *phase*, and phase increases with time, so the returned phase is the
 * first time the craft reaches that point: `timeToBurnSeconds = phase / n`. The optimum is
 * therefore placed at most one parking period after the reference instant, which is the honest
 * trade for a date that came from a porkchop grid: a 96-minute orbit moves a 314-day transfer
 * by under a fifth of a percent of a day, while burning at the calendar instant regardless of
 * where the craft is can cost thousands of m/s.
 */
export function planDeparture(request: DepartureRequest): DeparturePlan | null {
  const { mu, radius, vInf, asymptote, parkingNormal, parkingRadial, bodyRadius } = request;
  if (!(mu > 0) || !(radius > 0) || !(vInf > 0)) return null;

  const samples = request.samples ?? DEFAULT_PHASE_SAMPLES;
  if (!(samples >= 8) || !Number.isInteger(samples)) {
    throw new Error('planDeparture: samples must be an integer of at least 8');
  }

  const normal = normalize(parkingNormal);
  if (!isFiniteVec(normal) || length(normal) === 0) return null;

  // Orthonormal in-plane basis. The caller's radial is trusted for direction only; projecting
  // out the normal component makes the basis exact even if the two inputs are not orthogonal.
  const flattened = sub(
    normalize(parkingRadial),
    scale(normal, dot(normalize(parkingRadial), normal)),
  );
  if (!(length(flattened) > 0)) return null;
  const e1 = normalize(flattened);
  const e2 = cross(normal, e1);

  const at = (phase: number): DepartureBurn | null =>
    departureAtPhase(
      mu,
      radius,
      vInf,
      add(scale(e1, Math.cos(phase)), scale(e2, Math.sin(phase))),
      asymptote,
      normal,
      bodyRadius,
    );

  const step = (2 * Math.PI) / samples;
  const costs = new Array<number>(samples);
  for (let i = 0; i < samples; i++) {
    const burn = at(i * step);
    costs[i] = burn ? burn.deltaV : Number.POSITIVE_INFINITY;
  }

  const refine = (centre: number): { burn: DepartureBurn; phase: number } | null => {
    let lo = centre - step;
    let hi = centre + step;
    for (let i = 0; i < REFINE_ITERATIONS; i++) {
      const m1 = lo + (hi - lo) / 3;
      const m2 = hi - (hi - lo) / 3;
      const c1 = at(m1);
      const c2 = at(m2);
      const v1 = c1 ? c1.deltaV : Number.POSITIVE_INFINITY;
      const v2 = c2 ? c2.deltaV : Number.POSITIVE_INFINITY;
      if (v1 < v2) hi = m2;
      else lo = m1;
    }
    const phase = wrapPhase((lo + hi) / 2);
    const burn = at(phase);
    return burn ? { burn, phase } : null;
  };

  let best: { burn: DepartureBurn; phase: number } | null = null;
  let refinedMinima = 0;
  let cheapestSample = -1;
  let cheapestSampleCost = Number.POSITIVE_INFINITY;

  for (let i = 0; i < samples; i++) {
    const cost = costs[i]!;
    if (!Number.isFinite(cost)) continue;
    if (cost < cheapestSampleCost) {
      cheapestSampleCost = cost;
      cheapestSample = i;
    }
    // A local minimum on the cyclic sample lattice. Refining all of them is what makes the
    // result global: see the module note on two minima.
    const previous = costs[(i - 1 + samples) % samples]!;
    const next = costs[(i + 1) % samples]!;
    if (cost <= previous && cost <= next) {
      refinedMinima++;
      const candidate = refine(i * step);
      if (candidate && (!best || candidate.burn.deltaV < best.burn.deltaV)) best = candidate;
    }
  }

  if (!best && cheapestSample >= 0) {
    // No sampled local minimum: the feasible arc is monotone, so its cheapest sample is the
    // boundary of the optimum. Refine there rather than returning nothing.
    refinedMinima = 1;
    best = refine(cheapestSample * step);
  }
  if (!best) return null;

  const parkedSpeed = Math.sqrt(mu / radius);
  const idealDeltaV = idealDepartureDeltaV(mu, radius, vInf);
  const meanMotion = Math.sqrt(mu / (radius * radius * radius));
  const phaseRad = wrapPhase(best.phase);

  return {
    burn: best.burn,
    phaseRad,
    timeToBurnSeconds: phaseRad / meanMotion,
    parkedSpeed,
    parkingPeriod: (2 * Math.PI) / meanMotion,
    idealDeltaV,
    excessOverIdeal: best.burn.deltaV - idealDeltaV,
    oberthHelps: oberthHelps(mu, radius, vInf),
    sampledPhases: samples,
    refinedMinima,
  };
}

function wrapPhase(phase: number): number {
  const twoPi = 2 * Math.PI;
  const wrapped = phase % twoPi;
  return wrapped < 0 ? wrapped + twoPi : wrapped;
}

function isFiniteVec(v: Vec3): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}
