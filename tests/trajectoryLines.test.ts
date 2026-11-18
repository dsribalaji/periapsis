import { describe, expect, it } from 'vitest';
import {
  toLocalFrame,
  pointAtTime,
  flownSegmentCount,
  DEFAULT_ENVELOPE_UNITS,
  type LocalFramePoint,
} from '../src/render/trajectoryLines.js';
import { displayRadiusFor } from '../src/render/scale.js';
import { BODIES } from '../src/core/ephemeris/solarSystem.js';
import { bodyPosition } from '../src/core/ephemeris/ephemeris.js';
import { jdFromIsoUtc, jdTtFromJdUtc } from '../src/core/time/time.js';
import type { Vec3 } from '../src/core/math/vec3.js';

const EPOCH_TT = jdTtFromJdUtc(jdFromIsoUtc('2026-11-18T12:00:00Z'));
const R_EARTH = BODIES.earth.radius;
const DRAWN_EARTH = displayRadiusFor('earth', R_EARTH);

/** Heliocentric points from Earth-relative offsets, taken at the epoch. */
function pointsFromOffsets(offsets: readonly { r: Vec3; t: number }[]): LocalFramePoint[] {
  return offsets.map(({ r, t }) => {
    const body = bodyPosition('earth', EPOCH_TT);
    return { r: { x: body.x + r.x, y: body.y + r.y, z: body.z + r.z }, timeSeconds: t };
  });
}

/** The drawable point at an index, from the dense per-point buffer. */
function pointAt(result: { points: Float32Array }, index: number) {
  const o = index * 3;
  return { x: result.points[o]!, y: result.points[o + 1]!, z: result.points[o + 2]! };
}

