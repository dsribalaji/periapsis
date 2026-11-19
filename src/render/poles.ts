/**
 * Spin axes: which way each body's north pole points.
 *
 * Without this every body spun about the ecliptic normal, so Earth had no seasons, Saturn's
 * rings lay flat in the ecliptic and Uranus was upright. The directions here are the IAU
 * WGCCRE recommended north-pole right ascension and declination at J2000 (Archinal et al.,
 * 2018), rotated from the equatorial frame into the ecliptic frame the physics uses.
 *
 * The slow precession of these poles is ignored: Earth's moves 50" a year, which is invisible
 * at any zoom this view has.
 *
 * Sense of rotation: the IAU "north" pole is the one on the north side of the invariable
 * plane, so a body that spins the other way (Venus, Uranus) has a *negative* rate about it.
 * `SPIN_SENSE` carries that sign for the renderer.
 */

import { OBLIQUITY_J2000 } from '../core/constants.js';
import type { BodyId } from '../core/ephemeris/solarSystem.js';
import type { Vec3 } from '../core/math/vec3.js';

const DEG = Math.PI / 180;

/** North-pole right ascension and declination, degrees, ICRF/J2000. */
export const POLE_RA_DEC: Readonly<Record<BodyId, readonly [number, number]>> = {
  sun: [286.13, 63.87],
  mercury: [281.01, 61.41],
  venus: [272.76, 67.16],
  earth: [0, 90],
  // The Moon's pole wobbles with the 18.6-year nodal cycle; this is its mean direction.
  moon: [269.99, 66.54],
  mars: [317.68, 52.89],
  jupiter: [268.05, 64.49],
  saturn: [40.59, 83.54],
  uranus: [257.31, -15.18],
  neptune: [299.36, 43.46],
};

/** +1 for prograde rotation about the IAU north pole, -1 for retrograde. */
export const SPIN_SENSE: Readonly<Record<BodyId, 1 | -1>> = {
  sun: 1,
  mercury: 1,
  venus: -1,
  earth: 1,
  moon: 1,
  mars: 1,
  jupiter: 1,
  saturn: 1,
  uranus: -1,
  neptune: 1,
};

/**
 * Unit vector of a body's north pole in the J2000 mean *ecliptic* frame (physics axes).
 *
 * Equatorial to ecliptic is a rotation about +x by the obliquity:
 * `y_ecl = y cos e + z sin e`, `z_ecl = -y sin e + z cos e`.
 */
export function poleEcliptic(id: BodyId): Vec3 {
  const [ra, dec] = POLE_RA_DEC[id];
  const cosDec = Math.cos(dec * DEG);
  const x = cosDec * Math.cos(ra * DEG);
  const y = cosDec * Math.sin(ra * DEG);
  const z = Math.sin(dec * DEG);
  const c = Math.cos(OBLIQUITY_J2000);
  const s = Math.sin(OBLIQUITY_J2000);
  return { x, y: y * c + z * s, z: -y * s + z * c };
}
