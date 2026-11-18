/**
 * Numerical integrators for arbitrary force functions.
 *
 * A force function has the signature `(t, r, v) => a`, where `t` is seconds from the
 * caller's chosen reference epoch, `r` is position (m), `v` is velocity (m/s) and the
 * return value is acceleration (m/s²). Integrators integrate a state of position and
 * velocity only (no mass: spacecraft are test particles).
 *
 * Both integrators are pure and deterministic: the same inputs produce bit-identical
 * outputs. Neither reads a clock.
 */

import { type Vec3, vec3 } from '../math/vec3.js';

export interface IntegratorState {
  readonly t: number;
  readonly r: Vec3;
  readonly v: Vec3;
}

export type AccelerationFn = (t: number, r: Vec3, v: Vec3) => Vec3;

export interface IntegratorOptions {
  /** Absolute position tolerance in metres for the adaptive controller. */
  readonly absTol?: number;
  /** Relative tolerance for the adaptive controller. */
  readonly relTol?: number;
  /** Largest step the adaptive controller may take, seconds. */
  readonly maxStep?: number;
  /** Smallest step the adaptive controller may take, seconds. */
  readonly minStep?: number;
}

export interface StepResult {
  readonly state: IntegratorState;
  /** Suggested next step size for adaptive integrators; equals the input step otherwise. */
  readonly nextDt: number;
  /** Number of force evaluations consumed by this step. */
  readonly evaluations: number;
}

export const DEFAULT_ABS_TOL = 1e-3; // 1 mm
export const DEFAULT_REL_TOL = 1e-11;
export const DEFAULT_MAX_STEP = 3600;
export const DEFAULT_MIN_STEP = 1e-6;

/** Fixed-step classical Runge-Kutta 4. */
export function rk4Step(state: IntegratorState, accel: AccelerationFn, dt: number): StepResult {
  const { t, r, v } = state;

  const a1 = accel(t, r, v);

  const r2 = addScaled(r, v, dt / 2);
  const v2 = addScaled(v, a1, dt / 2);
  const a2 = accel(t + dt / 2, r2, v2);

  const r3 = addScaled(r, v2, dt / 2);
  const v3 = addScaled(v, a2, dt / 2);
  const a3 = accel(t + dt / 2, r3, v3);

  const r4 = addScaled(r, v3, dt);
  const v4 = addScaled(v, a3, dt);
  const a4 = accel(t + dt, r4, v4);

  const rNew = combine(r, v, v2, v3, v4, dt);
  const vNew = combine(v, a1, a2, a3, a4, dt);

  return { state: { t: t + dt, r: rNew, v: vNew }, nextDt: dt, evaluations: 4 };
}

/**
 * Dormand-Prince 5(4) tableau. Rows give the stage coefficients `a`, `c` gives the
 * stage times, `b` the 5th-order weights and `e = b - b̂` the embedded error weights.
 * Reference: Dormand & Prince (1980), also Hairer, Nørsett & Wanner, *Solving ODEs I*,
 * Table 5.2. FSAL is exploited by reusing the last stage as the first of the next step.
 */
const DP_A: ReadonlyArray<readonly number[]> = [
  [],
  [1 / 5],
  [3 / 40, 9 / 40],
  [44 / 45, -56 / 15, 32 / 9],
  [19372 / 6561, -25360 / 2187, 64448 / 6561, -212 / 729],
  [9017 / 3168, -355 / 33, 46732 / 5247, 49 / 176, -5103 / 18656],
  [35 / 384, 0, 500 / 1113, 125 / 192, -2187 / 6784, 11 / 84],
];
const DP_C: readonly number[] = [0, 1 / 5, 3 / 10, 4 / 5, 8 / 9, 1, 1];
const DP_B: readonly number[] = DP_A[6]!;
const DP_E: readonly number[] = [
  71 / 57600,
  0,
  -71 / 16695,
  71 / 1920,
  -17253 / 339200,
  22 / 525,
  -1 / 40,
];

interface Stage {
  readonly r: Vec3;
  readonly v: Vec3;
  readonly a: Vec3;
}

/**
 * One adaptive Dormand-Prince RK45 step with step-size control. If the error estimate
 * is unacceptable the step is retried smaller (bounded number of retries), and if it
 * still fails the step is accepted so the integration always terminates.
 */
