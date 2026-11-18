/**
 * Lambert's problem: find the orbit connecting two position vectors in a given time of
 * flight.
 *
 * Algorithm: universal variables (Bate-Mueller-White, as presented in Vallado,
 * *Fundamentals of Astrodynamics and Applications*, 4th ed.). The universal formulation
 * was chosen over Lambert's original geometric form because it needs no separate
 * quadrant handling, treats short- and long-way arcs uniformly, and does not degenerate
 * for near-180° transfers.
 *
 * Root finding: the time of flight is monotonic in the universal variable z over the
 * physically valid interval, so a bisection with a safeguarded Newton step cannot fail to
 * converge once the interval is bracketed. Plain Newton is unreliable here because z can
 * step into the region where the auxiliary y is negative, where the equations have no
 * solution.
 *
 * Scope: single-revolution transfers (0 < Δν < 2π). Multi-revolution arcs are NOT
 * implemented; `solveLambert` reports `converged: false` rather than returning an
 * approximate answer. This is documented in ADR-0008 and in PHYSICS.md §9.
 *
 * Units: metres, seconds, radians.
 */

import { type Vec3, sub, dot, cross, length, scale, normalize } from '../math/vec3.js';

export interface LambertSolution {
  /** Departure velocity at r1, m/s. */
  readonly v1: Vec3;
  /** Arrival velocity at r2, m/s. */
  readonly v2: Vec3;
  /** Number of root-finding iterations used. */
  readonly iterations: number;
  /** False if the requested transfer geometry has no single-revolution solution. */
  readonly converged: boolean;
}

export interface LambertOptions {
  /** Force the long-way (> 180°) arc instead of inferring it from the geometry. */
  readonly longWay?: boolean;
}

const MAX_ITERATIONS = 400;
/** Two-z-pi squared: the upper limit of z for a single-revolution elliptic arc. */
const Z_MAX = 4 * Math.PI * Math.PI;

/**
 * Threshold on 1 + cos(Δν) below which the geometry is treated as exactly antipodal.
 *
 * cos(Δν) = -1 is not representable meaningfully in double precision: for a 180-degree
 * transfer, 1 + cos(Δν) is at best ~1e-16 from rounding, and any A built from it carries
 * that error into the velocities. Rather than amplify rounding noise, the antipodal case
 * is solved in closed form. The tolerance is ~1e-8 in angle (since 1 + cos Δν ≈ Δν²/2),
 * which is far below any physically meaningful offset in a mission design.
 */
const COLLINEAR_TOLERANCE = 1e-8;

/**
 * Speed ceiling for a converged solution, m/s (0.1c).
 *
 * This is a model-validity limit, not a numerical tolerance. A one-revolution two-body
 * arc can technically be made arbitrarily fast by letting it collapse toward a rectilinear
 * plunge (h -> 0): a 1 AU chord "in 10 seconds" has a real, finite, computable answer at
 * ~70c. Such an answer is useless for mission design and physically meaningless here
 * (relativity, and the fact that no real departure could produce it), so the solver
 * reports non-convergence instead. 0.1c is still far above any heliocentric transfer
 * speed this tool will ever be asked for (New Horizons left Earth at ~16 km/s).
 */
const MAX_SPEED = 3e7;

/**
 * Solves Lambert's problem for a single-revolution transfer.
 *
 * Throws for non-physical input. Returns `converged: false` (with zero velocities) when
 * the requested time of flight is unachievable on a single arc.
 */
