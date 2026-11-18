import { describe, expect, it } from 'vitest';
import {
  acceleration,
  makeForceFunction,
  dominantBody,
  containingSoi,
  relativeState,
  altitudeAbove,
  jdFromSeconds,
  ALL_BODIES,
} from '../src/core/ephemeris/nbody.js';
import { bodyPosition } from '../src/core/ephemeris/ephemeris.js';
import { BODIES } from '../src/core/ephemeris/solarSystem.js';
import { AU_M, J2000_JD, GM } from '../src/core/constants.js';
import { jdFromIsoUtc } from '../src/core/time/time.js';
import { vec3, add, length, sub, scale, normalize } from '../src/core/math/vec3.js';
import { integrateAdaptive, type AccelerationFn } from '../src/core/integrate/integrators.js';
import { elementsToState, specificEnergy } from '../src/core/orbit/elements.js';

const JD_2026 = jdFromIsoUtc('2026-11-18T00:00:00Z');

/** Position offset from a body by a distance along a fixed direction. */
function offsetFrom(
  id: Parameters<typeof bodyPosition>[0],
  jd: number,
  distance: number,
  dir = vec3(1, 0.3, 0.1),
) {
  return add(bodyPosition(id, jd), scale(normalize(dir), distance));
}

describe('restricted N-body acceleration', () => {
  it('reproduces the two-body acceleration when only one body is enabled', () => {
    const r = offsetFrom('earth', JD_2026, 7000e3);
    const a = acceleration(r, JD_2026, { enabled: ['earth'] });
    const earth = bodyPosition('earth', JD_2026);
    const rel = sub(earth, r);
    const d = length(rel);
    const expected = scale(normalize(rel), GM.earth / (d * d));

    expect(a.x).toBeCloseTo(expected.x, 10);
    expect(a.y).toBeCloseTo(expected.y, 10);
    expect(a.z).toBeCloseTo(expected.z, 10);
  });

  it('points toward the body', () => {
    const r = offsetFrom('earth', JD_2026, 7000e3);
    const a = acceleration(r, JD_2026, { enabled: ['earth'] });
    const toEarth = normalize(sub(bodyPosition('earth', JD_2026), r));
    const aDir = normalize(a);
    expect(aDir.x).toBeCloseTo(toEarth.x, 12);
    expect(aDir.y).toBeCloseTo(toEarth.y, 12);
    expect(aDir.z).toBeCloseTo(toEarth.z, 12);
  });

  it('follows an inverse-square law', () => {
    const r1 = offsetFrom('sun', JD_2026, 1 * AU_M);
    const r2 = offsetFrom('sun', JD_2026, 2 * AU_M);
    const a1 = length(acceleration(r1, JD_2026, { enabled: ['sun'] }));
    const a2 = length(acceleration(r2, JD_2026, { enabled: ['sun'] }));
    expect(a1 / a2).toBeCloseTo(4, 6);
  });

  it('gives the right surface gravity for Earth', () => {
    const r = offsetFrom('earth', JD_2026, BODIES.earth.radius);
    const g = length(acceleration(r, JD_2026, { enabled: ['earth'] }));
    // Earth's mean surface gravity is 9.82 m/s².
    expect(g).toBeGreaterThan(9.7);
    expect(g).toBeLessThan(9.9);
  });

  it('gives about 9.8 m/s² at Earth surface with the full body set too', () => {
    const r = offsetFrom('earth', JD_2026, BODIES.earth.radius);
    const g = length(acceleration(r, JD_2026, ALL_BODIES));
    expect(g).toBeGreaterThan(9.7);
    expect(g).toBeLessThan(9.9);
  });

  it('is negligible from other bodies at Earth surface', () => {
    const r = offsetFrom('earth', JD_2026, BODIES.earth.radius);
    const earthOnly = length(acceleration(r, JD_2026, { enabled: ['earth'] }));
    const full = length(acceleration(r, JD_2026, ALL_BODIES));
    // Everything except Earth contributes under 1% of Earth's own pull here.
    expect(Math.abs(full - earthOnly) / earthOnly).toBeLessThan(0.01);
  });

  it('agrees with the Sun-only field at 1 AU to within planetary perturbations', () => {
    const r = offsetFrom('sun', JD_2026, AU_M);
    const sunOnly = length(acceleration(r, JD_2026, { enabled: ['sun'] }));
    const full = length(acceleration(r, JD_2026, ALL_BODIES));
    expect(Math.abs(full - sunOnly) / sunOnly).toBeLessThan(0.01);
  });

  it('is deterministic', () => {
    const r = offsetFrom('earth', JD_2026, 8000e3);
    const a = acceleration(r, JD_2026, ALL_BODIES);
    const b = acceleration(r, JD_2026, ALL_BODIES);
    expect(a).toEqual(b);
  });

  it('does not produce NaN inside a body when softening is set', () => {
    const r = bodyPosition('earth', JD_2026);
    const a = acceleration(r, JD_2026, { enabled: ['earth'], softening: 1000 });
    expect(Number.isFinite(a.x)).toBe(true);
    expect(Number.isFinite(a.y)).toBe(true);
    expect(Number.isFinite(a.z)).toBe(true);
  });

  it('returns finite acceleration far from everything', () => {
    const a = acceleration(vec3(1e15, 1e15, 1e15), JD_2026, ALL_BODIES);
    expect(Number.isFinite(a.x)).toBe(true);
    expect(length(a)).toBeGreaterThan(0);
  });

  it('treats an empty body set as free space', () => {
    const a = acceleration(vec3(1e11, 0, 0), JD_2026, { enabled: [] });
    expect(a).toEqual(vec3(0, 0, 0));
  });
});

