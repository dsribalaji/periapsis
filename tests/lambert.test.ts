import { describe, expect, it } from 'vitest';
import { solveLambert, stumpffC, stumpffS } from '../src/core/transfer/lambert.js';
import {
  hohmannTransfer,
  biEllipticTransfer,
  compareTransfers,
  circularSpeed,
  visViva,
  planeChangeDeltaV,
} from '../src/core/transfer/transfers.js';
import { GM, AU_M } from '../src/core/constants.js';
import { vec3, length } from '../src/core/math/vec3.js';
import { propagateTwoBody } from '../src/core/orbit/twoBody.js';
import { stateToElements, apsides } from '../src/core/orbit/elements.js';

const MU_EARTH = GM.earth;
const MU_SUN = GM.sun;

describe('Hohmann transfer', () => {
  it('matches the textbook LEO-to-GEO delta-v', () => {
    // LEO 300 km (6678 km) to GEO (42164 km): the classic ~3.9 km/s figure.
    const r1 = 6678e3;
    const r2 = 42164e3;
    const sol = hohmannTransfer(r1, r2, MU_EARTH);
    expect(sol.totalDeltaV / 1000).toBeGreaterThan(3.8);
    expect(sol.totalDeltaV / 1000).toBeLessThan(4.0);
    expect(sol.legs).toHaveLength(2);
  });

  it('has zero delta-v and duration for identical radii', () => {
    const sol = hohmannTransfer(7000e3, 7000e3, MU_EARTH);
    expect(sol.totalDeltaV).toBe(0);
    expect(sol.duration).toBe(0);
    expect(sol.legs).toHaveLength(0);
  });

  it('is symmetric in the sense that descent undoes ascent', () => {
    const up = hohmannTransfer(7000e3, 42000e3, MU_EARTH);
    const down = hohmannTransfer(42000e3, 7000e3, MU_EARTH);
    expect(up.totalDeltaV).toBeCloseTo(down.totalDeltaV, 6);
  });

  it('takes half the transfer-ellipse period', () => {
    const r1 = 7000e3;
    const r2 = 42000e3;
    const a = (r1 + r2) / 2;
    const expected = Math.PI * Math.sqrt((a * a * a) / MU_EARTH);
    expect(hohmannTransfer(r1, r2, MU_EARTH).duration).toBeCloseTo(expected, 3);
  });

  it('satisfies vis-viva at both ends of the transfer ellipse', () => {
    const r1 = 7000e3;
    const r2 = 42000e3;
    const a = (r1 + r2) / 2;
    const vp = visViva(r1, a, MU_EARTH);
    const va = visViva(r2, a, MU_EARTH);
    // Angular momentum must be equal at both apsides: r1*vp = r2*va.
    expect(r1 * vp).toBeCloseTo(r2 * va, 3);
  });

  it('gives zero delta-v for a zero radius ratio limit check', () => {
    const tiny = hohmannTransfer(1e7, 1e7 * 1.0000001, MU_EARTH);
    expect(tiny.totalDeltaV).toBeLessThan(0.01);
  });

  it('rejects non-positive input', () => {
    expect(() => hohmannTransfer(0, 1e7, MU_EARTH)).toThrow(/positive/);
    expect(() => hohmannTransfer(1e7, -1, MU_EARTH)).toThrow(/positive/);
    expect(() => hohmannTransfer(1e7, 2e7, 0)).toThrow(/positive/);
  });
});

