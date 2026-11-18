/**
 * Spacecraft trajectory: propagation with impulsive burns applied in time order.
 *
 * The model is deliberately simple and its assumption is stated once, here:
 *
 *   A burn is instantaneous. The state jumps in velocity at the node's time and the
 *   trajectory continues from the same position with the new velocity.
 *
 * That is the standard impulsive approximation, and it is what makes a burn's Δv a direct
 * property of the node rather than an outcome of integrating a thrust arc.
 *
 * Two propagation modes, because they answer different questions:
 *
 *   - `twoBody` propagates the state relative to the spacecraft's central body with the
 *     closed-form propagator, then adds that body's ephemeris position to report
 *     heliocentric points. Fast, exact for the model, and directly comparable to the
 *     Hohmann and Lambert calculators. Correct for a single-body mission.
 *   - `nbody` integrates the restricted N-body acceleration (ADR-0003) with adaptive RK45.
 *     Slower, and the honest answer for a long or multi-body trajectory.
 *
 * The caller chooses the mode; nothing here picks one implicitly. There is no module-level
 * mutable state: everything a propagation needs, including the epoch, is a parameter.
 */

import { type Vec3, add, sub } from '../core/math/vec3.js';
import { bodyPosition } from '../core/ephemeris/ephemeris.js';
import { BODIES, type BodyId } from '../core/ephemeris/solarSystem.js';
import { acceleration, jdFromSeconds } from '../core/ephemeris/nbody.js';
import { integrateAdaptive, type AccelerationFn } from '../core/integrate/integrators.js';
import { propagateTwoBody } from '../core/orbit/twoBody.js';
import { AU_M, J2000_JD, SECONDS_PER_DAY } from '../core/constants.js';
import { applyManeuver, maneuverMagnitude, sortedManeuvers, type Maneuver } from './maneuver.js';

export type PropagationMode = 'twoBody' | 'nbody';

export interface Spacecraft {
  readonly id: string;
  readonly name: string;
  /** Body the initial state and two-body propagation are relative to. */
  readonly centralBody: BodyId;
  /** Position relative to `centralBody` at epoch, metres. */
  readonly position: Vec3;
  /** Velocity relative to `centralBody` at epoch, m/s. */
  readonly velocity: Vec3;
  /** Total mission delta-v available, m/s. */
  readonly deltaVBudget: number;
  readonly maneuvers: readonly Maneuver[];
}

export interface TrajectoryPoint {
  /** Seconds from the scenario epoch. */
  readonly timeSeconds: number;
  /** Heliocentric position, metres. */
  readonly r: Vec3;
  /** Heliocentric velocity, m/s. */
  readonly v: Vec3;
  /**
   * True at a point that follows a burn, so a plot can draw the velocity discontinuity.
   * The point at the same instant without this flag is the pre-burn state.
   */
  readonly afterBurn: boolean;
}

export interface Trajectory {
  readonly mode: PropagationMode;
  readonly centralBody: BodyId;
  readonly points: readonly TrajectoryPoint[];
  /** Sum of burn magnitudes applied within the propagated span, m/s. */
  readonly usedDeltaV: number;
  /** True when the requested horizon was not reached, e.g. the evaluation budget ran out. */
  readonly truncated: boolean;
  /** True at any sample inside the central body's radius. */
  readonly impacts: boolean;
}

/**
 * Central-difference velocity of a body at a TT Julian date.
 *
 * Same 600 s step and same reasoning as the ephemeris model (PHYSICS.md §4): differentiating
 * the shipped position function is the honest derivative of what the code returns, and the
 * analytic derivative of a linearly-fitted element set is not.
 */
export function bodyVelocity(id: BodyId, jdTt: number): Vec3 {
  const h = 600 / SECONDS_PER_DAY;
  const a = bodyPosition(id, jdTt - h);
  const b = bodyPosition(id, jdTt + h);
  const k = 1 / 1200;
  return { x: (b.x - a.x) * k, y: (b.y - a.y) * k, z: (b.z - a.z) * k };
}

/** Heliocentric state of a spacecraft at epoch, from its central-body-relative state. */
export function heliocentricState(spacecraft: Spacecraft, epochJdTt: number): { r: Vec3; v: Vec3 } {
  const p = bodyPosition(spacecraft.centralBody, epochJdTt);
  const bv = bodyVelocity(spacecraft.centralBody, epochJdTt);
  return { r: add(p, spacecraft.position), v: add(bv, spacecraft.velocity) };
}

/**
 * Number of samples across a horizon.
 *
 * Capped rather than proportional: a ten-year horizon at one sample per minute would be five
 * million points, which is neither useful nor renderable. The cap bounds the point budget
 * while the density stays high enough that a curved arc is visibly curved.
 */
