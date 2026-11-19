/**
 * Ground-track view-model: the map geometry and the readouts, with no canvas in sight.
 *
 * The projection is equirectangular (plate carrée) on a 2:1 rectangle, which is the map D-004
 * chose: longitude linear in x, latitude linear in y, no coastlines. That is a *graticule* map,
 * and every one of its costs is stated in the panel rather than left for the user to discover:
 *
 * - No coastlines. A dot at 40°N 100°W is over Kansas only if the reader knows it is.
 * - Geocentric latitude, not geodetic (PHYSICS.md §13.2): up to 0.19°, about 21 km.
 * - Distortion: an equirectangular map stretches east-west by 1/cos(lat). The graticule is
 *   drawn as a grid of straight lines, which is honest for this projection, but a reader who
 *   assumes a globe will misjudge distances away from the equator. Stated, not corrected.
 *
 * Two things this module is careful about, both because they are the standard ways a ground
 * track is drawn wrong:
 *
 * 1. **The antimeridian.** Longitude wraps from +180° to −180°. A polyline drawn through both
 *    values runs the full width of the map, which reads as the satellite teleporting. The
 *    samples carry `crossesAntimeridian` (computed next to the wrap in the core module), and
 *    {@link trackPolylines} breaks there. It also breaks at an undefined sample, because the
 *    track genuinely does not exist at the Earth's centre.
 * 2. **The "now" marker must sit on the drawn line.** {@link groundPointAt} interpolates between
 *    the *same* samples the polylines are drawn through, so the marker cannot float off its own
 *    track — the failure mode D-032 was, in a different projection.
 */

import type { GroundTrack, GroundTrackSample } from '../core/groundTrack/groundTrack.js';

/** A point in normalised map coordinates: 0..1, x east from −180°, y south from +90°. */
export interface MapPoint {
  readonly x: number;
  readonly y: number;
}

/** Latitude and longitude of a sub-satellite point, in radians, with its altitude. */
export interface GroundPoint {
  readonly latRad: number;
  readonly lonRad: number;
  readonly altitudeM: number;
}

/** Degrees between graticule lines. 30° gives 12 meridians and 5 parallels: a readable grid. */
export const GRATICULE_STEP_DEG = 30;

/** Longitudes of the drawn meridians, degrees in (−180, 180]. */
export const MERIDIAN_DEG: readonly number[] = Array.from(
  { length: 360 / GRATICULE_STEP_DEG - 1 },
  (_, i) => -180 + GRATICULE_STEP_DEG * (i + 1),
);

/** Latitudes of the drawn parallels, degrees, excluding the poles (which are the map edges). */
export const PARALLEL_DEG: readonly number[] = Array.from(
  { length: 180 / GRATICULE_STEP_DEG - 1 },
  (_, i) => -90 + GRATICULE_STEP_DEG * (i + 1),
);

const HALF_PI = Math.PI / 2;
const TWO_PI = Math.PI * 2;

/** Wraps a longitude into (−π, π]. */
export function wrapLonRad(lonRad: number): number {
  if (!Number.isFinite(lonRad)) return 0;
  // Remainder keeps the sign of the dividend, so shift into [0, 2π) first.
  const shifted = ((lonRad % TWO_PI) + TWO_PI) % TWO_PI;
  return shifted > Math.PI ? shifted - TWO_PI : shifted;
}

/**
 * Equirectangular projection of a geocentric point, in normalised map coordinates.
 *
 * x = (lon + π) / 2π, y = (π/2 − lat) / π. Clamped in latitude so a rounding overshoot at a
 * pole lands on the map edge rather than outside it.
 */
export function projectPoint(latRad: number, lonRad: number): MapPoint {
  const lat = Math.max(-HALF_PI, Math.min(HALF_PI, latRad));
  return {
    x: (wrapLonRad(lonRad) + Math.PI) / TWO_PI,
    y: (HALF_PI - lat) / Math.PI,
  };
}

