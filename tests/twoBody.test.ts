import { describe, expect, it } from 'vitest';
import {
  propagateTwoBody,
  sampleTwoBodyArc,
  meanAnomalyFromTrue,
  hyperbolicMeanFromTrue,
} from '../src/core/orbit/twoBody.js';
import { elementsToState, stateToElements, specificEnergy, specificAngularMomentum, orbitalPeriod, apsides } from '../src/core/orbit/elements.js';
import { vec3, length, sub } from '../src/core/math/vec3.js';
import { GM } from '../src/core/constants.js';
import fc from 'fast-check';

const MU = GM.earth;

function leoState(a = 6778e3, e = 0.001) {
  return elementsToState({
    a, e, i: 0.9, raan: 1.2, argPeriapsis: 0.4, trueAnomaly: 0.7, mu: MU,
  });
}

describe('two-body propagation', () => {
  it('returns the same state for dt = 0', () => {
    const s = leoState();
    expect(propagateTwoBody(s, MU, 0)).toBe(s);
  });

  it('returns to the start after one full period', () => {
    const s = leoState();
    const el = stateToElements(s, MU);
    const T = orbitalPeriod(el.a, MU);
    const back = propagateTwoBody(s, MU, T);
    expect(length(sub(back.r, s.r)) / length(s.r)).toBeLessThan(1e-9);
    expect(length(sub(back.v, s.v)) / length(s.v)).toBeLessThan(1e-9);
  });

  it('returns to the start after many full periods', () => {
    const s = leoState(26560e3, 0.74); // Molniya-like
    const T = orbitalPeriod(stateToElements(s, MU).a, MU);
    for (const n of [1, 2, 5, 25]) {
      const back = propagateTwoBody(s, MU, n * T);
      expect(length(sub(back.r, s.r)) / length(s.r)).toBeLessThan(1e-7);
    }
  });

  it('is symmetric: forward then backward returns near the start', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 1e3, max: 1e7, noNaN: true }),
        fc.double({ min: -Math.PI + 0.01, max: Math.PI - 0.01, noNaN: true }),
        (dt, x) => {
          const nuShift = x;
          const start = elementsToState({
            a: 7000e3, e: 0.05, i: 0.5, raan: 0.2, argPeriapsis: 0.1, trueAnomaly: nuShift, mu: MU,
          });
          const fwd = propagateTwoBody(start, MU, dt);
          const back = propagateTwoBody(fwd, MU, -dt);
          // 1e-7 relative, not 1e-8: this sweep passes through the apsides, where the
          // element round-trip is limited to √ε ≈ 1.5e-8 by the conditioning of true
          // anomaly near ν = 0 (measured 2.1e-8 worst case; see PHYSICS.md §5).
          expect(length(sub(back.r, start.r)) / length(start.r)).toBeLessThan(1e-7);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('conserves specific energy and angular momentum', () => {
    const s = leoState(26560e3, 0.74);
    const e0 = specificEnergy(s, MU);
    const h0 = specificAngularMomentum(s);
    const T = orbitalPeriod(stateToElements(s, MU).a, MU);
    for (let k = 1; k <= 10; k++) {
      const p = propagateTwoBody(s, MU, (k * T) / 10);
      expect(specificEnergy(p, MU)).toBeCloseTo(e0, 0);
      expect(specificAngularMomentum(p) / h0).toBeCloseTo(1, 10);
    }
  });

  it('reaches periapsis at the expected time', () => {
    const a = 10000e3;
    const e = 0.2;
    const { periapsis } = apsides(a, e);
    const s = elementsToState({
      a, e, i: 0, raan: 0, argPeriapsis: 0, trueAnomaly: Math.PI / 2, mu: MU,
    });
    const el = stateToElements(s, MU);
    expect(el.a).toBeCloseTo(a, -2);
    // Time from nu = pi/2 to periapsis (nu = 0) going forward is (2pi - M(nu)) / n.
    const n = Math.sqrt(MU / (a * a * a));
    const M = meanAnomalyFromTrue(Math.PI / 2, e);
    const dt = ((2 * Math.PI - M) % (2 * Math.PI)) / n;
    const p = propagateTwoBody(s, MU, dt);
    expect(length(p.r)).toBeCloseTo(periapsis, -2);
  });

  it('propagates hyperbolic orbits', () => {
    const s = elementsToState({
      a: -25000e3, e: 1.4, i: 0.3, raan: 0.5, argPeriapsis: 0.2, trueAnomaly: 0.1, mu: MU,
    });
    const p = propagateTwoBody(s, MU, 3600);
    expect(length(p.r)).toBeGreaterThan(length(s.r));
    expect(specificEnergy(p, MU)).toBeCloseTo(specificEnergy(s, MU), -1);
  });

  it('propagates backwards for elliptic orbits', () => {
    const s = leoState();
    const p = propagateTwoBody(s, MU, -1800);
    const q = propagateTwoBody(p, MU, 1800);
    expect(length(sub(q.r, s.r)) / length(s.r)).toBeLessThan(1e-9);
  });
});

describe('anomaly helpers', () => {
  it('computes mean anomaly from true anomaly consistently', () => {
    const e = 0.35;
    for (let k = 0; k < 12; k++) {
      const nu = -Math.PI + (k / 12) * 2 * Math.PI;
      const M = meanAnomalyFromTrue(nu, e);
      expect(M).toBeGreaterThanOrEqual(0);
      expect(M).toBeLessThan(2 * Math.PI);
    }
  });

  it('computes hyperbolic mean anomaly from true anomaly consistently', () => {
    const e = 1.7;
    for (const nu of [-1.0, -0.5, 0, 0.5, 1.0]) {
      const M = hyperbolicMeanFromTrue(nu, e);
      expect(Number.isFinite(M)).toBe(true);
    }
    expect(hyperbolicMeanFromTrue(0, e)).toBeCloseTo(0, 10);
  });
});

describe('arc sampling', () => {
  it('samples the requested number of points', () => {
    const s = leoState();
    expect(sampleTwoBodyArc(s, MU, 3600, 50)).toHaveLength(50);
  });

  it('closes on itself over a full period', () => {
    const s = leoState();
    const T = orbitalPeriod(stateToElements(s, MU).a, MU);
    const arc = sampleTwoBodyArc(s, MU, T, 64);
    const first = arc[0]!;
    const last = arc[arc.length - 1]!;
    expect(length(sub(last.r, first.r)) / length(first.r)).toBeLessThan(1e-9);
  });

  it('rejects too few samples', () => {
    expect(() => sampleTwoBodyArc(leoState(), MU, 100, 1)).toThrow(/at least 2/);
  });
});

describe('degenerate input handling', () => {
  it('rejects a zero position', () => {
    expect(() => stateToElements({ r: vec3(0, 0, 0), v: vec3(1, 0, 0) }, MU)).toThrow(/zero/);
  });

  it('rejects a rectilinear state', () => {
    expect(() => stateToElements({ r: vec3(7e6, 0, 0), v: vec3(100, 0, 0) }, MU)).toThrow(/rectilinear/);
  });
});
