import { describe, expect, it } from 'vitest';
import {
  applyManeuver,
  isManeuverInRange,
  maneuverDeltaV,
  maneuverMagnitude,
  sortedManeuvers,
  totalDeltaV,
  type Maneuver,
} from '../src/sim/maneuver.js';
import { localOrbitalFrame } from '../src/core/orbit/elements.js';
import {
  add,
  cross,
  dot,
  length,
  normalize,
  scale,
  sub,
  vec3,
  X_AXIS,
  Z_AXIS,
} from '../src/core/math/vec3.js';

const GATE = 3.986004418e14;
const R_LEO = 6.678e6;

/** A circular, equatorial LEO state. */
function circularState(r = R_LEO) {
  const v = Math.sqrt(GATE / r);
  return { r: vec3(r, 0, 0), v: vec3(0, v, 0) };
}

function burn(patch: Partial<Maneuver> = {}): Maneuver {
  return { id: 'b1', timeSeconds: 0, a: 0, b: 0, c: 0, frame: 'local', ...patch };
}

describe('maneuver magnitude and totals', () => {
  it('computes magnitude across all three components', () => {
    expect(maneuverMagnitude(burn({ a: 3, b: 4, c: 0 }))).toBeCloseTo(5, 12);
    expect(maneuverMagnitude(burn({ a: 1, b: 2, c: 2 }))).toBeCloseTo(3, 12);
  });

  it('is zero for a null burn', () => {
    expect(maneuverMagnitude(burn())).toBe(0);
  });

  it('sums magnitudes, not the vector sum', () => {
    const nodes = [burn({ a: 100 }), burn({ a: -100 })];
    // A prograde and a retrograde burn of the same size cost 200 m/s, not 0.
    expect(totalDeltaV(nodes)).toBeCloseTo(200, 12);
  });

  it('is zero for no maneuvers', () => {
    expect(totalDeltaV([])).toBe(0);
  });
});

describe('local frame orientation', () => {
  it('produces an orthonormal right-handed frame', () => {
    const { r, v } = circularState();
    const f = localOrbitalFrame({ r, v });
    for (const u of [f.prograde, f.normal, f.radial]) expect(length(u)).toBeCloseTo(1, 12);
    expect(dot(f.prograde, f.normal)).toBeCloseTo(0, 12);
    expect(dot(f.prograde, f.radial)).toBeCloseTo(0, 12);
    expect(dot(f.normal, f.radial)).toBeCloseTo(0, 12);
  });

  it('stays orthonormal on an eccentric orbit, where r-hat is not perpendicular to v', () => {
    // A highly eccentric state: position and velocity are far from perpendicular.
    const r = vec3(7e6, 0, 0);
    const v = vec3(6e3, 9e3, 0);
    const f = localOrbitalFrame({ r, v });
    for (const u of [f.prograde, f.normal, f.radial]) expect(length(u)).toBeCloseTo(1, 12);
    expect(dot(f.prograde, f.radial)).toBeCloseTo(0, 12);
    // This is the point of the design: r-hat is NOT perpendicular to v here.
    expect(Math.abs(dot(normalize(r), normalize(v)))).toBeGreaterThan(0.1);
  });

  it('puts radial along the position direction and normal along angular momentum', () => {
    const { r, v } = circularState();
    const f = localOrbitalFrame({ r, v });
    expect(Math.abs(dot(f.radial, normalize(r)))).toBeCloseTo(1, 12);
    expect(Math.abs(dot(f.normal, normalize(cross(r, v))))).toBeCloseTo(1, 12);
  });

  it('keeps prograde in the orbital plane, so a prograde burn cannot tilt it', () => {
    const r = vec3(7e6, 0, 0);
    const v = vec3(6e3, 9e3, 1.5e3);
    const f = localOrbitalFrame({ r, v });
    const hHat = normalize(cross(r, v));
    expect(dot(f.prograde, hHat)).toBeCloseTo(0, 12);
  });
});

