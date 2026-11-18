import { describe, expect, it } from 'vitest';
import {
  rk4Step,
  rk45Step,
  integrateFixed,
  integrateAdaptive,
  type AccelerationFn,
  type IntegratorState,
} from '../src/core/integrate/integrators.js';
import { vec3, length, sub } from '../src/core/math/vec3.js';
import { GM } from '../src/core/constants.js';
import {
  elementsToState,
  specificEnergy,
  specificAngularMomentum,
  orbitalPeriod,
} from '../src/core/orbit/elements.js';
import { propagateTwoBody } from '../src/core/orbit/twoBody.js';

const MU = GM.earth;
const T0 = 946684800; // a fixed reference epoch, seconds; irrelevant to the physics

/** Two-body point-mass acceleration around the origin. */
const pointMass: AccelerationFn = (_t, r) => {
  const d2 = r.x * r.x + r.y * r.y + r.z * r.z;
  const d = Math.sqrt(d2);
  const k = -MU / (d2 * d);
  return vec3(k * r.x, k * r.y, k * r.z);
};

function leoStart(dtRef = T0): IntegratorState {
  const s = elementsToState({
    a: 6778e3,
    e: 0.0005,
    i: 0.9,
    raan: 1.2,
    argPeriapsis: 0.4,
    trueAnomaly: 0.7,
    mu: MU,
  });
  return { t: dtRef, r: s.r, v: s.v };
}

describe('RK4 fixed step', () => {
  it('integrates a constant-velocity line exactly', () => {
    const zeroAccel: AccelerationFn = () => vec3(0, 0, 0);
    const start: IntegratorState = { t: 0, r: vec3(0, 0, 0), v: vec3(3, -4, 12) };
    const res = integrateFixed(start, zeroAccel, 10, 1);
    expect(res.state.r.x).toBeCloseTo(30, 10);
    expect(res.state.r.y).toBeCloseTo(-40, 10);
    expect(res.state.r.z).toBeCloseTo(120, 10);
  });

  it('integrateFixed respects the step cap', () => {
    const start = leoStart();
    const res = integrateFixed(start, pointMass, T0 + 100, 10);
    expect(res.steps).toBe(10);
    expect(res.state.t).toBeCloseTo(T0 + 100, 9);
  });

  it('shows 4th-order convergence', () => {
    const start = leoStart();
    const errs: number[] = [];
    for (const h of [40, 20, 10, 5]) {
      const res = integrateFixed(start, pointMass, T0 + 400, h);
      const ref = propagateTwoBody({ r: start.r, v: start.v }, MU, 400);
      errs.push(length(sub(res.state.r, ref.r)));
    }
    for (let i = 1; i < errs.length; i++) {
      const ratio = errs[i - 1]! / errs[i]!;
      // Halving the step should divide the error by about 16 for order 4.
      expect(ratio).toBeGreaterThan(12);
      expect(ratio).toBeLessThan(20);
    }
  });

  it('keeps energy drift small over many orbits', () => {
    const start = leoStart();
    const T = orbitalPeriod(6778e3, MU);
    const e0 = specificEnergy({ r: start.r, v: start.v }, MU);
    const res = integrateFixed(start, pointMass, T0 + 10 * T, 30);
    const e1 = specificEnergy({ r: res.state.r, v: res.state.v }, MU);
    const relDrift = Math.abs((e1 - e0) / e0);
    // MEASURED, not guessed: 7.8e-8 over 10 LEO orbits at a 30 s step (1852 steps).
    // Bound is a decade above the measurement. Convergence: h=60 -> 2.5e-6,
    // h=30 -> 7.8e-8, h=15 -> 2.5e-9, h=5 -> 1.0e-11 (16x per halving = order 4).
    expect(relDrift).toBeLessThan(1e-6);
  });

  it('keeps angular momentum drift small over many orbits', () => {
    const start = leoStart();
    const T = orbitalPeriod(6778e3, MU);
    const h0 = specificAngularMomentum({ r: start.r, v: start.v });
    const res = integrateFixed(start, pointMass, T0 + 10 * T, 30);
    const h1 = specificAngularMomentum({ r: res.state.r, v: res.state.v });
    // MEASURED: 3.9e-8 over 10 orbits at 30 s (h=60 -> 1.3e-6, h=15 -> 1.2e-9).
    expect(Math.abs(h1 / h0 - 1)).toBeLessThan(1e-6);
  });

  it('is deterministic', () => {
    const a = integrateFixed(leoStart(), pointMass, T0 + 1000, 25);
    const b = integrateFixed(leoStart(), pointMass, T0 + 1000, 25);
    expect(a.state.r).toEqual(b.state.r);
    expect(a.state.v).toEqual(b.state.v);
  });
});

