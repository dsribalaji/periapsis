import { describe, expect, it } from 'vitest';
import { orbitPathPoints } from '../src/render/orbitPaths.js';
import { BODIES, BODY_IDS, MOON_ELEMENTS } from '../src/core/ephemeris/solarSystem.js';
import {
  advanceElements,
  centuriesFromJd,
  relativePosition,
} from '../src/core/ephemeris/ephemeris.js';
import { AU_M } from '../src/core/constants.js';
import { jdFromIsoUtc, jdTtFromJdUtc } from '../src/core/time/time.js';
import type { Vec3 } from '../src/core/math/vec3.js';

const JD = jdTtFromJdUtc(jdFromIsoUtc('2026-11-18T12:00:00Z'));

/** Distance from a point to the nearest segment of a closed polyline. */
function distanceToPath(p: Vec3, path: readonly Vec3[]): number {
  let best = Infinity;
  for (let k = 0; k + 1 < path.length; k++) {
    const a = path[k]!;
    const b = path[k + 1]!;
    const ab = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
    const ap = { x: p.x - a.x, y: p.y - a.y, z: p.z - a.z };
    const len2 = ab.x * ab.x + ab.y * ab.y + ab.z * ab.z;
    const t =
      len2 > 0 ? Math.max(0, Math.min(1, (ap.x * ab.x + ap.y * ab.y + ap.z * ab.z) / len2)) : 0;
    const d = Math.hypot(ap.x - ab.x * t, ap.y - ab.y * t, ap.z - ab.z * t);
    if (d < best) best = d;
  }
  return best;
}

describe('orbit paths', () => {
  it('closes the loop: the last point is the first', () => {
    const path = orbitPathPoints(BODIES.mars.elements!, JD, 64);
    expect(path).toHaveLength(65);
    const first = path[0]!;
    const last = path[64]!;
    expect(Math.hypot(first.x - last.x, first.y - last.y, first.z - last.z)).toBeLessThan(1);
  });

  it('puts every body on its own drawn orbit', () => {
    // The point of drawing the osculating ellipse instead of a circle: the body sits on the
    // line. Tolerance is the polyline's chord sagitta, a(1 - cos(pi/N)), which is the largest
    // gap a straight segment can leave from the true ellipse.
    const segments = 360;
    for (const id of BODY_IDS) {
      const el = BODIES[id].elements;
      if (!el) continue;
      const path = orbitPathPoints(el, JD, segments);
      const body = relativePosition(el, JD);
      const a = advanceElements(el, centuriesFromJd(JD)).a * AU_M;
      const sagitta = a * (1 - Math.cos(Math.PI / segments)) * 1.5;
      expect(distanceToPath(body, path), id).toBeLessThan(sagitta);
    }
  });

  it("draws Mercury's eccentricity rather than a circle", () => {
    // Mercury's perihelion is 0.307 AU and aphelion 0.467: the ring the old view drew at a
    // fixed 0.387 AU was 26% off at both ends.
    const path = orbitPathPoints(BODIES.mercury.elements!, JD);
    const radii = path.map((p) => Math.hypot(p.x, p.y, p.z) / AU_M);
    expect(Math.min(...radii)).toBeCloseTo(0.3075, 2);
    expect(Math.max(...radii)).toBeCloseTo(0.4667, 2);
  });

  it('tilts an inclined orbit out of the ecliptic by its inclination', () => {
    // Mercury is inclined 7.0 degrees, so its path reaches z = a sin(i) at most (roughly).
    const path = orbitPathPoints(BODIES.mercury.elements!, JD);
    const maxZ = Math.max(...path.map((p) => Math.abs(p.z))) / AU_M;
    expect(maxZ).toBeGreaterThan(0.03);
    expect(maxZ).toBeLessThan(0.06);
  });

  it("draws the Moon's orbit at its real size about Earth", () => {
    const path = orbitPathPoints(MOON_ELEMENTS, JD);
    const radii = path.map((p) => Math.hypot(p.x, p.y, p.z) / 1000);
    // Perigee and apogee of the mean orbit, km.
    expect(Math.min(...radii)).toBeGreaterThan(355_000);
    expect(Math.max(...radii)).toBeLessThan(410_000);
  });

  it('refuses a degenerate segment count', () => {
    expect(() => orbitPathPoints(BODIES.earth.elements!, JD, 2)).toThrow(/at least 3/);
  });
});
