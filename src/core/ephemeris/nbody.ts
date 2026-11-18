/**
 * Restricted N-body core.
 *
 * Spacecraft are massless test particles: they feel the gravity of every built-in body
 * evaluated at that body's prescribed analytic position at the requested time, and they
 * exert no force on anything. The massive bodies are NOT integrated (ADR-0003), which is
 * why this module makes no energy or momentum conservation claim — with moving
 * prescribed primaries there is no conserved quantity to test against.
 *
 * Frame: heliocentric J2000 mean ecliptic, metres and m/s. Acceleration in m/s².
 */

import { type Vec3, vec3 } from '../math/vec3.js';
import { bodyPosition } from '../ephemeris/ephemeris.js';
import { BODY_IDS, BODIES, type BodyId, sphereOfInfluence } from '../ephemeris/solarSystem.js';
import { J2000_JD, SECONDS_PER_DAY } from '../constants.js';

/** A body included in the gravity model. */
export interface ActiveBody {
  readonly id: BodyId;
  readonly mu: number;
}

/**
 * Gravitational softening in metres. Zero means a true point mass. The integrators can
 * be stepped through a body's centre at very coarse steps; a small epsilon prevents a
 * division by zero from producing NaN that would silently poison the trajectory. Set
 * to 0 to get exact point-mass behaviour (the default).
 */
export interface NBodyConfig {
  readonly enabled: readonly BodyId[];
  readonly softening?: number;
}

export const ALL_BODIES: NBodyConfig = { enabled: [...BODY_IDS] };

/** Julian date from seconds offset relative to the J2000 epoch. */
export const jdFromSeconds = (seconds: number): number => J2000_JD + seconds / SECONDS_PER_DAY;

/**
 * Total gravitational acceleration on a test particle at heliocentric position `r`
 * at TT Julian date `jdTt`, from every enabled body. Pure and deterministic.
 */
export function acceleration(r: Vec3, jdTt: number, config: NBodyConfig = ALL_BODIES): Vec3 {
  const softening = config.softening ?? 0;
  const soft2 = softening * softening;
  let ax = 0;
  let ay = 0;
  let az = 0;

  for (const id of config.enabled) {
    const mu = BODIES[id].mu;
    const p = bodyPosition(id, jdTt);
    const dx = p.x - r.x;
    const dy = p.y - r.y;
    const dz = p.z - r.z;
    const d2 = dx * dx + dy * dy + dz * dz + soft2;
    if (d2 === 0) continue;
    const invD = 1 / Math.sqrt(d2);
    const invD3 = invD * invD * invD;
    const k = mu * invD3;
    ax += k * dx;
    ay += k * dy;
    az += k * dz;
  }

  return vec3(ax, ay, az);
}

/**
 * Builds a force function for the integrators: `(t, r, v) => a`, where `t` is seconds
 * from the J2000 epoch (the convention documented in PHYSICS.md §6).
 */
export function makeForceFunction(
  config: NBodyConfig = ALL_BODIES,
  epochOffsetSeconds = 0,
): (t: number, r: Vec3) => Vec3 {
  return (t: number, r: Vec3) => acceleration(r, jdFromSeconds(t + epochOffsetSeconds), config);
}

/** The dominant body (largest mu/d²) at a position and time. */
export function dominantBody(r: Vec3, jdTt: number, config: NBodyConfig = ALL_BODIES): BodyId {
  let best: BodyId = 'sun';
  let bestK = -Infinity;
  for (const id of config.enabled) {
    const p = bodyPosition(id, jdTt);
    const dx = p.x - r.x;
    const dy = p.y - r.y;
    const dz = p.z - r.z;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 === 0) return id;
    const k = BODIES[id].mu / d2;
    if (k > bestK) {
      bestK = k;
      best = id;
    }
  }
  return best;
}

/**
 * Which body's sphere of influence contains `r`.
 *
 * This must be a HIERARCHICAL descent, not a flat "smallest r/r_soi wins" scan. A flat
 * scan is wrong because the Sun's SOI is infinite: skipping it lets a distant point be
 * awarded to whichever planet happens to have the largest SOI (Jupiter's is 0.32 AU,
 * Saturn's 0.37 AU), so a point in empty space 2 AU from the Sun would be labelled
 * "Saturn". That bug was caught by a test and is fixed here.
 *
 * Correct procedure: start at the root (Sun) and repeatedly check whether the point lies
 * inside the SOI of any *child* of the current owner; descend while it does. Deep space
 * therefore stays with the Sun.
 */
export function containingSoi(r: Vec3, jdTt: number, config: NBodyConfig = ALL_BODIES): BodyId {
  const enabled = new Set(config.enabled);
  let current: BodyId = 'sun';

  for (let depth = 0; depth < 8; depth++) {
    let descended = false;
    for (const id of BODY_IDS) {
      if (!enabled.has(id)) continue;
      const body = BODIES[id];
      if (body.parent !== current) continue;
      const soi = sphereOfInfluence(id);
      if (!Number.isFinite(soi)) continue;
      const p = bodyPosition(id, jdTt);
      const dx = p.x - r.x;
      const dy = p.y - r.y;
      const dz = p.z - r.z;
      if (Math.sqrt(dx * dx + dy * dy + dz * dz) < soi) {
        current = id;
        descended = true;
        break;
      }
    }
    if (!descended) break;
  }
  return current;
}

/** Relative state of a spacecraft with respect to a body. */
export function relativeState(r: Vec3, v: Vec3, body: BodyId, jdTt: number): { r: Vec3; v: Vec3 } {
  const p = bodyPosition(body, jdTt);
  return { r: vec3(r.x - p.x, r.y - p.y, r.z - p.z), v };
}

/** Altitude above a body's mean radius, in metres. */
export function altitudeAbove(r: Vec3, body: BodyId, jdTt: number): number {
  const p = bodyPosition(body, jdTt);
  const dx = r.x - p.x;
  const dy = r.y - p.y;
  const dz = r.z - p.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz) - BODIES[body].radius;
}