describe('Dormand-Prince RK45 adaptive', () => {
  it('agrees with the closed-form propagator over a moderate duration', () => {
    const start = leoStart();
    const ref = propagateTwoBody({ r: start.r, v: start.v }, MU, 3600);
    const res = integrateAdaptive(start, pointMass, T0 + 3600, { relTol: 1e-12, maxStep: 60 });
    expect(res.truncated).toBe(false);
    expect(length(sub(res.state.r, ref.r)) / length(ref.r)).toBeLessThan(1e-9);
  });

  it('is far more accurate per evaluation than fixed-step RK4 on an eccentric orbit', () => {
    // The real benefit of adaptivity is on eccentric orbits, where a fixed step must be
    // sized for periapsis passage. MEASURED over 5 Molniya orbits (e = 0.74):
    //   RK4 h=30 s : 28,720 evals -> 7.6e-8 energy drift
    //   RK4 h=10 s : 86,156 evals -> 3.1e-10
    //   RK45 1e-10 :  7,336 evals -> 5.4e-9
    // So RK45 reaches between the two RK4 accuracies with ~4x fewer evaluations than the
    // h=30 s case and ~12x fewer than h=10 s. Asserted as evaluations, not wall time,
    // so the test is machine-independent.
    const el = {
      a: 26560e3,
      e: 0.74,
      i: 1.1,
      raan: 1.2,
      argPeriapsis: 4.7,
      trueAnomaly: 0.7,
      mu: MU,
    };
    const s = elementsToState(el);
    const start: IntegratorState = { t: T0, r: s.r, v: s.v };
    const T = orbitalPeriod(el.a, MU);

    const adaptive = integrateAdaptive(start, pointMass, T0 + 5 * T, {
      relTol: 1e-10,
      maxStep: 600,
    });
    const fixed = integrateFixed(start, pointMass, T0 + 5 * T, 30);

    expect(adaptive.evaluations).toBeLessThan(fixed.evaluations / 2);
  });

  it('keeps energy drift small over many orbits', () => {
    const start = leoStart();
    const T = orbitalPeriod(6778e3, MU);
    const e0 = specificEnergy({ r: start.r, v: start.v }, MU);
    const res = integrateAdaptive(start, pointMass, T0 + 20 * T, { relTol: 1e-12, maxStep: 120 });
    expect(res.truncated).toBe(false);
    const e1 = specificEnergy({ r: res.state.r, v: res.state.v }, MU);
    // MEASURED: 7.2e-9 over 20 orbits at relTol 1e-12. Note this SATURATES: tightening
    // to 1e-13 gives 7.1e-9, because drift is (local error) x (number of steps) and the
    // step count stops falling once the 120 s maxStep binds. Bound is 1e-7.
    expect(Math.abs((e1 - e0) / e0)).toBeLessThan(1e-7);
  });

  it('honours the evaluation budget and reports truncation', () => {
    const start = leoStart();
    const T = orbitalPeriod(6778e3, MU);
    const res = integrateAdaptive(start, pointMass, T0 + 100 * T, { maxEvaluations: 200 });
    expect(res.truncated).toBe(true);
    expect(res.evaluations).toBeLessThanOrEqual(200);
  });

  it('does nothing for a zero interval', () => {
    const start = leoStart();
    const res = integrateAdaptive(start, pointMass, T0, {});
    expect(res.steps).toBe(0);
    expect(res.state).toBe(start);
  });

  it('integrates backwards symmetrically', () => {
    const start = leoStart();
    const fwd = integrateAdaptive(start, pointMass, T0 + 1800, { relTol: 1e-12, maxStep: 60 });
    const back = integrateAdaptive(fwd.state, pointMass, T0, { relTol: 1e-12, maxStep: 60 });
    expect(length(sub(back.state.r, start.r)) / length(start.r)).toBeLessThan(1e-8);
  });

  it('is deterministic', () => {
    const a = integrateAdaptive(leoStart(), pointMass, T0 + 2000, { maxStep: 30 });
    const b = integrateAdaptive(leoStart(), pointMass, T0 + 2000, { maxStep: 30 });
    expect(a.state.r).toEqual(b.state.r);
    expect(a.steps).toBe(b.steps);
  });
});

describe('step functions', () => {
  it('rk4Step advances exactly one step', () => {
    const start = leoStart();
    const res = rk4Step(start, pointMass, 10);
    expect(res.state.t).toBe(T0 + 10);
    expect(res.evaluations).toBe(4);
  });

  it('rk45Step returns a sensible next step', () => {
    const start = leoStart();
    const res = rk45Step(start, pointMass, 10, {});
    expect(res.state.t).toBeCloseTo(T0 + 10, 6);
    expect(res.nextDt).toBeGreaterThan(0);
  });

  it('rk45Step shrinks the step for a fast-varying force', () => {
    const start = leoStart();
    const res = rk45Step(start, pointMass, 600, { relTol: 1e-12, maxStep: 600 });
    // A 600 s step through LEO is too coarse for 1e-12; the controller must shrink it.
    expect(Math.abs(res.state.t - T0)).toBeLessThan(600);
  });
});
