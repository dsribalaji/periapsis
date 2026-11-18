import { describe, expect, it } from 'vitest';
import {
  type Vec3,
  vec3,
  add,
  sub,
  scale,
  dot,
  cross,
  length,
  normalize,
  distance,
  angleBetween,
  projectOnto,
  rejectFrom,
  anyPerpendicular,
  rotateAboutAxis,
  rotateX,
  rotateY,
  rotateZ,
  lerp,
  equalsApprox,
  ZERO,
} from '../src/core/math/vec3.js';
import { clamp, wrapTwoPi, wrapPi, relativeDifference } from '../src/core/math/numeric.js';

describe('vec3', () => {
  const a = vec3(1, 2, 3);
  const b = vec3(-4, 5, 6);

  it('adds, subtracts and scales', () => {
    expect(add(a, b)).toEqual(vec3(-3, 7, 9));
    expect(sub(a, b)).toEqual(vec3(5, -3, -3));
    expect(scale(a, 2)).toEqual(vec3(2, 4, 6));
  });

  it('computes dot and cross products', () => {
    expect(dot(a, b)).toBe(-4 + 10 + 18);
    expect(cross(vec3(1, 0, 0), vec3(0, 1, 0))).toEqual(vec3(0, 0, 1));
    expect(cross(a, a)).toEqual(ZERO);
  });

  it('computes lengths and distances', () => {
    expect(length(vec3(3, 4, 0))).toBeCloseTo(5, 12);
    expect(distance(vec3(1, 1, 1), vec3(1, 1, 4))).toBeCloseTo(3, 12);
  });

  it('normalizes without dividing by zero', () => {
    expect(length(normalize(a))).toBeCloseTo(1, 15);
    expect(normalize(ZERO)).toEqual(ZERO);
  });

  it('is orthogonal under cross product', () => {
    const c = cross(a, b);
    expect(dot(c, a)).toBeCloseTo(0, 12);
    expect(dot(c, b)).toBeCloseTo(0, 12);
  });

  it('computes angles without NaN from rounding', () => {
    expect(angleBetween(vec3(1, 0, 0), vec3(1, 0, 0))).toBeCloseTo(0, 15);
    expect(angleBetween(vec3(1, 0, 0), vec3(-1, 0, 0))).toBeCloseTo(Math.PI, 15);
    expect(angleBetween(vec3(1, 0, 0), vec3(0, 1, 0))).toBeCloseTo(Math.PI / 2, 15);
    expect(Number.isNaN(angleBetween(vec3(1e8, 1e8, 1e8), vec3(1e8, 1e8, 1e8)))).toBe(false);
  });

  it('projects and rejects', () => {
    const p = projectOnto(vec3(3, 4, 0), vec3(1, 0, 0));
    expect(p).toEqual(vec3(3, 0, 0));
    const r = rejectFrom(vec3(3, 4, 0), vec3(1, 0, 0));
    expect(r).toEqual(vec3(0, 4, 0));
    expect(projectOnto(a, ZERO)).toEqual(ZERO);
  });

  it('finds a perpendicular for degenerate axis candidates', () => {
    for (const v of [vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1), vec3(0.15, 0.01, 0.99)]) {
      const perp = anyPerpendicular(v);
      expect(Math.abs(dot(normalize(v), perp))).toBeLessThan(1e-12);
      expect(length(perp)).toBeCloseTo(1, 12);
    }
  });

  it('rotates about axes preserving length', () => {
    const v = vec3(1, 2, 3);
    for (const r of [
      rotateAboutAxis(v, normalize(vec3(1, 1, 0)), 0.7),
      rotateX(v, 0.7),
      rotateY(v, 0.7),
      rotateZ(v, 0.7),
    ]) {
      expect(length(r)).toBeCloseTo(length(v), 12);
    }
  });

  it('rotates a quarter turn about z correctly', () => {
    const r = rotateZ(vec3(1, 0, 0), Math.PI / 2);
    expect(equalsApprox(r, vec3(0, 1, 0), 1e-15)).toBe(true);
  });

  it('agrees between axis rotation forms', () => {
    const v = vec3(0.3, -0.2, 0.9);
    expect(equalsApprox(rotateAboutAxis(v, vec3(0, 0, 1), 0.4), rotateZ(v, 0.4), 1e-14)).toBe(true);
    expect(equalsApprox(rotateAboutAxis(v, vec3(1, 0, 0), 0.4), rotateX(v, 0.4), 1e-14)).toBe(true);
    expect(equalsApprox(rotateAboutAxis(v, vec3(0, 1, 0), 0.4), rotateY(v, 0.4), 1e-14)).toBe(true);
  });

  it('rotates by 2π back to itself', () => {
    const v = vec3(1, -2, 3);
    expect(equalsApprox(rotateZ(v, 2 * Math.PI), v, 1e-12)).toBe(true);
  });

  it('lerps endpoints exactly', () => {
    expect(lerp(a, b, 0)).toEqual(a);
    expect(lerp(a, b, 1)).toEqual(b);
  });
});

describe('numeric helpers', () => {
  it('clamps', () => {
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(11, 0, 10)).toBe(10);
  });

  it('wraps angles into canonical ranges', () => {
    expect(wrapTwoPi(-Math.PI / 2)).toBeCloseTo((3 * Math.PI) / 2, 12);
    expect(wrapTwoPi(5 * Math.PI)).toBeCloseTo(Math.PI, 12);
    expect(wrapPi(3 * Math.PI)).toBeCloseTo(Math.PI, 12);
    expect(wrapPi(-3 * Math.PI)).toBeCloseTo(Math.PI, 12);
    expect(wrapPi(0.5)).toBeCloseTo(0.5, 15);
  });

  it('computes relative difference safely at zero', () => {
    expect(relativeDifference(0, 0)).toBe(0);
    expect(relativeDifference(100, 101)).toBeCloseTo(1 / 101, 12);
  });
});

describe('vec3 invariants', () => {
  it('maintains the vector triple product identity', () => {
    const u: Vec3 = vec3(1.5, -2.5, 0.75);
    const v: Vec3 = vec3(-0.5, 3.25, 2);
    const w: Vec3 = vec3(2, 1, -3);
    const lhs = dot(u, cross(v, w));
    const rhs = dot(w, cross(u, v));
    expect(lhs).toBeCloseTo(rhs, 12);
  });

  it('maintains the BAC-CAB rule', () => {
    const u = vec3(1, 2, -1);
    const v = vec3(0.5, -3, 2);
    const w = vec3(-2, 1, 4);
    const lhs = cross(u, cross(v, w));
    const rhs = sub(scale(v, dot(u, w)), scale(w, dot(u, v)));
    expect(equalsApprox(lhs, rhs, 1e-12)).toBe(true);
  });
});
