/**
 * Closed-form coplanar circular-to-circular transfers.
 *
 * Both Hohmann and bi-elliptic are computed from the vis-viva equation for impulsive
 * burns between circular orbits. These are the analytic reference the app's
 * numerically-planned transfers are sanity-checked against, and they are also exposed
 * directly in the mission tools panel.
 *
 * All quantities are two-body around a single central body of parameter `mu`.
 */

export interface TransferLeg {
  /** Change in speed at this burn, m/s (magnitude). */
  readonly deltaV: number;
  /** Radius at which the burn happens, m. */
  readonly atRadius: number;
  /** Human-readable burn description. */
  readonly label: string;
}

export interface TransferSolution {
  /** Total delta-v, m/s. */
  readonly totalDeltaV: number;
  readonly legs: readonly TransferLeg[];
  /** Time from the first burn to the final arrival, seconds. */
  readonly duration: number;
  /** Radii of any intermediate apsis created (bi-elliptic only). */
  readonly intermediateRadius?: number;
}

/** Circular orbital speed at radius r around `mu`. */
export const circularSpeed = (r: number, mu: number): number => Math.sqrt(mu / r);

/**
 * Speed on an ellipse of semi-major axis `a` at radius `r` (vis-viva).
 * Works for hyperbolic arcs too if `a` is negative.
 */
export const visViva = (r: number, a: number, mu: number): number =>
  Math.sqrt(mu * (2 / r - 1 / a));

/**
 * Hohmann transfer between two circular coplanar orbits.
 * Throws if either radius is not positive or `mu` is not positive.
 */
export function hohmannTransfer(r1: number, r2: number, mu: number): TransferSolution {
  assertPositive(r1, 'r1');
  assertPositive(r2, 'r2');
  assertPositive(mu, 'mu');

  if (r1 === r2) {
    return { totalDeltaV: 0, legs: [], duration: 0 };
  }

  const aTransfer = (r1 + r2) / 2;
  const v1 = circularSpeed(r1, mu);
  const v2 = circularSpeed(r2, mu);

  // Speed on the transfer ellipse at each radius.
  const vPeri = visViva(r1, aTransfer, mu);
  const vApo = visViva(r2, aTransfer, mu);

  const dv1 = Math.abs(vPeri - v1);
  const dv2 = Math.abs(v2 - vApo);

  const duration = Math.PI * Math.sqrt((aTransfer * aTransfer * aTransfer) / mu);

  return {
    totalDeltaV: dv1 + dv2,
    legs: [
      {
        deltaV: dv1,
        atRadius: r1,
        label: r2 > r1 ? 'Departure burn (raise apoapsis)' : 'Departure burn (lower periapsis)',
      },
      {
        deltaV: dv2,
        atRadius: r2,
        label:
          r2 > r1
            ? 'Arrival burn (circularise at apoapsis)'
            : 'Arrival burn (circularise at periapsis)',
      },
    ],
    duration,
  };
}

/**
 * Bi-elliptic transfer through a third, intermediate apsis at `rb`.
 *
 * Beats a Hohmann transfer on total delta-v when the radius ratio is large enough
 * (roughly above 11.94 for rb -> infinity, and above about 15.58 for the optimal finite
 * rb). The returned solution is always valid; whether it is *cheaper* is the caller's
 * question, and {@link compareTransfers} answers it.
 */
export function biEllipticTransfer(
  r1: number,
  r2: number,
  rb: number,
  mu: number,
): TransferSolution {
  assertPositive(r1, 'r1');
  assertPositive(r2, 'r2');
  assertPositive(rb, 'rb');
  assertPositive(mu, 'mu');

  if (rb <= Math.max(r1, r2)) {
    throw new Error(
      `biEllipticTransfer: intermediate radius (${rb}) must exceed both r1 (${r1}) and r2 (${r2})`,
    );
  }

  const v1 = circularSpeed(r1, mu);
  const v2 = circularSpeed(r2, mu);

  const a1 = (r1 + rb) / 2;
  const a2 = (r2 + rb) / 2;

  const vPeri1 = visViva(r1, a1, mu);
  const vApo1 = visViva(rb, a1, mu);
  const vApo2 = visViva(rb, a2, mu);
  const vPeri2 = visViva(r2, a2, mu);

  const dv1 = Math.abs(vPeri1 - v1);
  const dv2 = Math.abs(vApo2 - vApo1);
  const dv3 = Math.abs(v2 - vPeri2);

  const t1 = Math.PI * Math.sqrt((a1 * a1 * a1) / mu);
  const t2 = Math.PI * Math.sqrt((a2 * a2 * a2) / mu);

  return {
    totalDeltaV: dv1 + dv2 + dv3,
    legs: [
      { deltaV: dv1, atRadius: r1, label: 'First burn (raise apoapsis to rb)' },
      { deltaV: dv2, atRadius: rb, label: 'Second burn (raise periapsis to r2)' },
      { deltaV: dv3, atRadius: r2, label: 'Third burn (circularise)' },
    ],
    duration: t1 + t2,
    intermediateRadius: rb,
  };
}

/** Compares Hohmann against the best bi-elliptic transfer for a radius ratio. */
export function compareTransfers(
  r1: number,
  r2: number,
  mu: number,
): {
  hohmann: TransferSolution;
  biElliptic: TransferSolution;
  cheaper: 'hohmann' | 'bi-elliptic';
  saving: number;
} {
  const hohmann = hohmannTransfer(r1, r2, mu);
  // Search a range of intermediate radii for the best bi-elliptic solution.
  let best = biEllipticTransfer(r1, r2, Math.max(r1, r2) * 1.5, mu);
  for (const factor of [1.5, 2, 3, 5, 8, 12, 20, 50, 100, 1000]) {
    try {
      const candidate = biEllipticTransfer(r1, r2, Math.max(r1, r2) * factor, mu);
      if (candidate.totalDeltaV < best.totalDeltaV) best = candidate;
    } catch {
      // Skip invalid geometries rather than failing the whole comparison.
    }
  }
  return {
    hohmann,
    biElliptic: best,
    cheaper: best.totalDeltaV < hohmann.totalDeltaV ? 'bi-elliptic' : 'hohmann',
    saving: Math.abs(hohmann.totalDeltaV - best.totalDeltaV),
  };
}

/**
 * Delta-v required for a plane change by `angle` radians at speed `v`:
 * dv = 2 v sin(angle / 2).
 */
export const planeChangeDeltaV = (v: number, angle: number): number =>
  2 * v * Math.sin(Math.abs(angle) / 2);

function assertPositive(x: number, name: string): void {
  if (!(x > 0) || !Number.isFinite(x)) {
    throw new Error(`${name} must be a positive finite number, got ${x}`);
  }
}
