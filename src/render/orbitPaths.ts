/**
 * Orbit paths: the closed ellipse each body is on, for drawing.
 *
 * The old view drew every planet's orbit as a circle of a hard-coded radius in the ecliptic.
 * That is visibly wrong for Mercury (e = 0.21: its distance from the Sun varies by 50%, so the
 * planet sat well off its own ring) and silently wrong for every inclined orbit. Here each path
 * is the osculating ellipse of the same JPL elements the ephemeris uses, evaluated at the
 * current epoch, so the body is always *on* its drawn orbit by construction.
 *
 * Pure: a function of elements and time, returning metres relative to the parent. The scene
 * maps the points through whichever radial mode is active.
 */

import type { MeanElements } from '../core/ephemeris/solarSystem.js';
import { advanceElements, centuriesFromJd, orbToEcliptic } from '../core/ephemeris/ephemeris.js';
import { AU_M } from '../core/constants.js';
import type { Vec3 } from '../core/math/vec3.js';

/**
 * Points around the osculating orbit at `jdTt`, in metres relative to the parent.
 *
 * Sampled uniformly in *eccentric* anomaly rather than time or true anomaly: that spaces the
 * points evenly along the ellipse's arc length for the eccentricities in this system, so the
 * polyline has no visible corners at perihelion. The first point is repeated at the end so the
 * loop closes.
 */
export function orbitPathPoints(elements: MeanElements, jdTt: number, segments = 256): Vec3[] {
  if (!(segments >= 3)) throw new Error('orbitPathPoints: need at least 3 segments');
  const cur = advanceElements(elements, centuriesFromJd(jdTt));
  const aM = cur.a * AU_M;
  const bM = aM * Math.sqrt(1 - cur.e * cur.e);
  const points: Vec3[] = [];
  for (let k = 0; k <= segments; k++) {
    const E = (k / segments) * 2 * Math.PI;
    // Perifocal coordinates, x toward periapsis (the same step 4 as the ephemeris).
    const xOrb = aM * (Math.cos(E) - cur.e);
    const yOrb = bM * Math.sin(E);
    points.push(orbToEcliptic(xOrb, yOrb, cur.argPeriapsis, cur.i, cur.node));
  }
  return points;
}