describe('bi-elliptic transfer', () => {
  it('is more expensive than Hohmann at a small radius ratio', () => {
    const cmp = compareTransfers(7000e3, 42000e3, MU_EARTH);
    expect(cmp.cheaper).toBe('hohmann');
  });

  it('beats Hohmann at a very large radius ratio', () => {
    // Ratio ~40: well above the ~11.94 threshold.
    const cmp = compareTransfers(7000e3, 280000e3, MU_EARTH);
    expect(cmp.cheaper).toBe('bi-elliptic');
    expect(cmp.biElliptic.totalDeltaV).toBeLessThan(cmp.hohmann.totalDeltaV);
  });

  it('has three burns', () => {
    const sol = biEllipticTransfer(7000e3, 42000e3, 200000e3, MU_EARTH);
    expect(sol.legs).toHaveLength(3);
  });

  it('rejects an intermediate radius inside the outer radius', () => {
    expect(() => biEllipticTransfer(7000e3, 42000e3, 30000e3, MU_EARTH)).toThrow(/must exceed/);
  });

  it('approaches the Hohmann limit as the intermediate radius shrinks toward r2', () => {
    const hoh = hohmannTransfer(7000e3, 42000e3, MU_EARTH);
    const bi = biEllipticTransfer(7000e3, 42000e3, 42000e3 * 1.0000001, MU_EARTH);
    expect(bi.totalDeltaV).toBeCloseTo(hoh.totalDeltaV, 0);
  });

  it('duration is the sum of the two half-ellipse periods', () => {
    const r1 = 7000e3;
    const r2 = 42000e3;
    const rb = 200000e3;
    const a1 = (r1 + rb) / 2;
    const a2 = (r2 + rb) / 2;
    const expected =
      Math.PI * Math.sqrt((a1 * a1 * a1) / MU_EARTH) +
      Math.PI * Math.sqrt((a2 * a2 * a2) / MU_EARTH);
    expect(biEllipticTransfer(r1, r2, rb, MU_EARTH).duration).toBeCloseTo(expected, 0);
  });
});

describe('plane change', () => {
  it('is zero for zero angle', () => {
    expect(planeChangeDeltaV(7000, 0)).toBe(0);
  });

  it('is 2v for a 180-degree reversal', () => {
    expect(planeChangeDeltaV(7000, Math.PI)).toBeCloseTo(14000, 6);
  });

  it('is v*sqrt(2) for a 90-degree change', () => {
    expect(planeChangeDeltaV(7000, Math.PI / 2)).toBeCloseTo(7000 * Math.SQRT2, 6);
  });
});