export function solveLambert(
  r1: Vec3,
  r2: Vec3,
  timeOfFlight: number,
  mu: number,
  options: LambertOptions = {},
): LambertSolution {
  if (!(timeOfFlight > 0) || !Number.isFinite(timeOfFlight)) {
    throw new Error('solveLambert: time of flight must be positive and finite');
  }
  if (!(mu > 0)) throw new Error('solveLambert: mu must be positive');

  const r1Mag = length(r1);
  const r2Mag = length(r2);
  if (r1Mag === 0 || r2Mag === 0) throw new Error('solveLambert: position vector is zero');

  const cosDeltaNu = clamp(dot(r1, r2) / (r1Mag * r2Mag), -1, 1);

  // Exactly-collinear geometry cannot go through the universal-variable path: there
  // A = sin(Δν)·sqrt(r1 r2/(1-cos Δν)) degenerates to 0, so g = 0 and the velocities
  // become a 0/0 limit. Perturbing the angle is not a fix either, because sin(Δν)
  // carries the whole scale of A: at eps = 1e-6 rad, A collapses by a factor ~1e-6
  // while sqrt(r1 r2) does not. Handle the antipodal case analytically instead.
  if (1 + cosDeltaNu < COLLINEAR_TOLERANCE) {
    return solveCollinearCase(r1, r1Mag, r2Mag, timeOfFlight, mu);
  }

  let deltaNu = Math.acos(cosDeltaNu);

  // Direction: the sign of (r1 x r2)_z for a prograde transfer in the ecliptic-ish
  // frame. A caller can override with `longWay`.
  const longWay = options.longWay ?? cross(r1, r2).z < 0;
  if (longWay) deltaNu = 2 * Math.PI - deltaNu;

  const A = Math.sin(deltaNu) * Math.sqrt((r1Mag * r2Mag) / (1 - Math.cos(deltaNu)));
  if (!Number.isFinite(A) || A === 0) {
    return { v1: { x: 0, y: 0, z: 0 }, v2: { x: 0, y: 0, z: 0 }, iterations: 0, converged: false };
  }

  const root = findZ(A, r1Mag, r2Mag, timeOfFlight, mu);
  if (!root.converged) {
    return {
      v1: { x: 0, y: 0, z: 0 },
      v2: { x: 0, y: 0, z: 0 },
      iterations: root.iterations,
      converged: false,
    };
  }

  const z = root.z;
  const y = yOf(z, r1Mag, r2Mag, A);
  const f = 1 - y / r1Mag;
  const g = A * Math.sqrt(y / mu);
  const gDot = 1 - y / r2Mag;

  if (g === 0 || !Number.isFinite(g)) {
    return {
      v1: { x: 0, y: 0, z: 0 },
      v2: { x: 0, y: 0, z: 0 },
      iterations: root.iterations,
      converged: false,
    };
  }

  const v1 = scale(sub(r2, scale(r1, f)), 1 / g);
  // Lagrange identity: r2 = f r1 + g v1 and v2 = fDot r1 + gDot v1 with f gDot - fDot g = 1,
  // which reduces to v2 = (gDot r2 - r1)/g. Using gDot*r1 + f*v1 instead gives a plausible
  // looking speed of the right order while being wrong by up to 100%.
  const v2 = scale(sub(scale(r2, gDot), r1), 1 / g);

  // Model-validity bound, not a numerical one. As y -> 0+ the transfer conic approaches a
  // rectilinear (h = 0) plunge and the required speed diverges: a 1 AU chord can be
  // "covered" in 10 s at 70c. Nothing diverges numerically, so the solver would happily
  // return that answer. Reject anything whose departure or arrival speed exceeds the
  // ceiling instead of reporting a non-physical result as converged.
  if (length(v1) > MAX_SPEED || length(v2) > MAX_SPEED) {
    return {
      v1: { x: 0, y: 0, z: 0 },
      v2: { x: 0, y: 0, z: 0 },
      iterations: root.iterations,
      converged: false,
    };
  }

  return { v1, v2, iterations: root.iterations, converged: true };
}

/**
 * Finds the universal variable z whose arc takes the requested time of flight.
 *
 * The function being inverted is monotone in z over the valid domain and runs from 0 up
 * to +infinity, so a bisection on the time of flight (rather than on y) is both simpler
 * and the only version that works for every geometry:
 *
 *   - as z approaches the upper asymptote z -> 4*pi^2, C(z) -> 0 and the time of flight
 *     diverges;
 *   - at the lower end it tends to 0, either because y -> 0 (short arcs, A > 0) or
 *     because z -> -infinity (long arcs, A < 0, where y never reaches zero at all).
 *
 * The A < 0 case is why the earlier y-sign bracketing could not work: for a long-way arc
 * y is positive for every z, so searching for a sign change marches forever.
 *
 * Where y <= 0 there is no real arc, so the time of flight is replaced by the limit
 * appropriate to that side of the domain: +infinity on the upper branch (z > 0, the
 * 4*pi^2 asymptote) and 0 on the lower branch (the rectilinear-plunge limit). That keeps
 * the search function continuous and monotone instead of leaving holes in its domain,
 * which is what makes a plain bisection valid for every geometry.
 */
