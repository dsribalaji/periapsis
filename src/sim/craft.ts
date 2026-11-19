/**
 * Spacecraft definitions: parameters in, `Spacecraft` out.
 *
 * A spacecraft is described by an orbit *parameterisation* — central body, altitude,
 * inclination, phase — not by a position and velocity vector. That is deliberate and it is
 * the same principle scenarios already follow (DECISIONS D-009): position is derived from a
 * handful of numbers that have an obvious physical meaning, so a hand-written mission file
 * cannot contain a state that is inconsistent with itself. "400 km circular orbit at 51.6
 * degrees" is checkable by a reader; `r = (6771000, 0, 0)` is not.
 *
 * The frame is the ecliptic-ish physics frame used everywhere else: +z is the ecliptic north
 * pole, so an orbit with inclination 0 lies in the xy plane. Earth's actual equator is tilted
 * 23.4 degrees from that, and this model does not correct for it — a LEO inclination quoted
 * against the equator would be off by that much in this view. Recorded in PHYSICS.md §10 and
 * surfaced in the UI caveat rather than silently ignored.
 */

import { BODIES, type BodyId } from '../core/ephemeris/solarSystem.js';
import { vec3, type Vec3 } from '../core/math/vec3.js';
import type { StateVector } from '../core/orbit/elements.js';
import type { Maneuver } from './maneuver.js';
import type { PropagationMode, Spacecraft } from './trajectory.js';

export interface CircularOrbitSpec {
  /** Altitude above the body's mean radius, metres. Must exceed zero. */
  readonly altitudeM: number;
  /** Angle between the orbital plane and the reference (xy) plane, radians. */
  readonly inclinationRad: number;
  /** Position around the orbit at epoch, radians from the reference x axis. */
  readonly phaseRad: number;
}

export interface CraftSpec {
  readonly id: string;
  readonly name: string;
  readonly centralBody: BodyId;
  readonly orbit: CircularOrbitSpec;
  /** Total delta-v available, m/s. */
  readonly deltaVBudget: number;
  /** Which propagator the mission is planned with. */
  readonly propagation: PropagationMode;
  /** Planned span from the scenario epoch, seconds. */
  readonly horizonSeconds: number;
  readonly maneuvers: readonly Maneuver[];
}

/**
 * Unit vectors of a circular orbit's local frame at a phase, in the physics frame.
 *
 * The in-plane basis is `p = x̂` and `q = (0, cos i, sin i)`, so inclination 0 is prograde in
 * the xy plane. Exposed separately from {@link circularOrbitState} because the *directions* do
 * not depend on the body, its radius or its `mu` — only on the inclination and the phase —
 * and because a second hand-written copy of this basis is how the orbit normal ended up with
 * the wrong sign in the transfer code.
 */
export function circularOrbitFrame(
  orbit: CircularOrbitSpec,
  phaseRad: number = orbit.phaseRad,
): { prograde: Vec3; normal: Vec3; radial: Vec3 } {
  const cosI = Math.cos(orbit.inclinationRad);
  const sinI = Math.sin(orbit.inclinationRad);
  const cosU = Math.cos(phaseRad);
  const sinU = Math.sin(phaseRad);
  return {
    radial: vec3(cosU, sinU * cosI, sinU * sinI),
    prograde: vec3(-sinU, cosU * cosI, cosU * sinI),
    // p x q, which is up and to the north for a prograde orbit: +y component is -sin i.
    normal: vec3(0, -sinI, cosI),
  };
}

/**
 * Position and velocity on a circular orbit, relative to the central body.
 *
 * The in-plane basis is `p̂` along the reference x axis and `q̂` tilted by the inclination
 * about that axis, so inclination 0 gives a prograde orbit in the xy plane and inclination π
 * gives a retrograde one in the same plane. Returns a `StateVector` so it composes with the
 * rest of `src/core/orbit`.
 */
export function circularOrbitState(centralBody: BodyId, orbit: CircularOrbitSpec): StateVector {
  const mu = BODIES[centralBody].mu;
  const radius = BODIES[centralBody].radius + orbit.altitudeM;
  if (!(radius > BODIES[centralBody].radius)) {
    throw new Error(
      `circularOrbitState: altitude ${orbit.altitudeM} m does not clear the ${centralBody} surface`,
    );
  }

  const frame = circularOrbitFrame(orbit);
  const speed = Math.sqrt(mu / radius);
  const r = {
    x: radius * frame.radial.x,
    y: radius * frame.radial.y,
    z: radius * frame.radial.z,
  };
  const v = {
    x: speed * frame.prograde.x,
    y: speed * frame.prograde.y,
    z: speed * frame.prograde.z,
  };

  return { r, v };
}

/** Builds the runnable spacecraft from its parameterised definition. */
export function craftFromSpec(spec: CraftSpec): Spacecraft {
  const { r, v } = circularOrbitState(spec.centralBody, spec.orbit);
  return {
    id: spec.id,
    name: spec.name,
    centralBody: spec.centralBody,
    position: r,
    velocity: v,
    deltaVBudget: spec.deltaVBudget,
    maneuvers: spec.maneuvers,
  };
}

/** Orbital period of the craft's initial circular orbit, seconds. */
export function circularPeriod(spec: CraftSpec): number {
  const mu = BODIES[spec.centralBody].mu;
  const radius = BODIES[spec.centralBody].radius + spec.orbit.altitudeM;
  return 2 * Math.PI * Math.sqrt((radius * radius * radius) / mu);
}

/** Circular orbital speed at the craft's altitude, m/s. */
export function circularSpeed(spec: CraftSpec): number {
  const mu = BODIES[spec.centralBody].mu;
  const radius = BODIES[spec.centralBody].radius + spec.orbit.altitudeM;
  return Math.sqrt(mu / radius);
}
