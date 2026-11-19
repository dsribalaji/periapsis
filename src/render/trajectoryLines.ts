/**
 * Turns a propagated trajectory into drawable geometry around its central body.
 *
 * Two scale problems are solved here, in order.
 *
 * 1. **Which frame.** The trajectory is heliocentric; the user wants to see an orbit *about a
 *    body*. Each sample is offset by the central body's position **at that sample's own time**,
 *    which is the body-relative (geocentric) path, and the whole group is anchored at the
 *    body's current scene position. Over a LEO revolution Earth moves about 25 of its own
 *    radii, so a heliocentric-inertial drawing would smear the orbit right off the planet;
 *    a body-relative drawing is both what "the orbit" means and what stays on screen. The cost
 *    is that a craft genuinely leaving the body (a heliocentric transfer) is drawn as a curve
 *    attached to that body. Stated in PHYSICS.md §10 rather than left to be discovered.
 *
 *    Subtracting the body position at the **epoch** instead - which this module did until M5.5 -
 *    is not a smaller approximation, it is a different (and wrong) quantity: it leaves the
 *    body's own displacement over the horizon in the offsets *and* the group transform then
 *    adds it back. Measured, that drew the bundled 550 km orbit as a 343,000 km streak (a
 *    craft sitting exactly at Earth's centre was drawn 10 units away after 30 minutes), and the
 *    same error fed the altitude readout, which reported 337,018 km for a 550 km orbit.
 *
 * 2. **Which scale.** The same true scale as everything else in the scene (`UNITS_PER_M`), so
 *    the path and the bodies cannot disagree: a 400 km orbit sits 1.063 radii from the centre
 *    of an Earth drawn at its real size, GEO at 6.6 radii, the Moon's orbit at 60. Under the
 *    compressed layout the scene scales the whole group by the map's local scale, which keeps
 *    the path consistent with the Moon drawn beside it (see `localUnitsPerMetre`).
 *
 * Output is disjoint vertex pairs in time order, plus the end time of each segment. Because
 * the segments are ordered, "already flown" is always a *prefix*, so highlighting it costs a
 * `drawRange` and never a rebuild.
 *
 * Everything here is a pure function of its inputs, so it is unit-tested directly rather than
 * through a screenshot.
 */

import type { BodyId } from '../core/ephemeris/solarSystem.js';
import { bodyPosition } from '../core/ephemeris/ephemeris.js';
import { SECONDS_PER_DAY } from '../core/constants.js';
import type { Vec3 } from '../core/math/vec3.js';
import { UNITS_PER_M, scaleOffset } from './scale.js';

/** A point of the propagated trajectory, in heliocentric metres. */
export interface LocalFramePoint {
  readonly r: Vec3;
  readonly timeSeconds: number;
}

export interface LocalFrameOptions {
  readonly centralBody: BodyId;
  /** TT Julian date of the scenario epoch: time zero for the sample times. */
  readonly epochJdTt: number;
  /**
   * How far from the body the line may reach, in scene units. Beyond this a body-centred
   * drawing has stopped meaning anything (the craft is no longer near the body) and the point
   * is dropped.
   */
  readonly envelopeUnits?: number;
}

export interface LocalFrameResult {
  /** Vertex pairs in body-centred scene units, six floats per segment. */
  readonly positions: Float32Array;
  /** Seconds from epoch at which each segment *ends*. Ascending, one per segment. */
  readonly segmentTimes: Float32Array;
  /** Per-point times, for locating the craft between samples. One per point. */
  readonly pointTimes: Float32Array;
  /** Per-point body-centred positions, three floats each, aligned with `pointTimes`. */
  readonly points: Float32Array;
  /** Points dropped because they fell outside the envelope, so the UI can say it is partial. */
  readonly clippedPoints: number;
  /** How many separate runs of drawn points there are. More than one means a mid-path clip. */
  readonly runs: number;
  /** Largest body-centred distance drawn, scene units. Zero when nothing was drawn. */
  readonly extentUnits: number;
  /** Scene units per metre used for the offsets, so callers can convert back to metres. */
  readonly unitsPerMetre: number;
}

/**
 * Envelope default, in metres from the central body.
 *
 * 1.06e7 km, or 27 Earth-Moon distances: generous for anything a patched-conic view calls
 * local, and small enough that leaving it is worth telling the user about. (The same physical
 * reach the envelope had when it was stated in exaggerated scene units.)
 */