export const MAX_TRAJECTORY_POINTS = 4000;
/** Floor on sample spacing, so short horizons do not produce thousands of redundant points. */
export const MIN_POINT_SPACING_SECONDS = 60;

export interface PropagateOptions {
  /** Horizon, seconds from epoch. */
  readonly horizonSeconds: number;
  readonly mode: PropagationMode;
  /** TT Julian date of the scenario epoch. */
  readonly epochJdTt: number;
  /** Samples across the horizon, excluding burn duplicates. Defaults from the horizon. */
  readonly samples?: number;
  /** Bodies included in N-body mode. Defaults to the whole solar system. */
  readonly enabledBodies?: readonly BodyId[];
}

function defaultSamples(horizonSeconds: number): number {
  return Math.min(
    MAX_TRAJECTORY_POINTS,
    Math.max(64, Math.ceil(horizonSeconds / MIN_POINT_SPACING_SECONDS)),
  );
}

/**
 * Propagates a spacecraft over a horizon, applying every burn inside it.
 *
 * Propagation is split at each burn time, so a burn never lands between samples: the
 * trajectory has a real vertex at every node. Each node contributes a second point at the
 * same instant, marked `afterBurn`, so a plot can show the velocity discontinuity.
 */
export function propagateTrajectory(spacecraft: Spacecraft, options: PropagateOptions): Trajectory {
  const { horizonSeconds, mode, epochJdTt } = options;
  if (!(horizonSeconds > 0)) throw new Error('propagateTrajectory: horizon must be positive');
  if (!Number.isFinite(epochJdTt)) throw new Error('propagateTrajectory: epoch must be finite');

  const samples = options.samples ?? defaultSamples(horizonSeconds);
  const burns = sortedManeuvers(spacecraft.maneuvers).filter(
    (m) => m.timeSeconds >= 0 && m.timeSeconds <= horizonSeconds,
  );

  // Boundaries: epoch, each burn time strictly inside the horizon, the horizon.
  const boundaries: number[] = [0];
  for (const b of burns)
    if (b.timeSeconds > 0 && b.timeSeconds < horizonSeconds) boundaries.push(b.timeSeconds);
  boundaries.push(horizonSeconds);

  const start = heliocentricState(spacecraft, epochJdTt);
  let r = start.r;
  let v = start.v;
  let usedDeltaV = 0;

  /**
   * Applies a burn and returns the new heliocentric velocity.
   *
   * A local burn must be expressed in the frame the user is looking at, which for a
   * geocentric mission is the geocentric frame. Applying it to the heliocentric velocity
   * would make "prograde" mean "along Earth's orbit about the Sun" — off by 90° for a LEO
   * satellite, and a bug that reads as a plausible answer (a 2 km/s "prograde" burn
   * producing a scatter of orbits rather than a transfer ellipse).
   *
   * So: rebuild the local frame from the central-body-relative state, apply the burn there,
   * and add the body velocity back. Inertial burns are heliocentric by definition.
   */
  const applyBurn = (burn: Maneuver, atSeconds: number, rHelio: Vec3, vHelio: Vec3): Vec3 => {
    if (burn.frame === 'inertial') return applyManeuver(burn, { r: rHelio, v: vHelio }).v;
    const jd = epochJdTt + atSeconds / SECONDS_PER_DAY;
    const bodyR = bodyPosition(spacecraft.centralBody, jd);
    const bodyV = bodyVelocity(spacecraft.centralBody, jd);
    const rel = { r: sub(rHelio, bodyR), v: sub(vHelio, bodyV) };
    const burned = applyManeuver(burn, rel);
    return add(bodyV, burned.v);
  };

  const points: TrajectoryPoint[] = [];
  let burnAtZero = false;
  // A burn exactly at the epoch applies before anything is propagated.
  for (const burn of burns) {
    if (burn.timeSeconds > 0) break;
    v = applyBurn(burn, 0, r, v);
    usedDeltaV += maneuverMagnitude(burn);
    burnAtZero = true;
  }
  points.push({ timeSeconds: 0, r, v, afterBurn: burnAtZero });

  const accel = makeNBodyAcceleration(epochJdTt, options.enabledBodies);
  let truncated = false;
  let burnIndex = burns.findIndex((b) => b.timeSeconds > 0);
  if (burnIndex === -1) burnIndex = burns.length;

  for (let seg = 1; seg < boundaries.length; seg++) {
    const t0 = boundaries[seg - 1]!;
    const t1 = boundaries[seg]!;
    if (!(t1 > t0)) continue;

    const segSamples = Math.max(1, Math.round((samples * (t1 - t0)) / horizonSeconds));

    if (mode === 'twoBody') {
      const mu = BODIES[spacecraft.centralBody].mu;
      const relR = subVec(
        r,
        bodyPosition(spacecraft.centralBody, epochJdTt + t0 / SECONDS_PER_DAY),
      );
      const relV = subVec(
        v,
        bodyVelocity(spacecraft.centralBody, epochJdTt + t0 / SECONDS_PER_DAY),
      );
      for (let i = 1; i <= segSamples; i++) {
        const t = t0 + ((t1 - t0) * i) / segSamples;
        const propagated = propagateTwoBody({ r: relR, v: relV }, mu, t - t0);
        const bodyR = bodyPosition(spacecraft.centralBody, epochJdTt + t / SECONDS_PER_DAY);
        const bodyV = bodyVelocity(spacecraft.centralBody, epochJdTt + t / SECONDS_PER_DAY);
        points.push({
          timeSeconds: t,
          r: add(bodyR, propagated.r),
          v: add(bodyV, propagated.v),
          afterBurn: false,
        });
      }
      const bodyPos = bodyPosition(spacecraft.centralBody, epochJdTt + t1 / SECONDS_PER_DAY);
      const bodyVel = bodyVelocity(spacecraft.centralBody, epochJdTt + t1 / SECONDS_PER_DAY);
      const finalRel = propagateTwoBody({ r: relR, v: relV }, mu, t1 - t0);
      r = add(bodyPos, finalRel.r);
      v = add(bodyVel, finalRel.v);
    } else {
      // Incremental integration: step from sample to sample, so each reported point is a
      // real integrator output rather than an interpolant. One sweep, no re-integration.
      let cursor = { t: t0, r, v };
      for (let i = 1; i <= segSamples; i++) {
        const t = t0 + ((t1 - t0) * i) / segSamples;
        const part = integrateAdaptive(cursor, accel, t, {
          relTol: 1e-10,
          absTol: 1e-3,
          maxStep: 3600,
        });
        truncated ||= part.truncated;
        cursor = { t: part.state.t, r: part.state.r, v: part.state.v };
        points.push({ timeSeconds: t, r: cursor.r, v: cursor.v, afterBurn: false });
        if (part.truncated) break;
      }
      r = cursor.r;
      v = cursor.v;
    }

    // Apply every burn scheduled at this boundary.
    while (burnIndex < burns.length && burns[burnIndex]!.timeSeconds <= t1 + 1e-9) {
      const burn = burns[burnIndex]!;
      v = applyBurn(burn, t1, r, v);
      usedDeltaV += maneuverMagnitude(burn);
      points.push({ timeSeconds: t1, r, v, afterBurn: true });
      burnIndex++;
    }
  }

  // An impact check that uses the trajectory we just produced, not a separate model.
  let impacts = false;
  for (const p of points) {
    const bodyPos = bodyPosition(
      spacecraft.centralBody,
      epochJdTt + p.timeSeconds / SECONDS_PER_DAY,
    );
    if (
      Math.hypot(p.r.x - bodyPos.x, p.r.y - bodyPos.y, p.r.z - bodyPos.z) <
      BODIES[spacecraft.centralBody].radius
    ) {
      impacts = true;
      break;
    }
  }

  return { mode, centralBody: spacecraft.centralBody, points, usedDeltaV, truncated, impacts };
}