export function rk45Step(
  state: IntegratorState,
  accel: AccelerationFn,
  dt: number,
  options: IntegratorOptions = {},
): StepResult {
  const absTol = options.absTol ?? DEFAULT_ABS_TOL;
  const relTol = options.relTol ?? DEFAULT_REL_TOL;
  const maxStep = options.maxStep ?? DEFAULT_MAX_STEP;
  const minStep = options.minStep ?? DEFAULT_MIN_STEP;

  let h = Math.min(Math.abs(dt), maxStep) * Math.sign(dt || 1);
  let evaluations = 0;

  for (let attempt = 0; attempt < 12; attempt++) {
    const { t, r, v } = state;
    const stages: Stage[] = [];

    // Stage 0 and stages 1..5 come from the tableau; stage 6 uses the 5th-order
    // solution itself (first-same-as-last).
    stages.push({ r, v, a: accel(t, r, v) });
    evaluations++;

    for (let i = 1; i <= 5; i++) {
      let ri = r;
      let vi = v;
      const row = DP_A[i]!;
      for (let j = 0; j < i; j++) {
        const c = row[j] ?? 0;
        if (c === 0) continue;
        const prev = stages[j]!;
        ri = addScaled(ri, prev.v, h * c);
        vi = addScaled(vi, prev.a, h * c);
      }
      const ti = t + h * DP_C[i]!;
      stages.push({ r: ri, v: vi, a: accel(ti, ri, vi) });
      evaluations++;
    }

    let r5 = r;
    let v5 = v;
    for (let j = 0; j < 6; j++) {
      const b = DP_B[j]!;
      const s = stages[j]!;
      r5 = addScaled(r5, s.v, h * b);
      v5 = addScaled(v5, s.a, h * b);
    }

    const a6 = accel(t + h, r5, v5);
    evaluations++;
    stages.push({ r: r5, v: v5, a: a6 });

    let errR = vec3(0, 0, 0);
    let errV = vec3(0, 0, 0);
    for (let j = 0; j < 7; j++) {
      const e = DP_E[j]!;
      const s = stages[j]!;
      errR = addScaled(errR, s.v, h * e);
      errV = addScaled(errV, s.a, h * e);
    }

    const scaleR = absTol + relTol * Math.max(len(r), len(r5));
    const scaleV = absTol + relTol * Math.max(len(v), len(v5));
    const err = Math.max(len(errR) / scaleR, len(errV) / scaleV);

    const safety = 0.9;
    if (err <= 1 || Math.abs(h) <= minStep * 1.001) {
      const factor = err === 0 ? 5 : Math.min(5, Math.max(0.2, safety * Math.pow(err, -0.2)));
      return {
        state: { t: t + h, r: r5, v: v5 },
        nextDt: Math.sign(h) * Math.max(minStep, Math.min(maxStep, Math.abs(h) * factor)),
        evaluations,
      };
    }

    // Reject: shrink and retry.
    const shrink = Math.max(0.2, safety * Math.pow(err, -0.25));
    h *= shrink;
  }

  // Should be unreachable: a step at minStep is always accepted above.
  throw new Error('rk45Step: step-size control failed to converge');
}

/** Integrates from `start.t` to `t1` with fixed RK4 steps of at most `maxStep`. */
export function integrateFixed(
  start: IntegratorState,
  accel: AccelerationFn,
  t1: number,
  maxStep: number,
): { state: IntegratorState; steps: number; evaluations: number } {
  let state = start;
  let steps = 0;
  let evaluations = 0;

  const remaining = t1 - start.t;
  if (remaining === 0) return { state, steps, evaluations };

  const stepCount = Math.ceil(Math.abs(remaining) / maxStep);
  const h = remaining / stepCount;

  for (let i = 0; i < stepCount; i++) {
    const res = rk4Step(state, accel, h);
    state = res.state;
    evaluations += res.evaluations;
    steps++;
  }
  return { state, steps, evaluations };
}

export interface AdaptiveResult {
  readonly state: IntegratorState;
  readonly steps: number;
  readonly evaluations: number;
  /** True if the integration stopped early because the evaluation budget ran out. */
  readonly truncated: boolean;
}

/**
 * Integrates from `start.t` to `t1` with adaptive RK45, honouring a hard limit on
 * force evaluations so a caller cannot wedge the frame loop.
 */
export function integrateAdaptive(
  start: IntegratorState,
  accel: AccelerationFn,
  t1: number,
  options: IntegratorOptions & { maxEvaluations?: number } = {},
): AdaptiveResult {
  const maxEvaluations = options.maxEvaluations ?? Number.POSITIVE_INFINITY;
  const minStep = options.minStep ?? DEFAULT_MIN_STEP;
  const direction = Math.sign(t1 - start.t);

  let state = start;
  let steps = 0;
  let evaluations = 0;
  let dt = options.maxStep ?? DEFAULT_MAX_STEP;

  if (direction === 0) return { state, steps, evaluations, truncated: false };

  while ((t1 - state.t) * direction > 0) {
    const remaining = Math.abs(t1 - state.t);
    if (remaining <= minStep) {
      // Finish with a small fixed step rather than chasing a vanishing interval.
      const res = rk4Step(state, accel, t1 - state.t);
      state = res.state;
      evaluations += res.evaluations;
      steps++;
      break;
    }
    if (evaluations + 7 > maxEvaluations) {
      return { state, steps, evaluations, truncated: true };
    }
    const stepSize = Math.min(Math.abs(dt), remaining) * direction;
    const res = rk45Step(state, accel, stepSize, options);
    evaluations += res.evaluations;
    steps++;
    state = res.state;
    dt = res.nextDt;
  }

  return { state, steps, evaluations, truncated: false };
}

function combine(p0: Vec3, k1: Vec3, k2: Vec3, k3: Vec3, k4: Vec3, h: number): Vec3 {
  return vec3(
    p0.x + (h / 6) * (k1.x + 2 * k2.x + 2 * k3.x + k4.x),
    p0.y + (h / 6) * (k1.y + 2 * k2.y + 2 * k3.y + k4.y),
    p0.z + (h / 6) * (k1.z + 2 * k2.z + 2 * k3.z + k4.z),
  );
}

function addScaled(a: Vec3, b: Vec3, s: number): Vec3 {
  return vec3(a.x + b.x * s, a.y + b.y * s, a.z + b.z * s);
}

const len = (v: Vec3): number => Math.hypot(v.x, v.y, v.z);
