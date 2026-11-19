/**
 * Ground track: where a satellite is, in latitude and longitude, projected onto the Earth.
 *
 * This is a chain of three frames, and every step is a place where a plausible-looking
 * answer can be wrong in a way that is invisible in the numbers:
 *
 * 1. **Heliocentric → Earth-relative.** The trajectory is stored heliocentrically. A ground
 *    track needs the vector from the Earth's centre, and it must be taken against the Earth's
 *    position at *that sample's own time*, not at the epoch. The epoch-relative version is a
 *    documented drawing convention (PHYSICS.md §10.2, D-014) that is right for a picture of an
 *    orbit and completely wrong for a sub-satellite point: the Earth moves about 30 km/s, so
 *    over one 96-minute revolution an epoch-fixed frame drifts some 2.8 Earth radii.
 *
 * 2. **Ecliptic → equatorial.** **This project's physics frame is ecliptic-referenced**:
 *    +z is the ecliptic north pole, and PHYSICS.md §10.4 says so explicitly. Latitude and
 *    longitude are equatorial. The two planes differ by the obliquity, 23.44°, so skipping
 *    this rotation does not produce a small error — it produces a ground track that is wrong
 *    by a whole obliquity, and a satellite in an ecliptic-plane orbit would be reported as
 *    permanently over the equator instead of tracing ±23.4°. This is the correction §10.4
 *    defers to M6, closed here.
 *
 * 3. **Equatorial inertial → Earth-fixed.** Rotate by −GMST about the equatorial pole. The
 *    Earth-fixed frame turns with the planet, so a point whose right ascension is α sits at
 *    longitude α − GMST.
 *
 * What this deliberately does **not** do:
 *
 * - **Geodetic** latitude. The sub-satellite point here is *geocentric*: the spherical
 *   latitude of the radius vector. On the WGS-84 ellipsoid these differ by up to 0.19°
 *   (about 21 km at the equator), which is larger than a coarse map pixel. A graticule-only
 *   map (D-004) cannot show the difference, so pretending to an ellipsoid would add code
 *   without adding truth. Stated here, and in the panel when M6.2 arrives.
 * - **Precession, nutation, polar motion.** GMST is IAU-1982 from UT1 ≈ UTC (PHYSICS.md §1.3),
 *   so the stated longitude error is its own, not this module's.
 * - **Obstruction by the Earth.** A sub-satellite point exists even when the satellite is on
 *   the far side; visibility is a separate question and is not modelled.
 *
 * Pure: no clock, no DOM, no randomness. Times are parameters.
 */

import { OBLIQUITY_J2000, RADIUS, SECONDS_PER_DAY } from '../constants.js';
import { bodyPosition } from '../ephemeris/ephemeris.js';
import { type Vec3, length, rotateX, rotateZ, sub } from '../math/vec3.js';
import { gmstRadians, jdTtFromJdUtc } from '../time/time.js';

/**
 * Geocentric latitude and longitude of a point, plus its distance from the Earth's centre.
 *
 * `latRad` is geocentric (see the module note), `lonRad` is east-positive in (−π, π] with
 * 0 at Greenwich. Both are radians; the UI converts for display.
 */
export interface GeocentricPoint {
  readonly latRad: number;
  readonly lonRad: number;
  /** Distance from the Earth's centre, metres. */
  readonly radiusM: number;
}

/** Rotates an ecliptic-frame vector into the equatorial frame about the vernal equinox. */
export function eclipticToEquatorial(v: Vec3): Vec3 {
  // Standard obliquity rotation: x is shared by both equinoxes.
  //   y_eq = y cos e - z sin e
  //   z_eq = y sin e + z cos e
  return rotateX(v, OBLIQUITY_J2000);
}

/**
 * Rotates an equatorial inertial vector into the Earth-fixed frame at a UTC instant.
 *
 * Earth-fixed is the inertial frame turned by −GMST, so a point at right ascension α has
 * longitude α − GMST. UT1 is approximated by UTC, as everywhere else in this project.
 */
export function equatorialToEarthFixed(v: Vec3, jdUtc: number): Vec3 {
  return rotateZ(v, -gmstRadians(jdUtc));
}

/** Latitude, longitude and radius of an Earth-fixed vector. Null for a zero vector. */
export function geocentricFromEarthFixed(v: Vec3): GeocentricPoint | null {
  const radiusM = length(v);
  if (!(radiusM > 0)) return null;
  // asin's argument can overshoot ±1 by an ulp for a vector on the pole; clamp, then the
  // latitude is exactly ±π/2 instead of NaN.
  const ratio = Math.max(-1, Math.min(1, v.z / radiusM));
  return { latRad: Math.asin(ratio), lonRad: Math.atan2(v.y, v.x), radiusM };
}

