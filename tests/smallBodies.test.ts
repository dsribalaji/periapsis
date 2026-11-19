import { describe, expect, it } from 'vitest';
import {
  SMALL_BODIES,
  apsidesAu,
  epochAgeYears,
  smallBodyById,
  smallBodyOrbit,
  smallBodyPeriodDays,
  smallBodyPosition,
} from '../src/core/ephemeris/smallBodies.js';
import { bodyPosition } from '../src/core/ephemeris/ephemeris.js';
import { AU_M } from '../src/core/constants.js';
import { jdFromIsoUtc, jdTtFromJdUtc } from '../src/core/time/time.js';

const jd = (iso: string) => jdTtFromJdUtc(jdFromIsoUtc(iso));
const au = (v: { x: number; y: number; z: number }) => Math.hypot(v.x, v.y, v.z) / AU_M;
const body = (id: string) => {
  const b = smallBodyById(id);
  if (!b) throw new Error(`no ${id}`);
  return b;
};

describe('small-body catalogue', () => {
  it('has unique ids and only elliptic orbits', () => {
    const ids = SMALL_BODIES.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const b of SMALL_BODIES) {
      expect(b.e, b.id).toBeGreaterThanOrEqual(0);
      expect(b.e, b.id).toBeLessThan(1);
      expect(b.a, b.id).toBeGreaterThan(0);
    }
  });

  it("agrees with Kepler's third law to within the data's own rounding", () => {
    // n and a are fitted independently by JPL; for a heliocentric orbit n = 0.9856 / a^1.5
    // deg/day (the Gaussian constant). Agreement to 0.1% says the fields were not mixed up.
    for (const b of SMALL_BODIES) {
      expect(b.meanMotion / (0.98560767 / b.a ** 1.5), b.id).toBeCloseTo(1, 3);
    }
  });

  it('reproduces the element epoch: distance there lies between perihelion and aphelion', () => {
    for (const b of SMALL_BODIES) {
      const r = au(smallBodyPosition(b, b.epochJdTdb));
      const { q, Q } = apsidesAu(b);
      expect(r, b.id).toBeGreaterThanOrEqual(q * (1 - 1e-9));
      expect(r, b.id).toBeLessThanOrEqual(Q * (1 + 1e-9));
    }
  });

  it('closes each drawn orbit and keeps it between the apsides', () => {
    const b = body('halley');
    const path = smallBodyOrbit(b, 512);
    const { q, Q } = apsidesAu(b);
    const radii = path.map(au);
    expect(Math.min(...radii)).toBeCloseTo(q, 6);
    expect(Math.max(...radii)).toBeCloseTo(Q, 3);
    const first = path[0]!;
    const last = path[512]!;
    expect(Math.hypot(first.x - last.x, first.y - last.y, first.z - last.z)).toBeLessThan(1);
  });
});

/**
 * Real events, as independent checks on the whole chain (elements, Kepler solve, frame
 * rotation). Two-body propagation ignores perturbations, so each tolerance is set from how far
 * the event is from the element epoch, and says so.
 */
describe('small bodies against real events', () => {
  it('puts Apophis near Earth at its 13 April 2029 flyby', () => {
    // Real miss distance: 38,000 km from Earth's centre. Two-body heliocentric propagation
    // ignores Earth's own pull during the approach, which bends the path by tens of thousands
    // of km in the final days; 0.01 AU (1.5 million km) is a coarse but honest bound that a
    // wrong node, inclination or frame would miss by a factor of ten or more.
    const t = jd('2029-04-13T21:46:00Z');
    const a = smallBodyPosition(body('apophis'), t);
    const e = bodyPosition('earth', t);
    const d = Math.hypot(a.x - e.x, a.y - e.y, a.z - e.z) / AU_M;
    expect(d).toBeLessThan(0.01);
  });

  it('puts Halley at perihelion on 9 February 1986', () => {
    // The element set is fitted around the 1986 apparition, so this is close to its epoch.
    const b = body('halley');
    const r = au(smallBodyPosition(b, jd('1986-02-09T11:00:00Z')));
    expect(r).toBeCloseTo(apsidesAu(b).q, 2);
  });

  it('puts Pluto at perihelion in September 1989', () => {
    // Pluto's elements are from 2016; 27 years back over a 248-year orbit, so a few hundredths
    // of an AU of drift is expected. Perihelion distance is 29.66 AU.
    const r = au(smallBodyPosition(body('pluto'), jd('1989-09-05T00:00:00Z')));
    expect(r).toBeGreaterThan(29.5);
    expect(r).toBeLessThan(29.8);
  });

  it('gives Halley a 75-to-76-year period and Ceres a 4.6-year one', () => {
    expect(smallBodyPeriodDays(body('halley')) / 365.25).toBeGreaterThan(75);
    expect(smallBodyPeriodDays(body('halley')) / 365.25).toBeLessThan(77);
    expect(smallBodyPeriodDays(body('ceres')) / 365.25).toBeCloseTo(4.6, 1);
  });

  it('measures how far a date is from the element epoch', () => {
    const b = body('ceres');
    expect(epochAgeYears(b, b.epochJdTdb)).toBe(0);
    expect(epochAgeYears(b, b.epochJdTdb + 365.25)).toBeCloseTo(1, 12);
  });
});