/**
 * Splits a ground track into polylines, in normalised map coordinates.
 *
 * A new polyline starts wherever the track does not continue:
 *
 * - at an **antimeridian crossing**, where the longitude wrap would otherwise draw a line the
 *   full width of the map;
 * - at a **gap**, where the craft sat at the Earth's centre and no latitude or longitude
 *   existed. `buildGroundTrack` drops that sample and marks the next one `startsAfterGap`, so
 *   the renderer is told rather than left to infer it from sample spacing — an inference that
 *   fails on a short track and would mistake a sparse-but-continuous one for a hole.
 *
 * A one-sample polyline is kept as a one-point line rather than dropped — the renderer draws it
 * as a dot, which is the honest picture of a track that exists at one instant and nowhere
 * adjacent.
 */
export function trackPolylines(track: GroundTrack): readonly (readonly MapPoint[])[] {
  const lines: MapPoint[][] = [];
  let current: MapPoint[] = [];

  for (const sample of track.samples) {
    if ((sample.crossesAntimeridian || sample.startsAfterGap) && current.length > 0) {
      lines.push(current);
      current = [];
    }
    current.push(projectPoint(sample.latRad, sample.lonRad));
  }
  if (current.length > 0) lines.push(current);

  return lines;
}

/**
 * The sub-satellite point at an arbitrary time, interpolated between samples.
 *
 * Linear in latitude and in **unwrapped** longitude: when the two bracketing samples straddle
 * the antimeridian, the difference is taken the short way round, so a marker crossing ±180°
 * moves a few degrees rather than sweeping the whole map. Longitude is wrapped again on the way
 * out, so the caller always gets a real longitude in (−π, π].
 *
 * Linear interpolation is exact enough here because it is what the map already draws: the
 * polyline is straight segments between these samples, so the marker is on the line by
 * construction. The error is the sagitta of one segment — at LEO with the default 4000-sample
 * cap that is a fraction of a pixel — and it is bounded by the drawn path rather than by the
 * marker, which is the property that matters.
 *
 * Returns null outside the track's time span, and null across a gap: the sample after a gap
 * carries `startsAfterGap`, and interpolating across it would invent a position the craft never
 * held.
 */
export function groundPointAt(track: GroundTrack, timeSeconds: number): GroundPoint | null {
  const samples = track.samples;
  if (samples.length === 0) return null;
  const first = samples[0]!;
  const last = samples[samples.length - 1]!;
  if (!(timeSeconds >= first.timeSeconds) || timeSeconds > last.timeSeconds) return null;

  // Binary search for the last sample at or before the requested time.
  let low = 0;
  let high = samples.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (samples[mid]!.timeSeconds <= timeSeconds) low = mid;
    else high = mid - 1;
  }

  const before = samples[low]!;
  if (before.timeSeconds === timeSeconds) return pointOf(before);
  const after = samples[low + 1];
  if (!after) return pointOf(before);
  if (after.startsAfterGap) return null;
  return interpolate(before, after, timeSeconds);
}

function pointOf(sample: GroundTrackSample): GroundPoint {
  return { latRad: sample.latRad, lonRad: sample.lonRad, altitudeM: sample.altitudeM };
}

function interpolate(
  before: GroundTrackSample,
  after: GroundTrackSample,
  timeSeconds: number,
): GroundPoint {
  const span = after.timeSeconds - before.timeSeconds;
  const f = span > 0 ? (timeSeconds - before.timeSeconds) / span : 0;
  // Take the short way round: a naive difference across the antimeridian is ~2π, which would
  // sweep the marker the width of the map for a few seconds of motion.
  let deltaLon = after.lonRad - before.lonRad;
  if (deltaLon > Math.PI) deltaLon -= TWO_PI;
  else if (deltaLon < -Math.PI) deltaLon += TWO_PI;
  return {
    latRad: before.latRad + (after.latRad - before.latRad) * f,
    lonRad: wrapLonRad(before.lonRad + deltaLon * f),
    altitudeM: before.altitudeM + (after.altitudeM - before.altitudeM) * f,
  };
}

