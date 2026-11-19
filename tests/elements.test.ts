import { describe, expect, it } from 'vitest';
import {
  stateToElements,
  elementsToState,
  specificEnergy,
  specificAngularMomentum,
  orbitalPeriod,
  apsides,
  localOrbitalFrame,
  applyImpulse,
  type OrbitalElements,
} from '../src/core/orbit/elements.js';
import { vec3, length, dot, cross, normalize, sub } from '../src/core/math/vec3.js';
import { GM } from '../src/core/constants.js';
import fc from 'fast-check';

const MU_EARTH = GM.earth;

/**
 * Smallest angular difference between two angles, tolerant of 0/2π wraparound.
 * Comparing angles with a plain subtraction is a bug: 2π and 0 are the same direction.
 */
function angleDiff(a: number, b: number): number {
  let d = (a - b) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return Math.abs(d);
}

/** Builds a circular equatorial orbit state at radius r and speed v. */
function circularState(r: number, v: number) {
  return { r: vec3(r, 0, 0), v: vec3(0, v, 0) };
}

describe('elements <-> state', () => {
  it('converts a circular equatorial orbit', () => {
    const r = 7000e3;
    const v = Math.sqrt(MU_EARTH / r);
    const el = stateToElements(circularState(r, v), MU_EARTH);
    expect(el.a).toBeCloseTo(r, 1);
    expect(el.e).toBeLessThan(1e-10);
    expect(el.i).toBeLessThan(1e-12);
  });

  it('recovers a known 400 km LEO orbit', () => {
    const r = 6778e3;
    const v = Math.sqrt(MU_EARTH / r);
    const state = circularState(r, v);
    const el = stateToElements(state, MU_EARTH);
    const back = elementsToState(el);
    expect(length(back.r)).toBeCloseTo(r, 0);
    expect(length(back.v)).toBeCloseTo(v, 6);
  });

  it('computes the ISS-like period correctly', () => {
    const a = 6778e3;
    const T = orbitalPeriod(a, MU_EARTH);
    // A ~92.5 minute orbit at 400 km altitude.
    expect(T / 60).toBeGreaterThan(90);
    expect(T / 60).toBeLessThan(95);
  });

  /**
   * The physically meaningful round-trip is state -> elements -> state. Element angles
   * are ill-conditioned near e = 0 (the periapsis direction is undefined for a circle),
   * so asserting on ν there would test numerical noise, not correctness.
   *
   * Generators exclude subnormal doubles (e.g. e = 8e-323): those stress IEEE-754
   * denormal handling, not orbital mechanics, and a denormal `i` amplifies to ~1e-8
   * relative velocity error through the √(mu/p) term. The degenerate cases e = 0 and
   * i = 0 / π are covered explicitly instead. Documented in PHYSICS.md §5.
   */
  const ecce = fc.oneof(fc.constant(0), fc.double({ min: 1e-6, max: 0.95, noNaN: true }));
  const incl = fc.oneof(
    fc.constant(0),
    fc.constant(Math.PI),
    fc.double({ min: 1e-4, max: Math.PI - 1e-4, noNaN: true }),
  );
  const ang = fc.double({ min: 0, max: 2 * Math.PI, noNaN: true });
  const trueAnom = fc.double({ min: -Math.PI, max: Math.PI, noNaN: true });

  it('round-trips arbitrary elliptic states through elements', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 1e6, max: 1e10, noNaN: true }),
        ecce,
        incl,
        ang,
        ang,
        trueAnom,
        (a, e, i, raan, argp, nu) => {
          const el: OrbitalElements = {
            a,
            e,
            i,
            raan,
            argPeriapsis: argp,
            trueAnomaly: nu,
            mu: MU_EARTH,
          };
          const s1 = elementsToState(el);
          const s2 = elementsToState(stateToElements(s1, MU_EARTH));

          const rScale = length(s1.r);
          /**
           * Bound is 1e-7 relative, and the limit is mathematical, not a code defect.
           * True anomaly is an ill-conditioned parametrisation at the apsides: near
           * ν = 0, `cos ν` rounds to 1 below ν ≈ √ε ≈ 1.5e-8, so two states that differ
           * by less than that are indistinguishable in double precision and the
           * conversion legitimately returns the apsis. The observed worst case is
           * ~2.1e-8 (measured across 8000 random orbits and swept across the apsides);
           * away from the apsides it is ~1e-16. Documented in PHYSICS.md §5.
           */
          expect(length(sub(s2.r, s1.r)) / rScale).toBeLessThan(1e-7);
          expect(length(sub(s2.v, s1.v)) / length(s1.v)).toBeLessThan(1e-7);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('round-trips an eccentric orbit at apoapsis, where acos used to lose precision', () => {
    // The counterexample fast-check found (seed -1688004366): e = 0.79, 3e-10 rad short of
    // apoapsis. With `acos` for the true anomaly the velocity came back 1.2e-7 off; with
    // `atan2` it is at rounding level.
    const el: OrbitalElements = {
      a: 1040819.2166812739,
      e: 0.7929095107472309,
      i: 0.0001,
      raan: 0,
      argPeriapsis: 0.0009640873938426478,
      trueAnomaly: 3.1415926532985807,
      mu: MU_EARTH,
    };
    const s1 = elementsToState(el);
    const s2 = elementsToState(stateToElements(s1, MU_EARTH));
    expect(length(sub(s2.r, s1.r)) / length(s1.r)).toBeLessThan(1e-12);
    expect(length(sub(s2.v, s1.v)) / length(s1.v)).toBeLessThan(1e-12);
  });

  /** Element values round-trip when the orbit is not degenerate (e and i away from 0). */
  it('round-trips element values on well-conditioned orbits', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 1e6, max: 1e10, noNaN: true }),
        fc.double({ min: 0.01, max: 0.95, noNaN: true }),
        fc.double({ min: 0.05, max: Math.PI - 0.05, noNaN: true }),
        ang,
        ang,
        fc.double({ min: -Math.PI + 0.01, max: Math.PI - 0.01, noNaN: true }),
        (a, e, i, raan, argp, nu) => {
          const el: OrbitalElements = {
            a,
            e,
            i,
            raan,
            argPeriapsis: argp,
            trueAnomaly: nu,
            mu: MU_EARTH,
          };
          const back = stateToElements(elementsToState(el), MU_EARTH);

          expect(back.a / a).toBeCloseTo(1, 8);
          expect(back.e).toBeCloseTo(e, 8);
          expect(Math.cos(back.i)).toBeCloseTo(Math.cos(i), 8);
          expect(angleDiff(back.raan, raan)).toBeLessThan(1e-6);
          expect(angleDiff(back.argPeriapsis, argp)).toBeLessThan(1e-6);
          expect(angleDiff(back.trueAnomaly, nu)).toBeLessThan(1e-6);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('round-trips hyperbolic states', () => {
    const el: OrbitalElements = {
      a: -20000e3,
      e: 1.5,
      i: 0.6,
      raan: 1.1,
      argPeriapsis: 0.4,
      trueAnomaly: 0.3,
      mu: MU_EARTH,
    };
    const state = elementsToState(el);
    const back = stateToElements(state, MU_EARTH);
    expect(back.a).toBeCloseTo(el.a, 0);
    expect(back.e).toBeCloseTo(el.e, 8);
    expect(specificEnergy(state, MU_EARTH)).toBeGreaterThan(0);
  });

  it('rejects parabolic orbits', () => {
    expect(() =>
      elementsToState({
        a: 1e7,
        e: 1,
        i: 0,
        raan: 0,
        argPeriapsis: 0,
        trueAnomaly: 0,
        mu: MU_EARTH,
      }),
    ).toThrow(/parabolic/);
  });

  it('conserves specific energy across the conversion', () => {
    const state = circularState(7000e3, Math.sqrt(MU_EARTH / 7000e3) * 1.1);
    const el = stateToElements(state, MU_EARTH);
    const back = elementsToState(el);
    expect(specificEnergy(back, MU_EARTH)).toBeCloseTo(specificEnergy(state, MU_EARTH), 0);
    expect(specificAngularMomentum(back)).toBeCloseTo(specificAngularMomentum(state), 0);
  });

  it('computes apsides correctly', () => {
    const { periapsis, apoapsis } = apsides(10000e3, 0.2);
    expect(periapsis).toBeCloseTo(8000e3, 0);
    expect(apoapsis).toBeCloseTo(12000e3, 0);
    expect(apsides(-1e7, 1.5).apoapsis).toBe(Infinity);
  });
});