/**
 * Sub-satellite point for a heliocentric position at one instant.
 *
 * Returns null when the craft is exactly at the Earth's centre, where latitude and longitude
 * are undefined. That is a real condition — the restricted N-body field is singular there
 * anyway (STATE.md) — so it is reported rather than silently answered as (0, 0).
 */
export function subSatellitePoint(heliocentric: Vec3, jdUtc: number): GeocentricPoint | null {
  const relative = sub(heliocentric, bodyPosition('earth', jdTtFromJdUtc(jdUtc)));
  return geocentricFromEarthFixed(equatorialToEarthFixed(eclipticToEquatorial(relative), jdUtc));
}

/** One sample of a ground track: the sub-satellite point, and where the craft is above it. */
export interface GroundTrackSample {
  /** Seconds from the scenario epoch, matching the trajectory point it came from. */
  readonly timeSeconds: number;
  /** UTC Julian date of this sample. */
  readonly jdUtc: number;
  /** Geocentric latitude, radians. */
  readonly latRad: number;
  /** East-positive longitude in (−π, π], radians. */
  readonly lonRad: number;
  /** Height above the mean equatorial radius, metres. Negative underground. */
  readonly altitudeM: number;
  /**
   * True when the segment *ending* at this sample crosses the ±180° meridian.
   *
   * A ground track drawn as a plain polyline jumps the full width of the map at the
   * antimeridian, because longitude wraps from +π to −π. A renderer must break the line
   * there. The flag is computed here, next to the wrap, so the renderer never has to infer
   * it from two longitudes it might not even have. Always false for the first sample.
   */
  readonly crossesAntimeridian: boolean;
}

/** A heliocentric position at a time, in the shape `propagateTrajectory` produces. */
export interface GroundTrackInput {
  readonly r: Vec3;
  readonly timeSeconds: number;
}

export interface GroundTrack {
  readonly samples: readonly GroundTrackSample[];
  /** UTC Julian date of the scenario epoch: time zero for `timeSeconds`. */
  readonly epochJdUtc: number;
  /** Samples dropped because the craft was exactly at the Earth's centre. */
  readonly undefinedPoints: number;
  /** True when any sample is inside the Earth's mean radius. */
  readonly belowSurface: boolean;
  /** Highest and lowest sub-satellite altitude, metres. Null when nothing was defined. */
  readonly minAltitudeM: number | null;
  readonly maxAltitudeM: number | null;
}

export interface GroundTrackOptions {
  /** UTC Julian date of the scenario epoch. `timeSeconds` is measured from here. */
  readonly epochJdUtc: number;
}

/**
 * Builds a ground track from heliocentric trajectory samples.
 *
 * Samples are kept in input order and every one is converted independently, so a burn
 * discontinuity or a clipped arc upstream shows up as a discontinuity here rather than being
 * smoothed across. The antimeridian flag is the only cross-sample computation.
 */
export function buildGroundTrack(
  points: readonly GroundTrackInput[],
  options: GroundTrackOptions,
): GroundTrack {
  const { epochJdUtc } = options;
  if (!Number.isFinite(epochJdUtc)) {
    throw new Error('buildGroundTrack: epoch must be a finite Julian date');
  }

  const samples: GroundTrackSample[] = [];
  let undefinedPoints = 0;
  let belowSurface = false;
  let minAltitudeM: number | null = null;
  let maxAltitudeM: number | null = null;

  let previousLon: number | null = null;

  for (const point of points) {
    if (!Number.isFinite(point.timeSeconds)) {
      throw new Error('buildGroundTrack: sample time must be finite');
    }
    const jdUtc = epochJdUtc + point.timeSeconds / SECONDS_PER_DAY;
    const fixed = subSatellitePoint(point.r, jdUtc);
    if (!fixed) {
      undefinedPoints++;
      // The track genuinely breaks here: a renderer must not join across it.
      previousLon = null;
      continue;
    }

    const altitudeM = fixed.radiusM - RADIUS.earth;
    if (altitudeM < 0) belowSurface = true;
    if (minAltitudeM === null || altitudeM < minAltitudeM) minAltitudeM = altitudeM;
    if (maxAltitudeM === null || altitudeM > maxAltitudeM) maxAltitudeM = altitudeM;

    const crossesAntimeridian =
      previousLon !== null && Math.abs(fixed.lonRad - previousLon) > Math.PI;
    previousLon = fixed.lonRad;

    samples.push({
      timeSeconds: point.timeSeconds,
      jdUtc,
      latRad: fixed.latRad,
      lonRad: fixed.lonRad,
      altitudeM,
      crossesAntimeridian,
    });
  }

  return {
    samples,
    epochJdUtc,
    undefinedPoints,
    belowSurface,
    minAltitudeM,
    maxAltitudeM,
  };
}