/** Facts about a ground track that the panel states rather than leaves implicit. */
export interface GroundTrackSummary {
  /** Latitude of the first sample, radians. */
  readonly startLatRad: number;
  readonly startLonRad: number;
  /** Samples in the track. */
  readonly sampleCount: number;
  /** Points where latitude/longitude were undefined (craft at the Earth's centre). */
  readonly undefinedPoints: number;
  /** True when any sample is inside the Earth's mean radius. */
  readonly belowSurface: boolean;
  readonly minAltitudeM: number | null;
  readonly maxAltitudeM: number | null;
  /** True when the track crosses the antimeridian at least once. */
  readonly crossesAntimeridian: boolean;
  /** True when the track spans less than a full revolution: it covers an arc, not the globe. */
  readonly partialCoverage: boolean;
  /** Longitude span covered, radians, taken as the unwrapped extent of the drawn path. */
  readonly lonSpanRad: number;
}

/**
 * Summarises a track for the panel.
 *
 * `partialCoverage` exists because a short mission draws a short arc: a 96-minute LEO plan
 * covers about one revolution, which on a world map is one stripe, and a user who expected a
 * full track needs to be told that is the plan's length and not a bug. The threshold is one
 * revolution of longitude (2π) measured as the unwrapped span.
 */
export function summariseGroundTrack(track: GroundTrack): GroundTrackSummary | null {
  const samples = track.samples;
  if (samples.length === 0) return null;

  let unwrapped = 0;
  let previous = samples[0]!.lonRad;
  let minLon = 0;
  let maxLon = 0;
  let crossings = false;
  for (let i = 1; i < samples.length; i++) {
    const sample = samples[i]!;
    let delta = sample.lonRad - previous;
    if (delta > Math.PI) delta -= TWO_PI;
    else if (delta < -Math.PI) delta += TWO_PI;
    unwrapped += delta;
    if (sample.crossesAntimeridian) crossings = true;
    if (unwrapped < minLon) minLon = unwrapped;
    if (unwrapped > maxLon) maxLon = unwrapped;
    previous = sample.lonRad;
  }

  const lonSpanRad = maxLon - minLon;
  return {
    startLatRad: samples[0]!.latRad,
    startLonRad: samples[0]!.lonRad,
    sampleCount: samples.length,
    undefinedPoints: track.undefinedPoints,
    belowSurface: track.belowSurface,
    minAltitudeM: track.minAltitudeM,
    maxAltitudeM: track.maxAltitudeM,
    crossesAntimeridian: crossings,
    partialCoverage: lonSpanRad < TWO_PI * 0.999,
    lonSpanRad,
  };
}

/** Formats a latitude or longitude as `12.3°N`, with the hemisphere rather than a sign. */
export function formatAngle(radians: number, axis: 'lat' | 'lon'): string {
  if (!Number.isFinite(radians)) return '--';
  const degrees = (radians * 180) / Math.PI;
  const hemisphere = axis === 'lat' ? (degrees >= 0 ? 'N' : 'S') : degrees >= 0 ? 'E' : 'W';
  return `${Math.abs(degrees).toFixed(1)}°${hemisphere}`;
}

/** An RGBA buffer at map resolution, ready for `ImageData`. Row 0 is 90°N. */
export interface GroundTrackImage {
  readonly width: number;
  readonly height: number;
  /**
   * Backed by a plain `ArrayBuffer`, not `ArrayBufferLike`, because `new ImageData(...)` takes
   * `Uint8ClampedArray<ArrayBuffer>` and rejects a `SharedArrayBuffer`-backed view.
   */
  readonly data: Uint8ClampedArray<ArrayBuffer>;
}