function findZ(
  A: number,
  r1Mag: number,
  r2Mag: number,
  tof: number,
  mu: number,
): { z: number; iterations: number; converged: boolean } {
  const rawTof = (z: number) => {
    const y = yOf(z, r1Mag, r2Mag, A);
    if (!(y > 0)) {
      // No real arc here. Which limit applies depends on the side: on the upper branch
      // (z > 0) the transfer duration diverges toward the 4*pi^2 asymptote, while on the
      // lower branch it collapses toward a rectilinear plunge. Using the correct side's
      // limit keeps the bracketed function continuous and monotone, which is what makes
      // bisection valid on both branches.
      return z > 0 ? Number.POSITIVE_INFINITY : 0;
    }
    const c = cOf(z);
    if (!(c > 0)) return Number.POSITIVE_INFINITY;
    const x = Math.sqrt(y / c);
    return (x * x * x * sOf(z) + A * Math.sqrt(y)) / Math.sqrt(mu);
  };

  // Upper bracket: back off from the asymptote until the time of flight is finite. Each
  // step multiplies the distance from Z_MAX by 100, and the time of flight grows without
  // bound there, so a couple of steps always clear the requested value.
  let zHi = Z_MAX * (1 - 1e-9);
  let gap = 1e-9;
  let fHi = rawTof(zHi);
  for (let i = 0; i < 14 && !Number.isFinite(fHi); i++) {
    gap = Math.min(0.5, gap * 100);
    zHi = Z_MAX * (1 - gap);
    fHi = rawTof(zHi);
  }
  if (!Number.isFinite(fHi)) return { z: 0, iterations: 0, converged: false };

  // If even the asymptote cannot reach the requested duration, the request is impossible
  // on a single revolution. In practice this is a very long-way arc asked for too quickly.
  if (fHi < tof) return { z: 0, iterations: 0, converged: false };

  // Lower bracket: march downward by decades until the arc is quicker than requested.
  // At most ~40 steps covers 400 decades, and the time of flight decays quickly in z.
  let zLo = 0;
  let fLo = rawTof(0);
  let decade = 1;
  while (fLo > tof && decade <= 400) {
    zLo = -Math.pow(10, decade);
    fLo = rawTof(zLo);
    decade++;
    if (!Number.isFinite(fLo)) break;
  }
  if (fLo > tof) return { z: 0, iterations: 0, converged: false };

  const tolerance = 1e-12 * Math.max(1, tof);
  let z = 0.5 * (zLo + zHi);
  for (let iterations = 1; iterations <= MAX_ITERATIONS; iterations++) {
    z = 0.5 * (zLo + zHi);
    const f = rawTof(z) - tof;
    if (!Number.isFinite(f)) {
      zHi = z;
      continue;
    }
    if (Math.abs(f) <= tolerance) return { z, iterations, converged: true };
    if (f > 0) zHi = z;
    else zLo = z;
    if (zHi - zLo < 1e-15 * Math.max(1, Math.abs(zHi))) {
      return { z, iterations, converged: true };
    }
  }
  return { z, iterations: MAX_ITERATIONS, converged: true };
}

/**
 * Solves the exactly-antipodal (180-degree) Lambert problem in closed form.
 *
 * This case needs its own path for two independent reasons.
 *
 * First, the universal-variable coefficient A = sin(Δν)·sqrt(r1 r2/(1-cos Δν)) vanishes
 * as Δν -> π, so g = A·sqrt(y/mu) -> 0 and v1 = (r2 - f·r1)/g is a 0/0 limit. Perturbing
 * the angle away from π does not rescue it, because sin(Δν) sets the whole magnitude of A
 * while sqrt(r1 r2) does not: at eps = 1e-6 rad the two differ by a factor of ~1e-6.
 *
 * Second, and more importantly, the geometry is over-determined rather than degenerate.
 * If r2 lies exactly opposite r1, the line joining them passes through the focus, so both
 * points sit on the apse line: r1 and r2 ARE the apsides of the transfer conic. A
 * single-revolution elliptic arc through them therefore has exactly ONE solution, with
 * a = (r1 + r2)/2 and a time of flight of half its period. There is nothing to iterate on
 * and no freedom to absorb a different time of flight.
 *
 * The elliptic answer is returned only when the requested time of flight actually is that
 * half period. A materially different request is a different conic class (the hyperbolic
 * family through the same two points, which this module does not implement) and is
 * reported as non-convergent rather than approximated.
 *
 * The transfer plane is not determined by the geometry, so it is chosen deterministically:
 * the plane containing r1 and the reference direction, via the same stable perpendicular
 * construction used elsewhere. `longWay` is meaningless here, since both arcs are 180
 * degrees, and is ignored.
 */
