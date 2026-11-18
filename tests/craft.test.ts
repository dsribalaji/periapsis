import { describe, expect, it } from 'vitest';
import {
  circularOrbitState,
  circularPeriod,
  circularSpeed,
  craftFromSpec,
  type CraftSpec,
} from '../src/sim/craft.js';
import { BODIES } from '../src/core/ephemeris/solarSystem.js';
import { stateToElements } from '../src/core/orbit/elements.js';

const R_EARTH = BODIES.earth.radius;
const MU_EARTH = BODIES.earth.mu;

function spec(patch: Partial<CraftSpec> = {}): CraftSpec {
  return {
    id: 'craft',
    name: 'Craft',
    centralBody: 'earth',
    orbit: { altitudeM: 400e3, inclinationRad: 0, phaseRad: 0 },
    deltaVBudget: 1000,
    propagation: 'twoBody',
    horizonSeconds: 6000,
    maneuvers: [],
    ...patch,
  };
}

describe('circular orbit state', () => {
  it('puts the craft at the stated altitude above the body radius', () => {
    const { r } = circularOrbitState('earth', spec().orbit);
    expect(Math.hypot(r.x, r.y, r.z)).toBeCloseTo(R_EARTH + 400e3, 6);
  });

  it('gives the circular speed from vis-viva', () => {
    const { r, v } = circularOrbitState('earth', spec().orbit);
    const speed = Math.hypot(v.x, v.y, v.z);
    expect(speed).toBeCloseTo(Math.sqrt(MU_EARTH / Math.hypot(r.x, r.y, r.z)), 9);
    expect(speed).toBeGreaterThan(7600);
    expect(speed).toBeLessThan(7750);
  });

  it('has velocity perpendicular to position and zero radial component', () => {
    const { r, v } = circularOrbitState('earth', {
      altitudeM: 800e3,
      inclinationRad: 0.7,
      phaseRad: 1.1,
    });
    // Normalised, not absolute: r·v is O(5e15) here, so an absolute tolerance would be
    // asserting nothing. The cosine of the angle is what "perpendicular" means.
    const cosAngle =
      (r.x * v.x + r.y * v.y + r.z * v.z) / (Math.hypot(r.x, r.y, r.z) * Math.hypot(v.x, v.y, v.z));
    expect(cosAngle).toBeCloseTo(0, 9);
  });

  it('is exactly circular: stateToElements returns e = 0 and the right semi-major axis', () => {
    const state = circularOrbitState('earth', {
      altitudeM: 400e3,
      inclinationRad: 1.0,
      phaseRad: 0.3,
    });
    const el = stateToElements(state, MU_EARTH);
    expect(el.e).toBeLessThan(1e-12);
    expect(el.a).toBeCloseTo(R_EARTH + 400e3, 0);
  });

  it('reports the stated inclination against the reference plane', () => {
    const incl = 0.9;
    const state = circularOrbitState('earth', {
      altitudeM: 500e3,
      inclinationRad: incl,
      phaseRad: 0,
    });
    const el = stateToElements(state, MU_EARTH);
    expect(el.i).toBeCloseTo(incl, 9);
  });

  it('makes an equatorial orbit stay in the xy plane', () => {
    const state = circularOrbitState('earth', {
      altitudeM: 400e3,
      inclinationRad: 0,
      phaseRad: 0.5,
    });
    expect(state.r.z).toBeCloseTo(0, 9);
    expect(state.v.z).toBeCloseTo(0, 9);
  });

  it('reverses direction at 180 degrees inclination', () => {
    const pro = circularOrbitState('earth', {
      altitudeM: 400e3,
      inclinationRad: 0,
      phaseRad: 0,
    });
    const retro = circularOrbitState('earth', {
      altitudeM: 400e3,
      inclinationRad: Math.PI,
      phaseRad: 0,
    });
    // Position is the same, motion is opposite.
    expect(retro.r.x).toBeCloseTo(pro.r.x, 6);
    expect(retro.v.y).toBeCloseTo(-pro.v.y, 6);
  });

  it('rotates the phase around the orbit', () => {
    const a = circularOrbitState('earth', { altitudeM: 400e3, inclinationRad: 0, phaseRad: 0 });
    const b = circularOrbitState('earth', {
      altitudeM: 400e3,
      inclinationRad: 0,
      phaseRad: Math.PI / 2,
    });
    expect(b.r.x).toBeCloseTo(0, 6);
    expect(b.r.y).toBeCloseTo(a.r.x, 6);
  });

  it('rejects an altitude that does not clear the surface', () => {
    expect(() =>
      circularOrbitState('earth', { altitudeM: -1e6, inclinationRad: 0, phaseRad: 0 }),
    ).toThrow(/does not clear/);
  });

  it('works about a body other than Earth', () => {
    const state = circularOrbitState('mars', {
      altitudeM: 300e3,
      inclinationRad: 0.2,
      phaseRad: 0,
    });
    const el = stateToElements(state, BODIES.mars.mu);
    expect(el.a).toBeCloseTo(BODIES.mars.radius + 300e3, 0);
    expect(el.e).toBeLessThan(1e-12);
  });
});

describe('craft from spec', () => {
  it('carries the budget and nodes through unchanged', () => {
    const s = spec({ deltaVBudget: 4321 });
    const craft = craftFromSpec(s);
    expect(craft.deltaVBudget).toBe(4321);
    expect(craft.centralBody).toBe('earth');
    expect(craft.maneuvers).toEqual([]);
  });

  it('derives a state consistent with the spec, not a free vector', () => {
    const craft = craftFromSpec(spec());
    expect(Math.hypot(craft.position.x, craft.position.y, craft.position.z)).toBeCloseTo(
      R_EARTH + 400e3,
      6,
    );
  });

  it('reports the period of a 400 km orbit near 92 minutes', () => {
    const period = circularPeriod(spec());
    expect(period / 60).toBeGreaterThan(91);
    expect(period / 60).toBeLessThan(93);
  });

  it('reports the circular speed consistently with the derived state', () => {
    const craft = craftFromSpec(spec());
    const speed = Math.hypot(craft.velocity.x, craft.velocity.y, craft.velocity.z);
    expect(circularSpeed(spec())).toBeCloseTo(speed, 9);
  });
});