describe('local orbital frame and impulses', () => {
  it('builds an orthonormal frame', () => {
    const state = {
      r: vec3(7000e3, 1000e3, 200e3),
      v: vec3(-100, 7500, 500),
    };
    const f = localOrbitalFrame(state);
    expect(length(f.prograde)).toBeCloseTo(1, 12);
    expect(length(f.normal)).toBeCloseTo(1, 12);
    expect(length(f.radial)).toBeCloseTo(1, 12);
    expect(dot(f.prograde, f.normal)).toBeCloseTo(0, 12);
    expect(dot(f.prograde, f.radial)).toBeCloseTo(0, 12);
    expect(dot(f.normal, f.radial)).toBeCloseTo(0, 12);
    // The frame is right-handed in the (radial, prograde, normal) sense.
    expect(dot(cross(f.radial, f.prograde), normalize(cross(state.r, state.v)))).toBeGreaterThan(
      0.99,
    );
  });

  it('raises apoapsis with a prograde burn and keeps periapsis', () => {
    const r = 7000e3;
    const v = Math.sqrt(MU_EARTH / r);
    const before = stateToElements(circularState(r, v), MU_EARTH);
    const after = stateToElements(
      applyImpulse(circularState(r, v), { prograde: 200, normal: 0, radial: 0 }),
      MU_EARTH,
    );

    expect(after.a).toBeGreaterThan(before.a);
    expect(after.e).toBeGreaterThan(0);
    expect(apsides(after.a, after.e).periapsis).toBeCloseTo(r, -2);
  });

  it('changes inclination only with a normal burn', () => {
    const r = 7000e3;
    const v = Math.sqrt(MU_EARTH / r);
    const state = circularState(r, v);

    const progradeOnly = stateToElements(
      applyImpulse(state, { prograde: 100, normal: 0, radial: 0 }),
      MU_EARTH,
    );
    expect(progradeOnly.i).toBeLessThan(1e-9);

    const normalBurn = stateToElements(
      applyImpulse(state, { prograde: 0, normal: 100, radial: 0 }),
      MU_EARTH,
    );
    expect(normalBurn.i).toBeGreaterThan(0.001);
  });

  it('applies no change for a zero impulse', () => {
    const state = { r: vec3(7000e3, 0, 0), v: vec3(0, 7546, 100) };
    const out = applyImpulse(state, { prograde: 0, normal: 0, radial: 0 });
    expect(length(out.v)).toBeCloseTo(length(state.v), 9);
  });
});
