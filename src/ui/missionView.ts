/**
 * Mission view-model: everything the mission panel shows, split by how often it changes.
 *
 * Two levels, because they have wildly different costs:
 *
 * - `buildMissionPlan` propagates the whole horizon and converts it to drawable geometry. That
 *   is the expensive part (up to 4000 samples, and in N-body mode thousands of integrator
 *   steps), and it depends only on the mission and the epoch. It runs when a scenario loads or
 *   a node changes.
 * - `missionProgress` answers "where is the craft now and how much of the plan has it spent"
 *   from the plan alone. It runs on every UI tick.
 *
 * Both stay out of `App.tsx` because they are pure and therefore testable. A mission panel
 * showing a delta-v total that disagrees with the drawn trajectory is the exact class of bug
 * this split prevents: the numbers and the geometry come from one propagation.
 */

import type { BodyId } from '../core/ephemeris/solarSystem.js';
import { BODIES } from '../core/ephemeris/solarSystem.js';
import { SECONDS_PER_DAY } from '../core/constants.js';
import { jdFromIsoUtc, jdTtFromJdUtc } from '../core/time/time.js';
import { buildGroundTrack, type GroundTrack } from '../core/groundTrack/groundTrack.js';
import { craftFromSpec, circularPeriod, circularSpeed, type CraftSpec } from '../sim/craft.js';
import { totalDeltaV } from '../sim/maneuver.js';
import {
  defaultSamples,
  propagateTrajectory,
  radiusFromBody,
  remainingDeltaV,
  type Trajectory,
} from '../sim/trajectory.js';
import {
  flownSegmentCount,
  pointAtTime,
  toLocalFrame,
  type LocalFrameResult,
} from '../render/trajectoryLines.js';
import { groundPointAt, type GroundPoint } from './groundTrackView.js';

export interface MissionNodeView {
  readonly id: string;
  readonly label: string;
  readonly timeSeconds: number;
  /** Magnitude, m/s. */
  readonly magnitude: number;
  readonly frame: 'local' | 'inertial';
}

/** Everything about a mission that does not depend on the simulation clock. */
export interface MissionPlan {
  readonly craftId: string;
  readonly craftName: string;
  readonly centralBody: BodyId;
  /** Body radius, metres, so a readout can report altitude. */
  readonly bodyRadius: number;
  /** Total planned delta-v of every node, m/s. */
  readonly plannedDeltaV: number;
  /** Budget minus planned, m/s. Negative means the plan cannot fly as written. */
  readonly remainingDeltaV: number;
  readonly budget: number;
  readonly nodes: readonly MissionNodeView[];
  /** Circular speed of the initial orbit, m/s, and its period, seconds. */
  readonly initialSpeed: number;
  readonly initialPeriod: number;
  /** True when any sample of the trajectory is inside the central body. */
  readonly impacts: boolean;
  /** True when the propagator ran out of budget before reaching the horizon. */
  readonly truncated: boolean;
  /** Geocentric radius extremes over the predicted path, metres. */
  readonly minRadius: number;
  readonly maxRadius: number;
  /** Planned span, seconds from epoch. */
  readonly horizonSeconds: number;
  /**
   * How much of one initial orbit each drawn sample covers. Smaller is denser.
   *
   * Surfaced rather than corrected: the states are exact closed-form solutions, so the numbers
   * are right; only the picture is coarse. A plan months long on a 96-minute orbit cannot be
   * drawn honestly with 4000 points, and pretending otherwise is worse than saying it.
   */
  readonly periodFractionPerSample: number;
  /** True when a drawn sample spans more than {@link ALIASED_PERIOD_FRACTION} of a revolution. */
  readonly coastAliased: boolean;
  /** Geometry to draw, body-centred scene units. */
  readonly frame: LocalFrameResult;
  /**
   * Sub-satellite track, for the ground-track panel. Null when the central body is not Earth:
   * the ground track's obliquity and sidereal rotation are Earth's, so a lunar or heliocentric
   * mission has no latitude and longitude in this model, and saying so is better than
   * projecting it onto a world map that is not its world.
   */
  readonly groundTrack: GroundTrack | null;
}

/** The part of a mission that changes as the clock advances. */
export interface MissionProgress {
  /** Craft position along the path, body-centred scene units, or null if undrawable. */
  readonly position: { readonly x: number; readonly y: number; readonly z: number } | null;
  /** Segments already flown, for the flown/future split. */
  readonly flownSegments: number;
  /** Delta-v of the nodes the clock has passed, m/s. */
  readonly spentDeltaV: number;
  /** Nodes the clock has passed, in order. */
  readonly appliedNodeIds: readonly string[];
  /** Geocentric radius now, metres, or null when the craft is off the drawn path. */
  readonly radius: number | null;
  /** Altitude above the body surface now, metres. */
  readonly altitude: number | null;
  /**
   * Sub-satellite point now, for the ground-track marker. Null when the mission has no ground
   * track (non-Earth central body) or the craft is outside the track's span.
   */
  readonly groundPoint: GroundPoint | null;
}

/**
 * How much of one initial orbit each drawn sample covers.
 *
 * This exists because a departure node is legitimately months away while the parking orbit it
 * departs from laps every 96 minutes. `propagateTrajectory` caps the whole horizon at
 * `MAX_TRAJECTORY_POINTS`, so over a 735-day horizon each sample spans nearly three
 * revolutions: the propagated states are still exact closed-form solutions, but the *drawn*
 * coast is a star polygon rather than an orbit, and no number in the panel would say so.
 *
 * The value is a fraction of a period, so **smaller is denser**. A short horizon such as the
 * bundled LEO raise is 0.010 (96 samples per orbit); a planned interplanetary departure from a
 * 550 km park measured 2.772 (one point per 2.8 orbits).
 */