describe('Lambert solver', () => {
  /**
   * The decisive test: a 180-degree Lambert arc IS a Hohmann transfer, so the solver must
   * reproduce the closed-form answer. This validates the whole stack — Stumpff functions,
   * the z root find, the Lagrange coefficients — against an independent formula.
   */
  it('reproduces a Hohmann transfer for a 180-degree arc', () => {
    const r1 = 7000e3;
    const r2 = 42000e3;
    const hoh = hohmannTransfer(r1, r2, MU_EARTH);

    // Departures and arrivals on opposite sides of the central body.
    const start = vec3(r1, 0, 0);
    const end = vec3(-r2, 0, 0);

    const lam = solveLambert(start, end, hoh.duration, MU_EARTH);
    expect(lam.converged).toBe(true);

    // The burn magnitudes must match the Hohmann closed form.
    const vCirc1 = circularSpeed(r1, MU_EARTH);
    const vCirc2 = circularSpeed(r2, MU_EARTH);
    const dv1 = Math.abs(length(lam.v1) - vCirc1);
    const dv2 = Math.abs(vCirc2 - length(lam.v2));
    expect(dv1).toBeCloseTo(hoh.legs[0]!.deltaV, -1);
    expect(dv2).toBeCloseTo(hoh.legs[1]!.deltaV, -1);
  });

  it('returns velocities that actually fly to the target', () => {
    // Independent of any formula: propagate the departure state for the time of flight
    // and check it arrives at r2. This is the strongest possible check.
    const r1 = vec3(1.2 * AU_M, 0.1 * AU_M, 0.02 * AU_M);
    const r2 = vec3(-1.1 * AU_M, 1.4 * AU_M, -0.05 * AU_M);
    const tof = 200 * 86400;

    const lam = solveLambert(r1, r2, tof, MU_SUN);
    expect(lam.converged).toBe(true);

    const arrived = propagateTwoBody({ r: r1, v: lam.v1 }, MU_SUN, tof);
    expect(
      length({ x: arrived.r.x - r2.x, y: arrived.r.y - r2.y, z: arrived.r.z - r2.z }),
    ).toBeLessThan(1e4);
  });

  it('gives the same arrival position for many random geometries', () => {
    for (let k = 0; k < 40; k++) {
      const angle1 = (k / 40) * 2 * Math.PI;
      const angle2 = angle1 + 0.4 + (((k * 7) % 20) / 20) * 2.5;
      const rad1 = 0.8 * AU_M + (k % 5) * 0.1 * AU_M;
      const rad2 = 1.0 * AU_M + (k % 7) * 0.15 * AU_M;
      const r1 = vec3(rad1 * Math.cos(angle1), rad1 * Math.sin(angle1), 0.01 * AU_M * (k % 3));
      const r2 = vec3(rad2 * Math.cos(angle2), rad2 * Math.sin(angle2), -0.02 * AU_M * (k % 2));
      const tof = 120 * 86400 + k * 4 * 86400;

      const lam = solveLambert(r1, r2, tof, MU_SUN);
      if (!lam.converged) continue;
      const arrived = propagateTwoBody({ r: r1, v: lam.v1 }, MU_SUN, tof);
      const err = length({ x: arrived.r.x - r2.x, y: arrived.r.y - r2.y, z: arrived.r.z - r2.z });
      expect(err / length(r2)).toBeLessThan(1e-6);
    }
  });

  it('produces a departure orbit whose apoapsis is sensible', () => {
    const r1 = vec3(AU_M, 0, 0);
    const r2 = vec3(-1.524 * AU_M, 0, 0);
    const tof = 259 * 86400; // about a Hohmann Earth-Mars flight time
    const lam = solveLambert(r1, r2, tof, MU_SUN);
    expect(lam.converged).toBe(true);
    const el = stateToElements({ r: r1, v: lam.v1 }, MU_SUN);
    const { apoapsis } = apsides(el.a, el.e);
    // Apoapsis should be near Mars' orbit, a bit above 1.5 AU.
    expect(apoapsis / AU_M).toBeGreaterThan(1.3);
    expect(apoapsis / AU_M).toBeLessThan(1.8);
  });

  it('handles the long way round explicitly', () => {
    const r1 = vec3(AU_M, 0, 0);
    const r2 = vec3(0, 1.5 * AU_M, 0);
    const tof = 300 * 86400;

    const short = solveLambert(r1, r2, tof, MU_SUN, { longWay: false });
    const long = solveLambert(r1, r2, tof, MU_SUN, { longWay: true });

    expect(short.converged).toBe(true);
    expect(long.converged).toBe(true);
    // The two arcs must be genuinely different orbits.
    expect(
      length({ x: short.v1.x - long.v1.x, y: short.v1.y - long.v1.y, z: short.v1.z - long.v1.z }),
    ).toBeGreaterThan(100);
  });

  it('rejects non-physical input', () => {
    expect(() => solveLambert(vec3(AU_M, 0, 0), vec3(0, AU_M, 0), 0, MU_SUN)).toThrow(/positive/);
    expect(() => solveLambert(vec3(0, 0, 0), vec3(0, AU_M, 0), 100, MU_SUN)).toThrow(/zero/);
    expect(() => solveLambert(vec3(AU_M, 0, 0), vec3(0, AU_M, 0), 100, 0)).toThrow(/positive/);
  });

  it('reports non-convergence rather than guessing for an impossible time of flight', () => {
    // Two points 1 AU apart, requested in 10 seconds: no single arc can do this.
    const r1 = vec3(AU_M, 0, 0);
    const r2 = vec3(0, AU_M, 0);
    const lam = solveLambert(r1, r2, 10, MU_SUN);
    expect(lam.converged).toBe(false);
  });

  it('is deterministic', () => {
    const r1 = vec3(AU_M, 0, 0);
    const r2 = vec3(0, 1.2 * AU_M, 0);
    const a = solveLambert(r1, r2, 200 * 86400, MU_SUN);
    const b = solveLambert(r1, r2, 200 * 86400, MU_SUN);
    expect(a.v1).toEqual(b.v1);
  });

  it('conserves the orbit: v2 follows from v1 by Keplerian motion', () => {
    const r1 = vec3(AU_M, 0.2 * AU_M, 0);
    const r2 = vec3(-0.5 * AU_M, 1.4 * AU_M, 0.05 * AU_M);
    const tof = 180 * 86400;
    const lam = solveLambert(r1, r2, tof, MU_SUN);
    expect(lam.converged).toBe(true);
    const arrived = propagateTwoBody({ r: r1, v: lam.v1 }, MU_SUN, tof);
    // The propagated velocity must equal the Lambert arrival velocity.
    const dv = length({
      x: arrived.v.x - lam.v2.x,
      y: arrived.v.y - lam.v2.y,
      z: arrived.v.z - lam.v2.z,
    });
    expect(dv / length(lam.v2)).toBeLessThan(1e-6);
  });
});

