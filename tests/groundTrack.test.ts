import { describe, expect, it } from 'vitest';
import {
  buildGroundTrack,
  eclipticToEquatorial,
  equatorialToEarthFixed,
  geocentricFromEarthFixed,
  subSatellitePoint,
} from '../src/core/groundTrack/groundTrack.js';
import { bodyPosition } from '../src/core/ephemeris/ephemeris.js';
import { GM, OBLIQUITY_J2000, RADIUS, SECONDS_PER_DAY } from '../src/core/constants.js';
import { jdFromIsoUtc, jdTtFromJdUtc, gmstRadians } from '../src/core/time/time.js';
import { type Vec3, length, rotateX, rotateZ, vec3 } from '../src/core/math/vec3.js';

const DEG = 180 / Math.PI;
const EPOCH_UTC = jdFromIsoUtc('2026-11-18T12:00:00Z');
const EPOCH_TT = jdTtFromJdUtc(EPOCH_UTC);

/**
 * Heliocentric point for a body-relative offset given in the *equatorial* frame at a UTC
 * Julian date, converted to the ecliptic frame the physics layer stores.
 *
 * Test-only helper. Going through the inverse of the same obliquity rotation is deliberate:
 * the assertions below then check the *identity* the module claims (a round trip), while the
 * absolute-value tests check the rotation against published angles instead.
 */
function helioFromEquatorialOffset(offsetEq: Vec3, jdUtc: number): Vec3 {
  const ecliptic = rotateX(offsetEq, -OBLIQUITY_J2000);
  const earth = bodyPosition('earth', jdTtFromJdUtc(jdUtc));
  return vec3(earth.x + ecliptic.x, earth.y + ecliptic.y, earth.z + ecliptic.z);
}

describe('obliquity: the ecliptic frame is not the equatorial frame', () => {
  it('leaves the vernal equinox on the equator', () => {
    // x is shared by both frames by definition: the equinox lies in both planes.
    const eq = eclipticToEquatorial(vec3(1, 0, 0));
    expect(eq.x).toBeCloseTo(1, 12);
    expect(eq.y).toBeCloseTo(0, 12);
    expect(eq.z).toBeCloseTo(0, 12);
  });

  it('reports the ecliptic north pole at 90 degrees minus the obliquity', () => {
    // The ecliptic pole is tilted from the equatorial pole by exactly the obliquity, so its
    // equatorial latitude is 90 deg - e. 23d26'21.448" -> 66.5607 deg. This is a published
    // astronomical angle, not a number read back off this code.
    const point = geocentricFromEarthFixed(eclipticToEquatorial(vec3(0, 0, 1)))!;
    expect(point.latRad * DEG).toBeCloseTo(90 - OBLIQUITY_J2000 * DEG, 9);
    expect(point.latRad * DEG).toBeCloseTo(66.5607, 3);
  });

  it('reports a point 90 degrees along the ecliptic at +23.44 latitude', () => {
    // ecliptic (0,1,0) rotated by +e about x is (0, cos e, sin e): latitude asin(sin e) = e.
    const point = geocentricFromEarthFixed(eclipticToEquatorial(vec3(0, 1, 0)))!;
    expect(point.latRad).toBeCloseTo(OBLIQUITY_J2000, 12);
    expect(point.latRad * DEG).toBeCloseTo(23.4393, 3);
  });

  it('preserves length', () => {
    const v = vec3(3, -4, 12);
    expect(length(eclipticToEquatorial(v))).toBeCloseTo(length(v), 12);
  });

  it('is the inverse of itself reversed', () => {
    const v = vec3(1.5, -2.25, 0.75);
    const there = rotateX(v, OBLIQUITY_J2000);
    const back = rotateX(there, -OBLIQUITY_J2000);
    expect(back.x).toBeCloseTo(v.x, 12);
    expect(back.y).toBeCloseTo(v.y, 12);
    expect(back.z).toBeCloseTo(v.z, 12);
  });
});

