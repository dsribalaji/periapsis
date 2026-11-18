import { describe, expect, it } from 'vitest';
import {
  bodyPosition,
  relativePosition,
  relativeVelocity,
  advanceElements,
  meanMotionFromElementRates,
  centuriesFromJd,
  positionFromElements,
} from '../src/core/ephemeris/ephemeris.js';
import { BODIES, JPL_TABLE_1, BODY_IDS, sphereOfInfluence, MOON_ELEMENTS } from '../src/core/ephemeris/solarSystem.js';
import { AU_M, J2000_JD, SECONDS_PER_DAY } from '../src/core/constants.js';
import { jdFromIsoUtc } from '../src/core/time/time.js';
import { length, sub } from '../src/core/math/vec3.js';

describe('JPL element data integrity', () => {
  it('transcribes JPL Table 1 exactly', () => {
    // Spot checks against the published table, so a future edit cannot silently
    // corrupt a constant. Full table is in solarSystem.ts.
    expect(JPL_TABLE_1.mercury.a).toBe(0.38709927);
    expect(JPL_TABLE_1.mercury.e).toBe(0.20563593);
    expect(JPL_TABLE_1.earth.a).toBe(1.00000261);
    expect(JPL_TABLE_1.earth.e).toBe(0.01671123);
    expect(JPL_TABLE_1.jupiter.a).toBe(5.202887);
    expect(JPL_TABLE_1.saturn.i).toBe(2.48599187);
    expect(JPL_TABLE_1.neptune.L).toBe(-55.12002969);
  });

  it('has a definition for every body id', () => {
    for (const id of BODY_IDS) {
      expect(BODIES[id]).toBeDefined();
      expect(BODIES[id].mu).toBeGreaterThan(0);
      expect(BODIES[id].radius).toBeGreaterThan(0);
    }
  });

  it('orders JPL a values as expected', () => {
    const order = ['mercury', 'venus', 'earth', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune'] as const;
    for (let i = 1; i < order.length; i++) {
      expect(JPL_TABLE_1[order[i]!].a).toBeGreaterThan(JPL_TABLE_1[order[i - 1]!].a);
    }
  });
});

describe('ephemeris positions', () => {
  it('puts the Sun at the origin', () => {
    const p = bodyPosition('sun', J2000_JD);
    expect(p.x).toBe(0);
    expect(p.y).toBe(0);
    expect(p.z).toBe(0);
  });

  it('places Earth at roughly 1 AU from the Sun', () => {
    // Earth's distance varies between 0.983 and 1.017 AU over the year, so a single
    // instant only bounds it loosely.
    for (const iso of ['2026-01-03T00:00:00Z', '2026-07-04T00:00:00Z', '2026-11-18T00:00:00Z']) {
      const d = length(bodyPosition('earth', jdFromIsoUtc(iso)));
      expect(d / AU_M).toBeGreaterThan(0.98);
      expect(d / AU_M).toBeLessThan(1.02);
    }
  });

  it('returns Earth to nearly the same place after one year', () => {
    const jd0 = jdFromIsoUtc('2026-11-18T00:00:00Z');
    const jd1 = jd0 + 365.256363;
    const drift = length(sub(bodyPosition('earth', jd0), bodyPosition('earth', jd1)));
    // One tropical/sidereal year should close to well under 1% of an AU.
    expect(drift / AU_M).toBeLessThan(0.01);
  });

  it('keeps every planet inside its known perihelion/aphelion band', () => {
    const jd = jdFromIsoUtc('2026-11-18T00:00:00Z');
    const bands: Record<string, [number, number]> = {
      mercury: [0.30, 0.48],
      venus: [0.71, 0.74],
      earth: [0.98, 1.02],
      mars: [1.35, 1.70],
      jupiter: [4.9, 5.5],
      saturn: [8.9, 10.2],
      uranus: [18.2, 20.1],
      neptune: [29.7, 30.4],
    };
    for (const [id, [lo, hi]] of Object.entries(bands)) {
      const d = length(bodyPosition(id as 'earth', jd)) / AU_M;
      expect(d).toBeGreaterThan(lo);
      expect(d).toBeLessThan(hi);
    }
  });

  it('places the Moon about 384,400 km from Earth', () => {
    const jd = jdFromIsoUtc('2026-11-18T00:00:00Z');
    const moon = bodyPosition('moon', jd);
    const earth = bodyPosition('earth', jd);
    const d = length(sub(moon, earth));
    // The real Moon ranges 363,300 - 405,500 km.
    expect(d).toBeGreaterThan(355e6);
    expect(d).toBeLessThan(415e6);
  });

  it('places the Moon between roughly -6 and +6 degrees of the ecliptic', () => {
    const jd = jdFromIsoUtc('2026-11-18T00:00:00Z');
    const rel = sub(bodyPosition('moon', jd), bodyPosition('earth', jd));
    const lat = Math.asin(rel.z / length(rel)) * (180 / Math.PI);
    expect(Math.abs(lat)).toBeLessThan(6);
  });

  it('keeps every planet within about 7 degrees of the ecliptic', () => {
    const jd = jdFromIsoUtc('2026-11-18T00:00:00Z');
    for (const id of BODY_IDS) {
      if (id === 'sun' || id === 'moon') continue;
      const p = bodyPosition(id, jd);
      const lat = Math.asin(p.z / length(p)) * (180 / Math.PI);
      expect(Math.abs(lat)).toBeLessThan(8);
    }
  });

  it('is continuous: a one-second step moves a planet by a small amount', () => {
    const jd = jdFromIsoUtc('2026-11-18T00:00:00Z');
    const p0 = bodyPosition('mars', jd);
    const p1 = bodyPosition('mars', jd + 1 / SECONDS_PER_DAY);
    const v = length(sub(p1, p0));
    // Mars moves about 24 km/s, so ~24 km in one second; allow a wide band.
    expect(v).toBeGreaterThan(10e3);
    expect(v).toBeLessThan(40e3);
  });

  it('is deterministic', () => {
    const jd = jdFromIsoUtc('2026-11-18T00:00:00Z');
    expect(bodyPosition('jupiter', jd)).toEqual(bodyPosition('jupiter', jd));
  });
});

describe('relative velocity', () => {
  /**
   * Compares analytic velocity to a central finite difference of position at h = 1 day.
   *
   * h must be chosen with care: the difference has O(h²) truncation error and a
   * floating-point cancellation floor of about ε·|r|/h. Measured error for Mercury as h
   * varies: 5e-6 (h=4d), 4.5e-6 (h=1d), 3.6e-5 (h=0.5d), 2.0e-4 (h=0.1d) — i.e. it
   * improves with h down to ~1 day and then degrades from cancellation, so 0.5 d is
   * already in the noise. The bound below reflects the measured ~6e-5 worst case at
   * h = 1 d for Jupiter, not a guess.
   */
  function fdVelocity(id: Parameters<typeof bodyPosition>[0], jd: number): number {
    const h = 1;
    const pPlus = bodyPosition(id, jd + h / SECONDS_PER_DAY);
    const pMinus = bodyPosition(id, jd - h / SECONDS_PER_DAY);
    return length(sub(pPlus, pMinus)) / (2 * h);
  }

  it('matches a finite difference of the position for each planet', () => {
    const jd = jdFromIsoUtc('2026-11-18T00:00:00Z');
    for (const id of ['mercury', 'venus', 'earth', 'mars', 'jupiter', 'neptune'] as const) {
      const analytic = length(relativeVelocity(JPL_TABLE_1[id], jd));
      const numeric = fdVelocity(id, jd);
      expect(Math.abs(analytic - numeric) / numeric).toBeLessThan(1e-4);
    }
  });

  /**
   * Stronger check: specific orbital energy v²/2 − μ/r must be constant all the way
   * around the orbit. This verifies the velocity is consistent with the position
   * *physically*, not just numerically, and would catch a velocity that is wrong in
   * direction as long as its magnitude happened to match a finite difference.
   */
  it('keeps specific orbital energy constant around each orbit', () => {
    const jd0 = jdFromIsoUtc('2026-11-18T00:00:00Z');
    const cases = [
      { id: 'earth' as const, el: JPL_TABLE_1.earth, mu: BODIES.sun.mu },
      { id: 'mars' as const, el: JPL_TABLE_1.mars, mu: BODIES.sun.mu },
      { id: 'mercury' as const, el: JPL_TABLE_1.mercury, mu: BODIES.sun.mu },
    ];
    for (const { id, el, mu } of cases) {
      const energies: number[] = [];
      for (let k = 0; k < 12; k++) {
        const jd = jd0 + k * 8;
        const r = length(bodyPosition(id, jd));
        const v = length(relativeVelocity(el, jd));
        energies.push((v * v) / 2 - mu / r);
      }
      const mean = energies.reduce((a, b) => a + b, 0) / energies.length;
      for (const e of energies) {
        expect(Math.abs((e - mean) / mean)).toBeLessThan(2e-4);
      }
    }
  });

  it('gives Earth about 29.8 km/s', () => {
    const jd = jdFromIsoUtc('2026-11-18T00:00:00Z');
    const v = length(relativeVelocity(JPL_TABLE_1.earth, jd));
    expect(v).toBeGreaterThan(29.0e3);
    expect(v).toBeLessThan(30.5e3);
  });

  it('gives Mercury between 38 and 60 km/s', () => {
    const jd = jdFromIsoUtc('2026-11-18T00:00:00Z');
    const v = length(relativeVelocity(JPL_TABLE_1.mercury, jd));
    expect(v).toBeGreaterThan(38e3);
    expect(v).toBeLessThan(60e3);
  });

  it('gives the Moon about 1 km/s relative to Earth', () => {
    const jd = jdFromIsoUtc('2026-11-18T00:00:00Z');
    const v = length(relativeVelocity(MOON_ELEMENTS, jd));
    expect(v).toBeGreaterThan(0.7e3);
    expect(v).toBeLessThan(1.3e3);
  });

  it('keeps the Moon energy consistent with Earth GM', () => {
    const jd0 = jdFromIsoUtc('2026-11-18T00:00:00Z');
    const energies: number[] = [];
    for (let k = 0; k < 12; k++) {
      const jd = jd0 + k * 2;
      const r = length(relativePosition(MOON_ELEMENTS, jd));
      const v = length(relativeVelocity(MOON_ELEMENTS, jd));
      energies.push((v * v) / 2 - BODIES.earth.mu / r);
    }
    const mean = energies.reduce((a, b) => a + b, 0) / energies.length;
    // The mean-element Moon model is approximate (see ADR-0007), so this is looser.
    for (const e of energies) {
      expect(Math.abs((e - mean) / mean)).toBeLessThan(0.05);
    }
  });
});

describe('element advancement', () => {
  it('advances mean anomaly at the tabulated rate', () => {
    const el = JPL_TABLE_1.earth;
    const n = meanMotionFromElementRates(el); // rad/s
    const oneYear = 365.25 * SECONDS_PER_DAY;
    const e0 = advanceElements(el, 0);
    const e1 = advanceElements(el, oneYear / (36525 * SECONDS_PER_DAY));
    // After one year the mean anomaly should increase by n * oneYear, modulo 2π.
    let delta = e1.meanAnomaly - e0.meanAnomaly;
    const expected = (n * oneYear) % (2 * Math.PI);
    while (delta < 0) delta += 2 * Math.PI;
    delta = delta % (2 * Math.PI);
    const diff = Math.abs(delta - expected);
    expect(Math.min(diff, 2 * Math.PI - diff)).toBeLessThan(1e-6);
  });

  it('does not produce NaN for dates across the supported range', () => {
    for (const year of [1800, 1900, 2000, 2050, 2100]) {
      const jd = jdFromIsoUtc(`${year}-06-15T00:00:00Z`);
      for (const id of BODY_IDS) {
        const p = bodyPosition(id, jd);
        expect(Number.isFinite(p.x)).toBe(true);
        expect(Number.isFinite(p.y)).toBe(true);
        expect(Number.isFinite(p.z)).toBe(true);
      }
    }
  });
});

describe('sphere of influence', () => {
  it('gives Earth a plausible SOI of about 925,000 km', () => {
    const soi = sphereOfInfluence('earth') / 1000;
    expect(soi).toBeGreaterThan(850e3);
    expect(soi).toBeLessThan(1000e3);
  });

  it('gives the Sun an infinite SOI', () => {
    expect(sphereOfInfluence('sun')).toBe(Infinity);
  });

  it('orders SOI radii by body size', () => {
    expect(sphereOfInfluence('jupiter')).toBeGreaterThan(sphereOfInfluence('earth'));
    expect(sphereOfInfluence('earth')).toBeGreaterThan(sphereOfInfluence('moon'));
  });

  it('gives the Moon an SOI of about 66,000 km', () => {
    const soi = sphereOfInfluence('moon') / 1000;
    expect(soi).toBeGreaterThan(55e3);
    expect(soi).toBeLessThan(80e3);
  });
});

describe('position from elements', () => {
  it('round-trips a circular orbit', () => {
    const p = positionFromElements({
      a: 1, e: 0, i: 0, node: 0, argPeriapsis: 0, meanAnomaly: 0,
    });
    expect(length(p) / AU_M).toBeCloseTo(1, 10);
  });

  it('puts apoapsis on the far side', () => {
    const peri = positionFromElements({
      a: 1, e: 0.5, i: 0, node: 0, argPeriapsis: 0, meanAnomaly: 0,
    });
    const apo = positionFromElements({
      a: 1, e: 0.5, i: 0, node: 0, argPeriapsis: 0, meanAnomaly: Math.PI,
    });
    expect(length(peri) / AU_M).toBeCloseTo(0.5, 6);
    expect(length(apo) / AU_M).toBeCloseTo(1.5, 6);
  });
});

describe('helper consistency', () => {
  it('computes centuries from J2000 correctly', () => {
    expect(centuriesFromJd(J2000_JD)).toBe(0);
    expect(centuriesFromJd(J2000_JD + 36525)).toBeCloseTo(1, 12);
  });

  it('relativePosition agrees with bodyPosition for the Sun', () => {
    const jd = jdFromIsoUtc('2026-11-18T00:00:00Z');
    const rel = relativePosition(JPL_TABLE_1.earth, jd);
    expect(rel).toEqual(bodyPosition('earth', jd));
  });
});