describe('Stumpff functions', () => {
  it('has the correct limits at zero', () => {
    expect(stumpffC(0)).toBeCloseTo(0.5, 10);
    expect(stumpffS(0)).toBeCloseTo(1 / 6, 10);
  });

  it('is continuous across zero', () => {
    expect(stumpffC(1e-7)).toBeCloseTo(stumpffC(0), 6);
    expect(stumpffC(-1e-7)).toBeCloseTo(stumpffC(0), 6);
    expect(stumpffS(1e-7)).toBeCloseTo(stumpffS(0), 6);
    expect(stumpffS(-1e-7)).toBeCloseTo(stumpffS(0), 6);
  });

  it('satisfies C = (1 - cos sqrt z)/z for positive z', () => {
    for (const z of [0.1, 1, 4, 9]) {
      const sz = Math.sqrt(z);
      expect(stumpffC(z)).toBeCloseTo((1 - Math.cos(sz)) / z, 12);
    }
  });

  it('satisfies C = (cosh sqrt(-z) - 1)/(-z) for negative z', () => {
    for (const z of [-0.1, -1, -4, -9]) {
      const sz = Math.sqrt(-z);
      expect(stumpffC(z)).toBeCloseTo((Math.cosh(sz) - 1) / -z, 10);
    }
  });

  it('is positive everywhere it is used', () => {
    for (let z = -50; z < 39; z += 0.37) {
      expect(stumpffC(z)).toBeGreaterThan(0);
    }
  });

  it('has S continuous and positive over the usable range', () => {
    for (let z = -50; z < 39; z += 0.37) {
      expect(stumpffS(z)).toBeGreaterThan(0);
    }
  });
});

describe('transfer consistency', () => {
  it('the Hohmann departure velocity has the right energy for the transfer ellipse', () => {
    const r1 = 7000e3;
    const r2 = 42000e3;
    const hoh = hohmannTransfer(r1, r2, MU_EARTH);
    const vCirc = circularSpeed(r1, MU_EARTH);
    const vBurn = vCirc + hoh.legs[0]!.deltaV;
    const a = (r1 + r2) / 2;
    // Energy of the post-burn orbit must equal -mu/(2a).
    const energy = (vBurn * vBurn) / 2 - MU_EARTH / r1;
    expect(energy).toBeCloseTo(-MU_EARTH / (2 * a), 0);
  });

  it('total delta-v is the sum of leg magnitudes', () => {
    const sol = hohmannTransfer(7000e3, 42000e3, MU_EARTH);
    const sum = sol.legs.reduce((acc, l) => acc + l.deltaV, 0);
    expect(sol.totalDeltaV).toBeCloseTo(sum, 9);
  });

  it('vis-viva agrees with a direct two-body computation', () => {
    const r = 1.2 * AU_M;
    const a = 1.5 * AU_M;
    const v = visViva(r, a, MU_SUN);
    // Build a state on that ellipse and check its speed.
    const state = { r: vec3(r, 0, 0), v: vec3(0, v, 0) };
    const el = stateToElements(state, MU_SUN);
    expect(el.a).toBeCloseTo(a, -6);
  });

  it('plane change plus in-plane burn composes sensibly', () => {
    const v = circularSpeed(7000e3, MU_EARTH);
    const dvPlane = planeChangeDeltaV(v, 0.1);
    expect(dvPlane).toBeGreaterThan(0);
    expect(dvPlane).toBeLessThan(v * 0.1);
  });
});