export const DEFAULT_ENVELOPE_M = 1.06e10;

/** The default envelope in scene units. */
export const DEFAULT_ENVELOPE_UNITS = DEFAULT_ENVELOPE_M * UNITS_PER_M;

/**
 * Converts heliocentric trajectory points to body-centred geometry in scene units.
 *
 * Every point is drawn; the caller positions the craft marker itself with `pointAtTime`.
 */
export function toLocalFrame(
  points: readonly LocalFramePoint[],
  options: LocalFrameOptions,
): LocalFrameResult {
  const envelope = options.envelopeUnits ?? DEFAULT_ENVELOPE_UNITS;
  if (!(envelope > 0)) throw new Error('toLocalFrame: envelope must be positive');

  const unitsPerMetre = UNITS_PER_M;

  const positions: number[] = [];
  const segmentTimes: number[] = [];
  const pointTimes: number[] = [];
  const kept: number[] = [];
  let clippedPoints = 0;
  let extentUnits = 0;
  let runs = 0;

  // Previous drawn point, or null just after a clip: a pair is only emitted between two
  // points that were both drawn and are adjacent in the input.
  let previous: { x: number; y: number; z: number } | null = null;

  for (const point of points) {
    // The body's position at *this sample's* time, not at the epoch. The group transform
    // anchors the result at the body's live position, so the offsets must be the body-relative
    // path for the two to compose correctly: epoch-relative offsets plus a live anchor draw the
    // body's own motion as if the craft had flown it (see the module note).
    const origin = bodyPosition(
      options.centralBody,
      options.epochJdTt + point.timeSeconds / SECONDS_PER_DAY,
    );
    const [x, y, z] = scaleOffset(
      point.r.x - origin.x,
      point.r.y - origin.y,
      point.r.z - origin.z,
      unitsPerMetre,
    );
    const radius = Math.hypot(x, y, z);

    if (radius > envelope) {
      clippedPoints++;
      previous = null;
      continue;
    }

    if (!previous) runs++;
    if (previous) {
      positions.push(previous.x, previous.y, previous.z, x, y, z);
      segmentTimes.push(point.timeSeconds);
    }

    if (radius > extentUnits) extentUnits = radius;
    pointTimes.push(point.timeSeconds);
    kept.push(x, y, z);
    previous = { x, y, z };
  }

  return {
    positions: Float32Array.from(positions),
    segmentTimes: Float32Array.from(segmentTimes),
    pointTimes: Float32Array.from(pointTimes),
    points: Float32Array.from(kept),
    clippedPoints,
    runs,
    extentUnits,
    unitsPerMetre,
  };
}

/**
 * Body-centred position at a simulation time, linearly interpolated between samples.
 *
 * Returns null when nothing was drawn, and clamps to the ends: asking for a time before the
 * path starts should show the craft at the start, not make it vanish.
 */
export function pointAtTime(
  points: Float32Array,
  pointTimes: Float32Array,
  timeSeconds: number,
): { x: number; y: number; z: number } | null {
  const count = pointTimes.length;
  if (count === 0) return null;
  if (timeSeconds <= pointTimes[0]!) return vectorAt(points, 0);
  if (timeSeconds >= pointTimes[count - 1]!) return vectorAt(points, count - 1);

  // Binary search: this runs once per craft per UI update, and a path can hold 4000 points.
  let lo = 0;
  let hi = count - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (pointTimes[mid]! <= timeSeconds) lo = mid;
    else hi = mid;
  }
  const t0 = pointTimes[lo]!;
  const t1 = pointTimes[hi]!;
  const f = t1 > t0 ? (timeSeconds - t0) / (t1 - t0) : 0;
  const a = vectorAt(points, lo);
  const b = vectorAt(points, hi);
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, z: a.z + (b.z - a.z) * f };
}

/**
 * How many segments end at or before `timeSeconds`.
 *
 * Segments are emitted in ascending time order, so this is exactly the flown prefix length
 * even when a mid-path clip removed segments: the remaining ones are still ordered.
 */
export function flownSegmentCount(segmentTimes: Float32Array, timeSeconds: number): number {
  let count = 0;
  while (count < segmentTimes.length && segmentTimes[count]! <= timeSeconds) count++;
  return count;
}

function vectorAt(points: Float32Array, index: number): { x: number; y: number; z: number } {
  const o = index * 3;
  return { x: points[o]!, y: points[o + 1]!, z: points[o + 2]! };
}