describe('applying a maneuver', () => {
  it('a pure prograde burn raises speed by exactly the delta-v', () => {
    const state = circularState();
    const after = applyManeuver(burn({ a: 250 }), state);
    expect(length(after.v) - length(state.v)).toBeCloseTo(250, 9);
    // Position is unchanged: the burn is impulsive.
    expect(after.r).toEqual(state.r);
  });

  it('a retrograde burn lowers speed', () => {
    const state = circularState();
    const after = applyManeuver(burn({ a: -250 }), state);
    expect(length(after.v) - length(state.v)).toBeCloseTo(-250, 9);
  });

  it('a pure normal burn changes speed by the delta-v on a circular orbit', () => {
    const state = circularState();
    const after = applyManeuver(burn({ b: 100 }), state);
    const expected = Math.hypot(length(state.v), 100);
    expect(length(after.v)).toBeCloseTo(expected, 6);
  });

  it('sums two local delta-v vectors at one instant, because both share a frame', () => {
    const state = circularState();
    const x = burn({ id: 'x', a: 120, b: 30 });
    const y = burn({ id: 'y', a: -40, c: 15 });
    const combined = maneuverDeltaV(
      burn({ a: x.a + y.a, b: x.b + y.b, c: x.c + y.c }),
      state.r,
      state.v,
    );
    const sum = add(maneuverDeltaV(x, state.r, state.v), maneuverDeltaV(y, state.r, state.v));
    expect(length(sub(combined, sum))).toBeLessThan(1e-9);
  });

  it('is order-dependent when applied sequentially, because the frame moves', () => {
    // This is correct behaviour, not a defect: a local burn is re-expressed in the frame of
    // the state it is applied to, so after the first burn the second one points slightly
    // differently. The difference is small but real, and it is why sortedManeuvers breaks
    // ties by id rather than relying on input order.
    const state = circularState();
    const x = burn({ id: 'x', a: 120, b: 30 });
    const y = burn({ id: 'y', a: -40, c: 15 });
    const xy = applyManeuver(y, applyManeuver(x, state));
    const yx = applyManeuver(x, applyManeuver(y, state));
    const difference = length(sub(xy.v, yx.v));
    // Measured 0.15 m/s for these two burns, roughly 0.1% of the 140 m/s involved.
    expect(difference).toBeGreaterThan(0);
    expect(difference).toBeLessThan(1);
  });

  it('applies an inertial burn along the inertial axes regardless of orientation', () => {
    const state = circularState();
    const after = applyManeuver(burn({ frame: 'inertial', a: 10, b: 0, c: 0 }), state);
    expect(after.v.x).toBeCloseTo(state.v.x + 10, 12);
    expect(after.v.y).toBeCloseTo(state.v.y, 12);
  });

  it('gives the same inertial delta-v as the explicit component sum', () => {
    const state = circularState();
    const m = burn({ a: 100, b: 50, c: -25 });
    const dv = maneuverDeltaV(m, state.r, state.v);
    const f = localOrbitalFrame(state);
    const expected = add(add(scale(f.prograde, 100), scale(f.normal, 50)), scale(f.radial, -25));
    expect(length(sub(dv, expected))).toBeLessThan(1e-9);
  });

  it('produces a different inertial delta-v at a different point on the orbit', () => {
    // The same local node means different things at different states — that is the reason
    // local burns are the default.
    const atX = circularState();
    const atY = { r: vec3(0, R_LEO, 0), v: vec3(-Math.sqrt(GATE / R_LEO), 0, 0) };
    const d1 = maneuverDeltaV(burn({ a: 100 }), atX.r, atX.v);
    const d2 = maneuverDeltaV(burn({ a: 100 }), atY.r, atY.v);
    expect(length(sub(d1, d2))).toBeGreaterThan(50);
  });

  it('rejects nothing at zero delta-v but leaves the state untouched', () => {
    const state = circularState();
    const after = applyManeuver(burn(), state);
    expect(after.v).toEqual(state.v);
  });
});

describe('maneuver ordering', () => {
  it('sorts by time', () => {
    const nodes = [
      burn({ id: 'c', timeSeconds: 300 }),
      burn({ id: 'a', timeSeconds: 100 }),
      burn({ id: 'b', timeSeconds: 200 }),
    ];
    expect(sortedManeuvers(nodes).map((m) => m.id)).toEqual(['a', 'b', 'c']);
  });

  it('breaks ties by id, so replay order is deterministic', () => {
    const nodes = [
      burn({ id: 'z', timeSeconds: 100 }),
      burn({ id: 'a', timeSeconds: 100 }),
      burn({ id: 'm', timeSeconds: 100 }),
    ];
    expect(sortedManeuvers(nodes).map((m) => m.id)).toEqual(['a', 'm', 'z']);
    // And the input is not mutated.
    expect(nodes.map((m) => m.id)).toEqual(['z', 'a', 'm']);
  });

  it('keeps negative time nodes, which the caller filters by horizon', () => {
    const nodes = [burn({ id: 'past', timeSeconds: -50 }), burn({ id: 'future', timeSeconds: 50 })];
    expect(sortedManeuvers(nodes).map((m) => m.id)).toEqual(['past', 'future']);
  });
});

describe('maneuver range checks', () => {
  it('accepts finite nodes', () => {
    expect(isManeuverInRange(burn({ timeSeconds: 1 }))).toBe(true);
    expect(isManeuverInRange(burn({ timeSeconds: -1e9 }))).toBe(true);
  });

  it('rejects non-finite times or components', () => {
    expect(isManeuverInRange(burn({ timeSeconds: Number.NaN }))).toBe(false);
    expect(isManeuverInRange(burn({ timeSeconds: Number.POSITIVE_INFINITY }))).toBe(false);
    expect(isManeuverInRange(burn({ a: Number.NaN }))).toBe(false);
    expect(isManeuverInRange(burn({ c: Number.NEGATIVE_INFINITY }))).toBe(false);
  });
});

describe('frame conventions', () => {
  it('prograde is +x for a state moving along +x in a plane', () => {
    const f = localOrbitalFrame({ r: vec3(0, 1e7, 0), v: vec3(1e3, 0, 0) });
    expect(dot(f.prograde, X_AXIS)).toBeCloseTo(1, 12);
    // Angular momentum r x v is  y x x = -z.
    expect(Math.abs(dot(f.normal, Z_AXIS))).toBeCloseTo(1, 12);
  });
});