/** Map resolution. 2:1, matching the projection; small because CSS scales it up smoothly. */
export const MAP_WIDTH = 720;
export const MAP_HEIGHT = 360;

const BACKGROUND: readonly [number, number, number] = [12, 18, 30];
const GRATICULE: readonly [number, number, number] = [44, 58, 82];
const EQUATOR: readonly [number, number, number] = [66, 86, 116];
const TRACK: readonly [number, number, number] = [255, 159, 28];
const BELOW_SURFACE: readonly [number, number, number] = [190, 52, 44];

function putPixel(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  y: number,
  colour: readonly [number, number, number],
): void {
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  const index = (y * width + x) * 4;
  data[index] = colour[0];
  data[index + 1] = colour[1];
  data[index + 2] = colour[2];
  data[index + 3] = 255;
}

/**
 * Draws the map: background, graticule, then the track.
 *
 * Painted into a buffer rather than with canvas strokes so the whole picture is a value a unit
 * test can assert on — the same reason `porkchopImage` exists. The canvas in the panel does one
 * `putImageData` and nothing else.
 *
 * The track is drawn with a Bresenham line so a segment longer than a pixel is still connected;
 * at map resolution a 96-minute LEO track steps several pixels per sample, and plotting only the
 * sample points would draw a dotted line that reads as sparse data rather than a path.
 */
export function groundTrackImage(track: GroundTrack): GroundTrackImage {
  const width = MAP_WIDTH;
  const height = MAP_HEIGHT;
  const data = new Uint8ClampedArray(new ArrayBuffer(width * height * 4));

  // Background.
  for (let i = 0; i < width * height; i++) {
    const index = i * 4;
    data[index] = BACKGROUND[0];
    data[index + 1] = BACKGROUND[1];
    data[index + 2] = BACKGROUND[2];
    data[index + 3] = 255;
  }

  // Graticule: meridians and parallels, with the equator brighter so the hemispheres read.
  for (const lonDeg of MERIDIAN_DEG) {
    const x = Math.round(((lonDeg + 180) / 360) * width);
    for (let y = 0; y < height; y++) {
      putPixel(data, width, height, x, y, GRATICULE);
    }
  }
  for (const latDeg of PARALLEL_DEG) {
    const y = Math.round(((90 - latDeg) / 180) * height);
    const colour = latDeg === 0 ? EQUATOR : GRATICULE;
    for (let x = 0; x < width; x++) {
      putPixel(data, width, height, x, y, colour);
    }
  }

  // Track.
  const colour = track.belowSurface ? BELOW_SURFACE : TRACK;
  for (const line of trackPolylines(track)) {
    if (line.length === 1) {
      const p = line[0]!;
      putPixel(data, width, height, Math.round(p.x * width), Math.round(p.y * height), colour);
      continue;
    }
    for (let i = 1; i < line.length; i++) {
      drawSegment(data, width, height, line[i - 1]!, line[i]!, colour);
    }
  }

  return { width, height, data };
}

/** Bresenham, so a segment that spans more than a pixel is drawn as a line rather than dots. */
function drawSegment(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  from: MapPoint,
  to: MapPoint,
  colour: readonly [number, number, number],
): void {
  let x0 = Math.round(from.x * width);
  let y0 = Math.round(from.y * height);
  const x1 = Math.round(to.x * width);
  const y1 = Math.round(to.y * height);
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const stepX = x0 < x1 ? 1 : -1;
  const stepY = y0 < y1 ? 1 : -1;
  let error = dx + dy;

  // Bounded by the map diagonal so a malformed input cannot spin forever.
  for (let guard = 0; guard <= width + height; guard++) {
    putPixel(data, width, height, x0, y0, colour);
    if (x0 === x1 && y0 === y1) return;
    const doubled = 2 * error;
    if (doubled >= dy) {
      error += dy;
      x0 += stepX;
    }
    if (doubled <= dx) {
      error += dx;
      y0 += stepY;
    }
  }
}
