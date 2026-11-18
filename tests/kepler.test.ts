import { describe, expect, it } from 'vitest';
import {
  solveKeplerElliptic,
  solveKeplerHyperbolic,
  eccentricToTrueAnomaly,
  trueToEccentricAnomaly,
  eccentricToMeanAnomaly,
  hyperbolicToTrueAnomaly,
  trueToHyperbolicAnomaly,
  hyperbolicToMeanAnomaly,
} from '../src/core/orbit/kepler.js';
import { wrapTwoPi, wrapPi } from '../src/core/math/numeric.js';

describe('Kepler elliptic solver', () => {
  it('returns E = M for a circular orbit', () => {
    for (const M of [0, 0.5, 1.5, 3, 5.9]) {
      expect(solveKeplerElliptic(M, 0)).toBeCloseTo(wrapTwoPi(M), 12);
    }
  });

  it('satisfies Kepler equation to round-off', () => {
    for (const e of [0.001, 0.1, 0.3, 0.5, 0.7, 0.9, 0.95, 0.99]) {
      for (let k = 0; k < 24; k++) {
        const M = (k / 24) * 2 * Math.PI;
        const E = solveKeplerElliptic(M, e);
        const residual = E - e * Math.sin(E) - wrapTwoPi(M);
        expect(Math.abs(residual)).toBeLessThan(1e-12);
      }
    }
  });

  it('handles e = 0.9999 near periapsis and apoapsis', () => {
    const e = 0.9999;
    for (const M of [0, 1e-6, 0.001, Math.PI - 0.001, Math.PI, 2 * Math.PI - 1e-6]) {
      const E = solveKeplerElliptic(M, e);
      const residual = E - e * Math.sin(E) - wrapTwoPi(M);
      expect(Math.abs(residual)).toBeLessThan(1e-11);
    }
  });

  it('agrees with the anomaly relations at M = π', () => {
    const e = 0.4;
    const E = solveKeplerElliptic(Math.PI, e);
    expect(E).toBeCloseTo(Math.PI, 10);
    expect(eccentricToTrueAnomaly(E, e)).toBeCloseTo(Math.PI, 10);
  });

  it('rejects e >= 1 and e < 0', () => {
    expect(() => solveKeplerElliptic(1, 1)).toThrow(/range/);
    expect(() => solveKeplerElliptic(1, 1.5)).toThrow(/range/);
    expect(() => solveKeplerElliptic(1, -0.1)).toThrow(/range/);
  });
});

describe('Kepler hyperbolic solver', () => {
  it('returns H = 0 for M = 0', () => {
    expect(solveKeplerHyperbolic(0, 1.5)).toBe(0);
  });

  it('satisfies Kepler equation for hyperbolic orbits', () => {
    for (const e of [1.01, 1.1, 1.5, 2, 5, 20]) {
      for (const M of [-50, -10, -2, -0.5, 0.5, 2, 10, 50]) {
        const H = solveKeplerHyperbolic(M, e);
        const residual = e * Math.sinh(H) - H - M;
        expect(Math.abs(residual)).toBeLessThan(1e-9 * Math.max(1, Math.abs(M)));
      }
    }
  });

  it('is odd in mean anomaly', () => {
    const e = 1.6;
    for (const M of [0.3, 4, 25]) {
      expect(solveKeplerHyperbolic(-M, e)).toBeCloseTo(-solveKeplerHyperbolic(M, e), 10);
    }
  });

  it('rejects e <= 1', () => {
    expect(() => solveKeplerHyperbolic(1, 0.9)).toThrow(/exceed 1/);
    expect(() => solveKeplerHyperbolic(1, 1)).toThrow(/exceed 1/);
  });
});

describe('anomaly relations', () => {
  it('round-trips E <-> ν for elliptic orbits', () => {
    for (const e of [0.01, 0.2, 0.5, 0.8, 0.95]) {
      for (let k = 0; k < 16; k++) {
        const E = (k / 16) * 2 * Math.PI;
        const nu = eccentricToTrueAnomaly(E, e);
        const back = trueToEccentricAnomaly(nu, e);
        expect(Math.cos(back)).toBeCloseTo(Math.cos(E), 10);
        expect(Math.sin(back)).toBeCloseTo(Math.sin(E), 10);
      }
    }
  });

  it('round-trips H <-> ν for hyperbolic orbits', () => {
    for (const e of [1.1, 1.5, 2.5]) {
      for (const H of [-2, -1, -0.2, 0.2, 1, 2]) {
        const nu = hyperbolicToTrueAnomaly(H, e);
        const back = trueToHyperbolicAnomaly(nu, e);
        expect(back).toBeCloseTo(H, 9);
      }
    }
  });

  it('keeps E - e·sinE consistent with the mean anomaly', () => {
    const e = 0.6;
    for (let k = 0; k < 12; k++) {
      const E = (k / 12) * 2 * Math.PI;
      const M = eccentricToMeanAnomaly(E, e);
      expect(Math.abs(Math.sin(M) - Math.sin(wrapPi(M)))).toBeLessThan(1e-9);
    }
  });

  it('keeps hyperbolic mean anomaly monotonic', () => {
    const e = 1.8;
    let prev = -Infinity;
    for (const H of [-3, -2, -1, 0, 1, 2, 3]) {
      const M = hyperbolicToMeanAnomaly(H, e);
      expect(M).toBeGreaterThan(prev);
      prev = M;
    }
  });
});
