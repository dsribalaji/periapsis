/**
 * Small bodies: dwarf planets, asteroids and comets, from JPL's Small-Body Database.
 *
 * Kept apart from `BODIES` on purpose. The planets and the Moon feed the restricted N-body
 * force model, the porkchop body list and the patched-conic sphere-of-influence search; a
 * 500 m asteroid must not quietly become a gravitating body in all of those. Small bodies are
 * things to *look at and measure*: they have positions, orbits and readouts, and no mass.
 *
 * Propagation is two-body Kepler from each solution's osculating elements. That is exact at the
 * element epoch and degrades with time from it, because the real orbits are perturbed (by
 * Jupiter above all). `epochAgeYears` exists so the UI can say how far from the epoch it is.
 */

import { AU_M, J2000_JD } from '../constants.js';
import { solveKeplerElliptic } from '../orbit/kepler.js';
import { orbToEcliptic } from './ephemeris.js';
import type { Vec3 } from '../math/vec3.js';
import { SMALL_BODY_DATA } from './smallBodies.data.js';

const DEG = Math.PI / 180;

export type SmallBodyKind = 'dwarf' | 'asteroid' | 'comet';

/** One catalogue entry, exactly as `scripts/fetch-small-bodies.mjs` writes it. */
export interface SmallBodyRecord {
  readonly id: string;
  readonly name: string;
  readonly kind: SmallBodyKind;
  /** The full SBDB designation, e.g. "101955 Bennu (1999 RQ36)". */
  readonly designation: string;
  /** Epoch of the osculating elements, TDB Julian date (treated as TT; they differ by ms). */
  readonly epochJdTdb: number;
  /** Semi-major axis, AU. */
  readonly a: number;
  readonly e: number;
  /** Inclination to the J2000 ecliptic, degrees. */
  readonly i: number;
  /** Longitude of the ascending node, degrees. */
  readonly node: number;
  /** Argument of perihelion, degrees. */
  readonly argPeri: number;
  /** Mean anomaly at the epoch, degrees. */
  readonly meanAnomaly: number;
  /** Mean motion, degrees per day. */
  readonly meanMotion: number;
  readonly diameterKm: number | null;
}

export const SMALL_BODIES: readonly SmallBodyRecord[] = SMALL_BODY_DATA;

export function smallBodyById(id: string): SmallBodyRecord | undefined {
  return SMALL_BODIES.find((b) => b.id === id);
}

/** Heliocentric ecliptic-J2000 position in metres at a TT Julian date. */
export function smallBodyPosition(body: SmallBodyRecord, jdTt: number): Vec3 {
  const M = (body.meanAnomaly + body.meanMotion * (jdTt - body.epochJdTdb)) * DEG;
  const E = solveKeplerElliptic(M, body.e);
  const aM = body.a * AU_M;
  const xOrb = aM * (Math.cos(E) - body.e);
  const yOrb = aM * Math.sqrt(1 - body.e * body.e) * Math.sin(E);
  return orbToEcliptic(xOrb, yOrb, body.argPeri * DEG, body.i * DEG, body.node * DEG);
}

/**
 * Points around a small body's orbit in metres, sampled uniformly in eccentric anomaly so a
 * comet's tight perihelion turn is not drawn as a corner. Closed: the first point repeats.
 */
export function smallBodyOrbit(body: SmallBodyRecord, segments = 256): Vec3[] {
  const aM = body.a * AU_M;
  const bM = aM * Math.sqrt(1 - body.e * body.e);
  const out: Vec3[] = [];
  for (let k = 0; k <= segments; k++) {
    const E = (k / segments) * 2 * Math.PI;
    out.push(
      orbToEcliptic(
        aM * (Math.cos(E) - body.e),
        bM * Math.sin(E),
        body.argPeri * DEG,
        body.i * DEG,
        body.node * DEG,
      ),
    );
  }
  return out;
}

/** Orbital period, days. */
export function smallBodyPeriodDays(body: SmallBodyRecord): number {
  return 360 / body.meanMotion;
}

/** Years between a TT Julian date and the element epoch, signed. */
export function epochAgeYears(body: SmallBodyRecord, jdTt: number): number {
  return (jdTt - body.epochJdTdb) / 365.25;
}

/** Perihelion and aphelion distances, AU. */
export function apsidesAu(body: SmallBodyRecord): { q: number; Q: number } {
  return { q: body.a * (1 - body.e), Q: body.a * (1 + body.e) };
}

/** J2000 as a TT Julian date, re-exported for callers measuring element age. */
export const J2000 = J2000_JD;