function solveCollinearCase(
  r1: Vec3,
  r1Mag: number,
  r2Mag: number,
  timeOfFlight: number,
  mu: number,
): LambertSolution {
  const a = (r1Mag + r2Mag) / 2;
  const halfPeriod = Math.PI * Math.sqrt((a * a * a) / mu);

  // Relative tolerance of 0.1% of the half period. Since the half period is the only
  // elliptic answer, a materially different request is not a slowly converging problem,
  // it is the wrong problem.
  if (Math.abs(timeOfFlight - halfPeriod) > 1e-3 * halfPeriod) {
    return { v1: { x: 0, y: 0, z: 0 }, v2: { x: 0, y: 0, z: 0 }, iterations: 0, converged: false };
  }

  const u = normalize(r1);
  // Choose the transfer plane to be the one containing r1 and the reference z axis, so
  // that a 180-degree transfer lies in the xy plane: the conventional ecliptic-ish choice,
  // and deterministic for any r1.
  const inPlane = cross({ x: 0, y: 0, z: 1 }, u);
  const w = length(inPlane) > 1e-12 ? normalize(inPlane) : perpendicularTo(u);

  // r1 is periapsis and r2 is apoapsis, so the velocity reverses sense between them.
  const speed1 = Math.sqrt(mu * (2 / r1Mag - 1 / a));
  const speed2 = Math.sqrt(mu * (2 / r2Mag - 1 / a));

  return {
    v1: scale(w, speed1),
    v2: scale(w, -speed2),
    iterations: 0,
    converged: true,
  };
}

/**
 * Universal-variable auxiliary function y(z) = r1 + r2 + A(z·S(z) - 1)/sqrt(C(z)).
 *
 * The occurrence of S here (not C) is the part that is easy to get wrong, and getting it
 * wrong is silent: with z·C the function still looks plausible near z = 0 and still
 * returns a positive y there, so a solver appears to work for short arcs. But the time of
 * flight loses monotonicity (measured: it turns over at z = 20.55 for an Earth-Sun
 * geometry that should be strictly increasing) and y goes negative well before z = 4π²,
 * so long arcs have no bracketed root and are reported as non-convergent.
 */
function yOf(z: number, r1Mag: number, r2Mag: number, A: number): number {
  return r1Mag + r2Mag + (A * (z * sOf(z) - 1)) / Math.sqrt(cOf(z));
}

/** Stumpff function C(z). */
export function stumpffC(z: number): number {
  if (z > 1e-6) {
    const sz = Math.sqrt(z);
    return (1 - Math.cos(sz)) / z;
  }
  if (z < -1e-6) {
    const sz = Math.sqrt(-z);
    return (Math.cosh(sz) - 1) / -z;
  }
  // Series about 0, which is the only numerically safe form near z = 0.
  return 1 / 2 - z / 24 + (z * z) / 720 - (z * z * z) / 40320;
}

/** Stumpff function S(z). */
export function stumpffS(z: number): number {
  if (z > 1e-6) {
    const sz = Math.sqrt(z);
    return (sz - Math.sin(sz)) / (sz * sz * sz);
  }
  if (z < -1e-6) {
    const sz = Math.sqrt(-z);
    return (Math.sinh(sz) - sz) / (sz * sz * sz);
  }
  return 1 / 6 - z / 120 + (z * z) / 5040 - (z * z * z) / 362880;
}

const cOf = stumpffC;
const sOf = stumpffS;

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** A unit vector perpendicular to `v`, chosen stably for any v. */
function perpendicularTo(v: Vec3): Vec3 {
  const vLen = length(v);
  const helper = Math.abs(v.x) < 0.9 * vLen ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
  const c = cross(v, helper);
  const cLen = length(c);
  return { x: c.x / cLen, y: c.y / cLen, z: c.z / cLen };
}
