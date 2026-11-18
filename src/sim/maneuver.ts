/**
 * Impulsive maneuver nodes.
 *
 * A burn is defined in the local orbital frame at the moment it is applied, not in the
 * inertial frame. That is how mission design works: "200 m/s prograde" stays meaningful
 * wherever the spacecraft happens to be, whereas "200 m/s along inertial +x" does not.
 *
 * The frame itself is not defined here. `src/core/orbit/elements.ts` owns it as
 * `localOrbitalFrame` (radial = r̂, normal = ĥ, prograde = in-plane velocity direction), and
 * this module is a layer on top: node bookkeeping, ordering, budgets and total Δv. Keeping
 * one definition matters because two subtly different "local frames" would make a burn of
 * 200 m/s mean two different things depending on which module applied it.
 */

import { type Vec3, add, scale, vec3 } from '../core/math/vec3.js';
import { applyImpulse, localOrbitalFrame, type StateVector } from '../core/orbit/elements.js';

/** How a burn's three components are expressed. */
export type ManeuverFrame = 'local' | 'inertial';

export interface Maneuver {
  /** Stable identifier for editing and deletion. Not derived from the time. */
  readonly id: string;
  /** Seconds from the scenario epoch. */
  readonly timeSeconds: number;
  /** First component. In `local` it is prograde; in `inertial` it is x. m/s. */
  readonly a: number;
  /** Second component. In `local` it is the orbit normal; in `inertial` it is y. m/s. */
  readonly b: number;
  /** Third component. In `local` it is the outward radial; in `inertial` it is z. m/s. */
  readonly c: number;
  readonly frame: ManeuverFrame;
  /** Optional user label, e.g. "TMI". */
  readonly label?: string;
}

/**
 * The Δv vector a maneuver contributes, in the inertial frame, at the state it is applied to.
 *
 * For a local burn this depends on `r` and `v`, which is the whole point: the same node
 * produces a different inertial Δv at a different point on the orbit.
 */
export function maneuverDeltaV(maneuver: Maneuver, r: Vec3, v: Vec3): Vec3 {
  if (maneuver.frame === 'inertial') return vec3(maneuver.a, maneuver.b, maneuver.c);
  const frame = localOrbitalFrame({ r, v });
  return add(
    add(scale(frame.prograde, maneuver.a), scale(frame.normal, maneuver.b)),
    scale(frame.radial, maneuver.c),
  );
}

/** Magnitude of a maneuver's Δv in m/s. Frame-independent: the axes are orthonormal. */
export function maneuverMagnitude(maneuver: Maneuver): number {
  return Math.hypot(maneuver.a, maneuver.b, maneuver.c);
}

/** Applies a maneuver to a state, returning the state immediately after the burn. */
export function applyManeuver(maneuver: Maneuver, state: StateVector): StateVector {
  if (maneuver.frame === 'inertial') {
    return { r: state.r, v: add(state.v, vec3(maneuver.a, maneuver.b, maneuver.c)) };
  }
  return applyImpulse(state, { prograde: maneuver.a, normal: maneuver.b, radial: maneuver.c });
}

/** Total Δv of a set of maneuvers in m/s: the sum of magnitudes, not the vector sum. */
export function totalDeltaV(maneuvers: readonly Maneuver[]): number {
  let sum = 0;
  for (const m of maneuvers) sum += maneuverMagnitude(m);
  return sum;
}

/**
 * Maneuvers in application order.
 *
 * Ties on time are broken by id so that two nodes at the same instant always apply in the
 * same order: applying burns in a different order at one instant gives a different final
 * velocity when the frames differ, and silently non-deterministic ordering would make a
 * saved scenario replay differently.
 */
export function sortedManeuvers(maneuvers: readonly Maneuver[]): Maneuver[] {
  return [...maneuvers].sort((x, y) => x.timeSeconds - y.timeSeconds || x.id.localeCompare(y.id));
}

/** A maneuver that would occur before the scenario epoch, or is otherwise unusable. */
export function isManeuverInRange(maneuver: Maneuver): boolean {
  return (
    Number.isFinite(maneuver.timeSeconds) &&
    Number.isFinite(maneuver.a) &&
    Number.isFinite(maneuver.b) &&
    Number.isFinite(maneuver.c)
  );
}
