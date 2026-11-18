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
import { craftFromSpec, circularPeriod, circularSpeed, type CraftSpec } from '../sim/craft.js';
import { totalDeltaV } from '../sim/maneuver.js';
import {
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
  /** Geometry to draw, body-centred scene units. */
  readonly frame: LocalFrameResult;
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
}

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
    frame,
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