describe('force function adapter', () => {
  it('converts seconds-from-J2000 to a Julian date', () => {
    expect(jdFromSeconds(0)).toBe(J2000_JD);
    const force = makeForceFunction({ enabled: ['sun'] });
    const r = vec3(AU_M, 0, 0);
    const direct = acceleration(r, J2000_JD, { enabled: ['sun'] });
    const viaForce = force(0, r);
    expect(viaForce.x).toBeCloseTo(direct.x, 12);
    expect(viaForce.y).toBeCloseTo(direct.y, 12);
  });

  it('integrates a circular orbit stably in the Earth-only limit', () => {
    // Two-body limit: one body, tiny steps relative to the period.
    const jd = JD_2026;
    const earth = bodyPosition('earth', jd);
    const s = elementsToState({
      a: 6778e3,
      e: 0.0001,
      i: 0.5,
      raan: 0.3,
      argPeriapsis: 0.2,
      trueAnomaly: 0,
      mu: GM.earth,
    });
    const relR = s.r;
    const start = { t: 0, r: add(earth, relR), v: s.v };
    const force: AccelerationFn = (_t, r) => acceleration(r, jd, { enabled: ['earth'] });

    const res = integrateAdaptive(start, force, 3600, { relTol: 1e-12, maxStep: 30 });
    expect(res.truncated).toBe(false);

    const relEnd = sub(res.state.r, earth);
    const energy0 = specificEnergy({ r: relR, v: s.v }, GM.earth);
    const energy1 = specificEnergy({ r: relEnd, v: res.state.v }, GM.earth);
    expect(Math.abs((energy1 - energy0) / energy0)).toBeLessThan(1e-9);
  });
});

describe('SOI selection', () => {
  it('puts a LEO spacecraft in Earth SOI', () => {
    const r = offsetFrom('earth', JD_2026, 7000e3);
    expect(containingSoi(r, JD_2026, ALL_BODIES)).toBe('earth');
  });

  it('puts a lunar-distance spacecraft in the Moon SOI when close to the Moon', () => {
    const r = offsetFrom('moon', JD_2026, 10_000e3);
    expect(containingSoi(r, JD_2026, ALL_BODIES)).toBe('moon');
  });

  it('puts a heliocentric spacecraft in the Sun SOI', () => {
    const earth = bodyPosition('earth', JD_2026);
    const r = add(earth, vec3(0.3 * AU_M, 0.3 * AU_M, 0));
    expect(containingSoi(r, JD_2026, ALL_BODIES)).toBe('sun');
  });

  it('puts a deep-space point between planets with the Sun', () => {
    const r = vec3(2.2 * AU_M, 0, 0);
    expect(containingSoi(r, JD_2026, ALL_BODIES)).toBe('sun');
  });

  it('names the dominant body consistently with the SOI for these cases', () => {
    const rLeo = offsetFrom('earth', JD_2026, 7000e3);
    expect(dominantBody(rLeo, JD_2026, ALL_BODIES)).toBe('earth');
    const rSun = vec3(1.5 * AU_M, 0, 0);
    expect(dominantBody(rSun, JD_2026, ALL_BODIES)).toBe('sun');
  });
});

describe('relative quantities', () => {
  it('gives zero relative position at the body centre', () => {
    const p = bodyPosition('mars', JD_2026);
    const rel = relativeState(p, vec3(0, 0, 0), 'mars', JD_2026);
    expect(length(rel.r)).toBeCloseTo(0, 3);
  });

  it('computes altitude above the mean radius', () => {
    const r = offsetFrom('earth', JD_2026, BODIES.earth.radius + 400e3);
    const alt = altitudeAbove(r, 'earth', JD_2026);
    expect(alt).toBeCloseTo(400e3, 0);
  });

  it('gives a negative altitude below the surface', () => {
    const r = offsetFrom('earth', JD_2026, BODIES.earth.radius * 0.5);
    expect(altitudeAbove(r, 'earth', JD_2026)).toBeLessThan(0);
  });
});