describe('local frame for a trajectory', () => {
  it('puts a point one Earth radius out at the drawn Earth radius', () => {
    const result = toLocalFrame(pointsFromOffsets([{ r: { x: R_EARTH, y: 0, z: 0 }, t: 0 }]), {
      centralBody: 'earth',
      epochJdTt: EPOCH_TT,
    });
    const p = pointAt(result, 0);
    expect(p.x).toBeCloseTo(DRAWN_EARTH, 6);
    expect(p.y).toBeCloseTo(0, 6);
    expect(p.z).toBeCloseTo(0, 6);
  });

  it('keeps the scene frame convention for offsets', () => {
    // Physics +z is ecliptic north and must become scene +y; physics +y becomes scene -z.
    const result = toLocalFrame(
      pointsFromOffsets([{ r: { x: 0, y: R_EARTH, z: R_EARTH }, t: 0 }]),
      { centralBody: 'earth', epochJdTt: EPOCH_TT },
    );
    const p = pointAt(result, 0);
    expect(p.x).toBeCloseTo(0, 6);
    expect(p.y).toBeCloseTo(DRAWN_EARTH, 6);
    expect(p.z).toBeCloseTo(-DRAWN_EARTH, 6);
  });

  it('places a 400 km orbit outside the drawn surface', () => {
    const result = toLocalFrame(
      pointsFromOffsets([{ r: { x: R_EARTH + 400e3, y: 0, z: 0 }, t: 0 }]),
      { centralBody: 'earth', epochJdTt: EPOCH_TT },
    );
    const p = pointAt(result, 0);
    const radius = Math.hypot(p.x, p.y, p.z);
    expect(radius).toBeGreaterThan(DRAWN_EARTH);
    // Only just: 400 km on a 6371 km body is 6% of a radius.
    expect(radius).toBeLessThan(DRAWN_EARTH * 1.1);
  });

  it('preserves the ratio between two orbital radii', () => {
    const leo = R_EARTH + 400e3;
    const geo = 42164e3;
    const result = toLocalFrame(
      pointsFromOffsets([
        { r: { x: leo, y: 0, z: 0 }, t: 0 },
        { r: { x: geo, y: 0, z: 0 }, t: 60 },
      ]),
      { centralBody: 'earth', epochJdTt: EPOCH_TT },
    );
    const one = pointAt(result, 0);
    const two = pointAt(result, 1);
    expect(Math.hypot(two.x, two.y, two.z) / Math.hypot(one.x, one.y, one.z)).toBeCloseTo(
      geo / leo,
      6,
    );
  });

  it('emits one segment for two points, six floats', () => {
    const result = toLocalFrame(
      pointsFromOffsets([
        { r: { x: R_EARTH * 2, y: 0, z: 0 }, t: 0 },
        { r: { x: 0, y: R_EARTH * 2, z: 0 }, t: 60 },
      ]),
      { centralBody: 'earth', epochJdTt: EPOCH_TT },
    );
    expect(result.positions.length).toBe(6);
    expect(result.segmentTimes.length).toBe(1);
    expect(Array.from(result.segmentTimes)).toEqual([60]);
  });

  it('emits no segment for a single point but still reports the point and extent', () => {
    const result = toLocalFrame(pointsFromOffsets([{ r: { x: R_EARTH * 2, y: 0, z: 0 }, t: 0 }]), {
      centralBody: 'earth',
      epochJdTt: EPOCH_TT,
    });
    expect(result.positions.length).toBe(0);
    expect(result.points.length).toBe(3);
    expect(result.extentUnits).toBeGreaterThan(0);
  });

  it('reports the furthest point drawn as the extent', () => {
    const result = toLocalFrame(
      pointsFromOffsets([
        { r: { x: R_EARTH * 2, y: 0, z: 0 }, t: 0 },
        { r: { x: R_EARTH * 5, y: 0, z: 0 }, t: 60 },
        { r: { x: R_EARTH * 3, y: 0, z: 0 }, t: 120 },
      ]),
      { centralBody: 'earth', epochJdTt: EPOCH_TT },
    );
    expect(result.extentUnits).toBeCloseTo(DRAWN_EARTH * 5, 6);
  });

  it('drops points beyond the envelope and counts them', () => {
    const envelope = DRAWN_EARTH * 4;
    const result = toLocalFrame(
      pointsFromOffsets([
        { r: { x: R_EARTH * 2, y: 0, z: 0 }, t: 0 },
        { r: { x: R_EARTH * 10, y: 0, z: 0 }, t: 60 },
        { r: { x: R_EARTH * 3, y: 0, z: 0 }, t: 120 },
      ]),
      { centralBody: 'earth', epochJdTt: EPOCH_TT, envelopeUnits: envelope },
    );
    expect(result.clippedPoints).toBe(1);
    // Both remaining points survive as isolated points, but no segment joins them.
    expect(result.points.length).toBe(6);
    expect(result.positions.length).toBe(0);
    expect(result.runs).toBe(2);
  });

  it('keeps the runs either side of a clip apart rather than joining them', () => {
    const envelope = DRAWN_EARTH * 4;
    const result = toLocalFrame(
      pointsFromOffsets([
        { r: { x: R_EARTH * 2, y: 0, z: 0 }, t: 0 },
        { r: { x: R_EARTH * 2.5, y: 0, z: 0 }, t: 60 },
        { r: { x: R_EARTH * 10, y: 0, z: 0 }, t: 120 },
        { r: { x: R_EARTH * 3, y: 0, z: 0 }, t: 180 },
        { r: { x: R_EARTH * 3.5, y: 0, z: 0 }, t: 240 },
      ]),
      { centralBody: 'earth', epochJdTt: EPOCH_TT, envelopeUnits: envelope },
    );
    // One segment before the clip and one after: two in total, and no pair spanning it.
    expect(result.positions.length).toBe(2 * 6);
    expect(result.clippedPoints).toBe(1);
    expect(result.runs).toBe(2);
  });

  it('keeps segment times ascending so flown is always a prefix', () => {
    const result = toLocalFrame(
      pointsFromOffsets([
        { r: { x: R_EARTH * 2, y: 0, z: 0 }, t: 0 },
        { r: { x: R_EARTH * 2.1, y: 0, z: 0 }, t: 60 },
        { r: { x: R_EARTH * 2.2, y: 0, z: 0 }, t: 120 },
      ]),
      { centralBody: 'earth', epochJdTt: EPOCH_TT },
    );
    expect(Array.from(result.segmentTimes)).toEqual([60, 120]);
  });

  it('works for a body other than Earth, with its own exaggeration', () => {
    const rJupiter = BODIES.jupiter.radius;
    const body = bodyPosition('jupiter', EPOCH_TT);
    const result = toLocalFrame(
      [{ r: { x: body.x + rJupiter, y: body.y, z: body.z }, timeSeconds: 0 }],
      { centralBody: 'jupiter', epochJdTt: EPOCH_TT },
    );
    expect(pointAt(result, 0).x).toBeCloseTo(displayRadiusFor('jupiter', rJupiter), 6);
  });

  it('returns an empty result for no points', () => {
    const result = toLocalFrame([], { centralBody: 'earth', epochJdTt: EPOCH_TT });
    expect(result.positions.length).toBe(0);
    expect(result.points.length).toBe(0);
    expect(result.runs).toBe(0);
    expect(result.extentUnits).toBe(0);
  });

  it('rejects a non-positive envelope', () => {
    expect(() =>
      toLocalFrame([], { centralBody: 'earth', epochJdTt: EPOCH_TT, envelopeUnits: 0 }),
    ).toThrow(/envelope must be positive/);
  });

  it('has an envelope that reaches past the Moon', () => {
    // 384,400 km from Earth is about 60 drawn Earth radii; the default envelope is 2000
    // units, so a lunar trajectory is drawn rather than silently clipped.
    const sceneRadius = (384400e3 / R_EARTH) * DRAWN_EARTH;
    expect(sceneRadius).toBeLessThan(DEFAULT_ENVELOPE_UNITS);
  });
});