describe('sidereal rotation: equatorial inertial to Earth-fixed', () => {
  it('puts a point at right ascension equal to GMST on the Greenwich meridian', () => {
    // The definition of longitude: lon = RA - GMST. Choosing RA = GMST must give zero.
    const gmst = gmstRadians(EPOCH_UTC);
    const inertial = rotateZ(vec3(1, 0, 0), gmst);
    const fixed = equatorialToEarthFixed(inertial, EPOCH_UTC);
    const point = geocentricFromEarthFixed(fixed)!;
    expect(point.lonRad).toBeCloseTo(0, 12);
  });

  it('holds a geostationary satellite over one longitude for a full sidereal day', () => {
    // Two independent constants agree here: the module rotates by GMST (IAU-1982), the
    // satellite position below rotates at 2*pi/EARTH_SIDEREAL_RATE. If those disagreed, a
    // geostationary craft would drift and this would fail. Tolerance 1e-7 rad ~ 0.6 m at the
    // Earth's surface, far above double rounding and far below any real rate mismatch.
    const geostationaryRadius = Math.cbrt(GM.earth / Math.pow((2 * Math.PI) / 86164.0905, 2));
    const tSidereal = (2 * Math.PI) / ((2 * Math.PI) / 86164.0905);

    let firstLon: number | null = null;
    for (let k = 0; k <= 12; k++) {
      const t = (k / 12) * tSidereal;
      const jdUtc = EPOCH_UTC + t / SECONDS_PER_DAY;
      const angle = (2 * Math.PI * t) / tSidereal;
      const offsetEq = rotateZ(vec3(geostationaryRadius, 0, 0), angle);
      const point = subSatellitePoint(helioFromEquatorialOffset(offsetEq, jdUtc), jdUtc)!;
      expect(point.latRad).toBeCloseTo(0, 12);
      if (firstLon === null) firstLon = point.lonRad;
      else expect(point.lonRad).toBeCloseTo(firstLon, 7);
    }
    expect(firstLon).not.toBeNull();
  });

  it('moves an inertial-fixed point west by one turn per sidereal day', () => {
    // Earth-fixed = inertial turned by -GMST, so a point pinned in inertial space sweeps
    // westward at the sidereal rate. Over one sidereal day it returns to itself.
    const tSidereal = 86164.0905;
    const inertial = vec3(0, 1, 0);
    const start = geocentricFromEarthFixed(equatorialToEarthFixed(inertial, EPOCH_UTC))!.lonRad;
    const end = geocentricFromEarthFixed(
      equatorialToEarthFixed(inertial, EPOCH_UTC + tSidereal / SECONDS_PER_DAY),
    )!.lonRad;
    // Same longitude modulo a turn: wrap the difference into (-pi, pi].
    let delta = end - start;
    while (delta > Math.PI) delta -= 2 * Math.PI;
    while (delta <= -Math.PI) delta += 2 * Math.PI;
    expect(delta).toBeCloseTo(0, 6);
  });
});

describe('geocentric conversion', () => {
  it('answers (0,0) for a point on the +x axis and 90 degrees for one on +y', () => {
    expect(geocentricFromEarthFixed(vec3(1, 0, 0))!.lonRad).toBeCloseTo(0, 15);
    expect(geocentricFromEarthFixed(vec3(0, 1, 0))!.lonRad).toBeCloseTo(Math.PI / 2, 15);
  });

  it('clamps the latitude at the poles instead of returning NaN', () => {
    const north = geocentricFromEarthFixed(vec3(0, 0, 1))!;
    expect(north.latRad).toBeCloseTo(Math.PI / 2, 15);
    const south = geocentricFromEarthFixed(vec3(0, 0, -1))!;
    expect(south.latRad).toBeCloseTo(-Math.PI / 2, 15);
  });

  it('returns null for the zero vector, where lat/lon are undefined', () => {
    expect(geocentricFromEarthFixed(vec3(0, 0, 0))).toBeNull();
  });
});

describe('sub-satellite point', () => {
  it('returns null for a craft exactly at the Earth centre at that sample time', () => {
    // The subtraction must use the Earth's position at the sample's *own* time. If it used
    // the epoch position, a craft sitting at the Earth's centre an hour later would report a
    // large, plausible, wrong offset instead of "undefined".
    const laterJdUtc = EPOCH_UTC + 3600 / SECONDS_PER_DAY;
    const atEarth = bodyPosition('earth', jdTtFromJdUtc(laterJdUtc));
    expect(subSatellitePoint(atEarth, laterJdUtc)).toBeNull();
  });

  it('gives a circular equatorial orbit a constant latitude and one turn of longitude', () => {
    // A satellite in the true equatorial plane must stay at latitude 0 for the whole orbit.
    // Its geocentric latitude in this model is 0 only because the obliquity rotation is
    // applied; without it, the ecliptic-stored orbit would read up to ±23.4 deg.
    const radius = RADIUS.earth + 550e3;
    const period = 2 * Math.PI * Math.sqrt(radius ** 3 / GM.earth);
    for (let k = 0; k <= 8; k++) {
      const t = (k / 8) * period;
      const jdUtc = EPOCH_UTC + t / SECONDS_PER_DAY;
      const offsetEq = rotateZ(vec3(radius, 0, 0), (2 * Math.PI * t) / period);
      const point = subSatellitePoint(helioFromEquatorialOffset(offsetEq, jdUtc), jdUtc)!;
      expect(point.latRad).toBeCloseTo(0, 12);
      expect(point.radiusM).toBeCloseTo(radius, 3);
    }
  });
});