/** Restricted N-body acceleration as an integrator force function at a fixed epoch. */
function makeNBodyAcceleration(
  epochJdTt: number,
  enabledBodies?: readonly BodyId[],
): AccelerationFn {
  const epochOffset = (epochJdTt - J2000_JD) * SECONDS_PER_DAY;
  const config = enabledBodies ? { enabled: enabledBodies } : undefined;
  return (t, r) => acceleration(r, jdFromSeconds(t + epochOffset), config);
}

function subVec(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

/** Distance from a body's centre, metres. */
export function radiusFromBody(r: Vec3, body: BodyId, jdTt: number): number {
  const p = bodyPosition(body, jdTt);
  return Math.hypot(r.x - p.x, r.y - p.y, r.z - p.z);
}

/** Altitude above a body's mean radius, metres. */
export function altitude(r: Vec3, body: BodyId, jdTt: number): number {
  return radiusFromBody(r, body, jdTt) - BODIES[body].radius;
}

/** Heliocentric distance in AU, for readouts. */
export function heliocentricDistanceAu(r: Vec3): number {
  return Math.hypot(r.x, r.y, r.z) / AU_M;
}

/** Δv remaining, m/s. A negative value means the mission overdraws its budget. */
export function remainingDeltaV(spacecraft: Spacecraft): number {
  let used = 0;
  for (const m of spacecraft.maneuvers) used += maneuverMagnitude(m);
  return spacecraft.deltaVBudget - used;
}