describe('position along a trajectory', () => {
  const result = toLocalFrame(
    pointsFromOffsets([
      { r: { x: R_EARTH * 2, y: 0, z: 0 }, t: 0 },
      { r: { x: R_EARTH * 4, y: 0, z: 0 }, t: 100 },
    ]),
    { centralBody: 'earth', epochJdTt: EPOCH_TT },
  );

  it('returns the exact sample at a sample time', () => {
    const p = pointAtTime(result.points, result.pointTimes, 0)!;
    expect(p.x).toBeCloseTo(DRAWN_EARTH * 2, 6);
  });

  it('interpolates halfway between samples', () => {
    const p = pointAtTime(result.points, result.pointTimes, 50)!;
    // Halfway between 2 and 4 drawn radii.
    expect(p.x).toBeCloseTo(DRAWN_EARTH * 3, 6);
  });

  it('clamps before the start and after the end instead of vanishing', () => {
    const before = pointAtTime(result.points, result.pointTimes, -500)!;
    const after = pointAtTime(result.points, result.pointTimes, 1e6)!;
    expect(before.x).toBeCloseTo(DRAWN_EARTH * 2, 6);
    expect(after.x).toBeCloseTo(DRAWN_EARTH * 4, 6);
  });

  it('returns null when nothing was drawn', () => {
    expect(pointAtTime(new Float32Array(), new Float32Array(), 0)).toBeNull();
  });
});

describe('flown prefix', () => {
  const times = Float32Array.from([60, 120, 180]);

  it('counts every segment ending at or before the time', () => {
    expect(flownSegmentCount(times, 0)).toBe(0);
    expect(flownSegmentCount(times, 60)).toBe(1);
    expect(flownSegmentCount(times, 119)).toBe(1);
    expect(flownSegmentCount(times, 120)).toBe(2);
    expect(flownSegmentCount(times, 1e9)).toBe(3);
  });

  it('is zero for an empty path', () => {
    expect(flownSegmentCount(new Float32Array(), 100)).toBe(0);
  });
});