describe('buildGroundTrack', () => {
  const oneHour = 3600;

  function samplesOver(seconds: number, step: number, offsetEq: (t: number) => Vec3) {
    const out = [];
    for (let t = 0; t <= seconds; t += step) {
      const jdUtc = EPOCH_UTC + t / SECONDS_PER_DAY;
      out.push({ r: helioFromEquatorialOffset(offsetEq(t), jdUtc), timeSeconds: t });
    }
    return out;
  }

  it('reports altitude above the mean equatorial radius', () => {
    const radius = RADIUS.earth + 400e3;
    const track = buildGroundTrack(
      samplesOver(oneHour, 600, () => vec3(radius, 0, 0)),
      { epochJdUtc: EPOCH_UTC },
    );
    for (const s of track.samples) expect(s.altitudeM).toBeCloseTo(400e3, 3);
    expect(track.minAltitudeM).toBeCloseTo(400e3, 3);
    expect(track.maxAltitudeM).toBeCloseTo(400e3, 3);
    expect(track.belowSurface).toBe(false);
  });

  it('flags a craft inside the body', () => {
    const track = buildGroundTrack(
      [{ r: helioFromEquatorialOffset(vec3(RADIUS.earth * 0.5, 0, 0), EPOCH_UTC), timeSeconds: 0 }],
      {
        epochJdUtc: EPOCH_UTC,
      },
    );
    expect(track.belowSurface).toBe(true);
    expect(track.minAltitudeM!).toBeLessThan(0);
  });

  it('breaks the track at the antimeridian exactly once per westward sweep', () => {
    // Hold the craft fixed in inertial space; the Earth turns underneath it, so longitude
    // sweeps west and wraps through +-180. The flag must fire at the wrap and only there,
    // otherwise a renderer draws a line across the whole map.
    //
    // The start phase is chosen, not incidental: a sweep only crosses +-180 if its arc
    // contains that meridian. Starting at longitude +170 deg and sweeping one full day
    // (360.99 deg) passes -180 once, at 350 deg into the sweep, and ends just past +170
    // without a second crossing. A shorter span stops short of the meridian: 0.9 day is
    // only 324.9 deg, which is 25 deg shy of the 350 deg needed from +170.
    const radius = RADIUS.earth + 500e3;
    const span = 1.0 * SECONDS_PER_DAY;
    const step = span / 120;
    const startRa = gmstRadians(EPOCH_UTC) + (170 * Math.PI) / 180;
    const track = buildGroundTrack(
      samplesOver(span, step, () => rotateZ(vec3(radius, 0, 0), startRa)),
      { epochJdUtc: EPOCH_UTC },
    );
    expect(track.samples[0]!.lonRad * DEG).toBeCloseTo(170, 6);

    const crossings = track.samples.filter((s) => s.crossesAntimeridian);
    expect(crossings).toHaveLength(1);
    expect(track.samples[0]!.crossesAntimeridian).toBe(false);

    // The crossing is a real wrap: the two longitudes straddle +-pi.
    const idx = track.samples.indexOf(crossings[0]!);
    const before = track.samples[idx - 1]!;
    expect(Math.abs(crossings[0]!.lonRad - before.lonRad)).toBeGreaterThan(Math.PI);
  });

  it('counts an undefined point without emitting a sample or joining across it', () => {
    const radius = RADIUS.earth + 500e3;
    const points = samplesOver(1800, 600, () => vec3(radius, 0, 0));
    // Replace the middle sample with a craft sitting at the Earth's centre.
    const midJd = EPOCH_UTC + 600 / SECONDS_PER_DAY;
    points[1] = { r: bodyPosition('earth', jdTtFromJdUtc(midJd)), timeSeconds: 600 };

    const track = buildGroundTrack(points, { epochJdUtc: EPOCH_UTC });
    expect(track.undefinedPoints).toBe(1);
    // Four input samples, one undefined: three survive, and they are not contiguous.
    expect(track.samples).toHaveLength(3);
    expect(track.samples.map((s) => s.timeSeconds)).toEqual([0, 1200, 1800]);
    // The middle sample is gone, so the sample after the gap must not join across it: the
    // undefined point cleared the previous longitude, and no crossing may be claimed.
    expect(track.samples[1]!.crossesAntimeridian).toBe(false);
    expect(track.samples[2]!.crossesAntimeridian).toBe(false);
  });

  it('keeps sample times in input order from the epoch', () => {
    const radius = RADIUS.earth + 500e3;
    const track = buildGroundTrack(
      samplesOver(1800, 300, () => vec3(radius, 0, 0)),
      {
        epochJdUtc: EPOCH_UTC,
      },
    );
    expect(track.samples.map((s) => s.timeSeconds)).toEqual([0, 300, 600, 900, 1200, 1500, 1800]);
    expect(track.epochJdUtc).toBe(EPOCH_UTC);
    // jdUtc is derived from the epoch and the sample time, not carried in the input.
    expect(track.samples[3]!.jdUtc).toBeCloseTo(EPOCH_UTC + 900 / SECONDS_PER_DAY, 12);
  });

  it('rejects a non-finite epoch rather than producing a track of NaNs', () => {
    expect(() => buildGroundTrack([], { epochJdUtc: Number.NaN })).toThrow(/epoch/);
  });

  it('handles an empty input', () => {
    const track = buildGroundTrack([], { epochJdUtc: EPOCH_UTC });
    expect(track.samples).toHaveLength(0);
    expect(track.minAltitudeM).toBeNull();
    expect(track.maxAltitudeM).toBeNull();
  });
});

// Keep the TT/JD helpers referenced so an unused-import regression is visible here.
void EPOCH_TT;