export function periodFractionPerSample(spec: CraftSpec, samples?: number): number {
  const count = samples ?? defaultSamples(spec.horizonSeconds);
  const period = circularPeriod(spec);
  return period > 0 && count > 0 ? spec.horizonSeconds / count / period : 0;
}

/** Fraction of a period per sample above which a drawn coast aliases. One in eight is coarse. */
export const ALIASED_PERIOD_FRACTION = 0.125;

/** Propagates a mission and builds its drawable geometry. */
export function buildMissionPlan(spec: CraftSpec, epochUtc: string): MissionPlan {
  const craft = craftFromSpec(spec);
  const epochJdTt = jdTtFromJdUtc(jdFromIsoUtc(epochUtc));
  const trajectory = propagateTrajectory(craft, {
    horizonSeconds: spec.horizonSeconds,
    mode: spec.propagation,
    epochJdTt,
  });

  const frame = toLocalFrame(
    trajectory.points.map((p) => ({ r: p.r, timeSeconds: p.timeSeconds })),
    { centralBody: spec.centralBody, epochJdTt },
  );

  const radii = radiiFromBody(trajectory, spec.centralBody, epochJdTt);
  const bodyRadius = BODIES[spec.centralBody].radius;
  const density = periodFractionPerSample(spec);
  // An orbit drawn with fewer than eight points per revolution is not an orbit on screen.
  const coastAliased = density > ALIASED_PERIOD_FRACTION;

  // The ground track is built from the same propagated samples the 3D path is drawn from, so
  // the map and the picture cannot disagree about where the craft went. Earth only: the
  // projection's obliquity and sidereal rotation are Earth's (PHYSICS.md §13).
  const groundTrack =
    spec.centralBody === 'earth'
      ? buildGroundTrack(
          trajectory.points.map((p) => ({ r: p.r, timeSeconds: p.timeSeconds })),
          { epochJdUtc: jdFromIsoUtc(epochUtc) },
        )
      : null;

  return {
    craftId: spec.id,
    craftName: spec.name,
    centralBody: spec.centralBody,
    bodyRadius,
    plannedDeltaV: totalDeltaV(spec.maneuvers),
    remainingDeltaV: remainingDeltaV(craft),
    budget: spec.deltaVBudget,
    nodes: spec.maneuvers.map((m) => ({
      id: m.id,
      label: m.label ?? m.id,
      timeSeconds: m.timeSeconds,
      magnitude: Math.hypot(m.a, m.b, m.c),
      frame: m.frame,
    })),
    initialSpeed: circularSpeed(spec),
    initialPeriod: circularPeriod(spec),
    impacts: trajectory.impacts,
    truncated: trajectory.truncated,
    minRadius: radii.min,
    maxRadius: radii.max,
    horizonSeconds: spec.horizonSeconds,
    periodFractionPerSample: density,
    coastAliased,
    frame,
    groundTrack,
  };
}

/**
 * Where the craft is now, and what the plan has spent to get it there.
 *
 * Interpolated between samples rather than snapped to the nearest one: a 11600 s horizon with
 * 194 samples steps 60 s at a time, which at 7.6 km/s is 456 km of motion per sample.
 */
export function missionProgress(plan: MissionPlan, simSeconds: number): MissionProgress {
  const { frame } = plan;
  // Interpolation and prefix counting live in `trajectoryLines.ts`, which the scene also uses
  // to place the craft marker. Sharing them is what guarantees the readout and the drawn
  // position cannot drift apart.
  const position = pointAtTime(frame.points, frame.pointTimes, simSeconds);

  // Converted back with the same factor the frame used, so the readout and the picture cannot
  // disagree.
  const radius = position
    ? Math.hypot(position.x, position.y, position.z) / frame.unitsPerMetre
    : null;

  const applied = plan.nodes.filter((n) => n.timeSeconds <= simSeconds);
  return {
    position,
    flownSegments: flownSegmentCount(frame.segmentTimes, simSeconds),
    spentDeltaV: applied.reduce((sum, n) => sum + n.magnitude, 0),
    appliedNodeIds: applied.map((n) => n.id),
    radius,
    altitude: radius !== null ? radius - plan.bodyRadius : null,
    // Interpolated from the same samples the map draws through, so the marker cannot sit off
    // its own track (see `groundTrackView.ts`).
    groundPoint: plan.groundTrack ? groundPointAt(plan.groundTrack, simSeconds) : null,
  };
}

/**
 * Distance from the central body at its extreme samples.
 *
 * Sampled rather than solved: the trajectory is already propagated, and a sampled extreme is
 * within one sample spacing of the true apsis, which is all a readout needs. Taken against the
 * body's position at each sample's own time, so it is the geocentric radius the user is
 * looking at rather than a heliocentric one.
 */
function radiiFromBody(
  trajectory: Trajectory,
  centralBody: BodyId,
  epochJdTt: number,
): { min: number; max: number } {
  let min = Infinity;
  let max = 0;
  for (const point of trajectory.points) {
    const jd = epochJdTt + point.timeSeconds / SECONDS_PER_DAY;
    const r = radiusFromBody(point.r, centralBody, jd);
    if (r < min) min = r;
    if (r > max) max = r;
  }
  return { min: min === Infinity ? 0 : min, max };
}
