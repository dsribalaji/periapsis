/**
 * Scene scale: converts physics distances (metres) into rendering units.
 *
 * Two separate problems are solved here, and conflating them is the classic source of
 * unviewable solar-system scenes:
 *
 * 1. **Units.** Physics works in metres; rendering works in arbitrary units where "1" is
 *    something the camera can see. A single scale factor handles that.
 *
 * 2. **Dynamic range.** Neptune is 30 AU from the Sun while a LEO satellite is 400 km above
 *    Earth — a ratio of about 1e7. Any single linear scale either puts Earth's surface
 *    inside the Sun's mesh or makes a satellite invisible. So bodies are drawn with a
 *    *display radius* that is a compressed function of their real radius, while their
 *    *orbital positions* stay linear in the physical distance. The scene is therefore
 *    positionally honest and dimensionally dishonest, which is the standard compromise for
 *    solar-system viewers (and is labelled as such in the UI).
 *
 * Body radii use a cube-root compression: r_display ∝ r_real^(1/3). That preserves ordering
 * and rough relative size while turning a 1e7 radius ratio into about 2e2. The Sun, Earth
 * and a satellite remain mutually distinguishable and none is drawn at zero size.
 */

import { AU_M } from '../core/constants.js';
import type { BodyId } from '../core/ephemeris/solarSystem.js';

/** Scene units per astronomical unit. Chosen so 1 AU ≈ 100 units: comfortable camera range. */
export const UNITS_PER_AU = 100;

/** Scene units per metre for orbital positions. */
export const UNITS_PER_M = UNITS_PER_AU / AU_M;

/**
 * Compressed display radius for a body, in scene units.
 *
 * `k * (r / r_earth)^(1/3)` with the Earth's display radius fixed at 1.2 units, so an
 * Earth-sized body is drawn at 1.2 and everything else is scaled relative to it by the cube
 * root of its true radius ratio.
 */
const EARTH_DISPLAY_RADIUS = 1.2;

export function displayRadius(bodyRadiusM: number): number {
  const earthRadiusM = 6.371e6;
  return EARTH_DISPLAY_RADIUS * Math.cbrt(bodyRadiusM / earthRadiusM);
}

/** A minimum on-screen size so that small bodies stay clickable. */
export const MIN_DISPLAY_RADIUS = 0.35;

export function displayRadiusFor(id: BodyId, radiusM: number): number {
  // The Moon is deliberately drawn larger than its true relative size would give, so it is
  // visible next to Earth at solar-system zoom.
  if (id === 'moon') return Math.max(MIN_DISPLAY_RADIUS, displayRadius(radiusM) * 1.6);
  return Math.max(MIN_DISPLAY_RADIUS, displayRadius(radiusM));
}

/** Radial mapping from physics distance to scene units. */
export type RadialMode = 'linear' | 'compressed';

/**
 * Constants for the compressed radial mapping.
 *
 * `sceneUnits = COMPRESS_K * log10(1 + r_AU / COMPRESS_R0)`
 *
 * The solar system spans 0.39 AU to 30 AU, a ratio of 77; the interesting part (the
 * terrestrial planets) lives inside 1.6 AU and the giants out to 30. On a linear scale, a
 * view wide enough to hold Neptune puts Earth at 3% of the radius — three pixels, invisible.
 *
 * A logarithmic radius compresses the whole system into 71-209 units, so everything can be
 * seen at once. Two properties make this acceptable rather than merely convenient:
 *
 *   - It is radial and monotone, so circular orbits stay circular and nothing can cross
 *     anything else. Ordering is preserved exactly.
 *   - It is a pure function of distance from the Sun, so relative angles are exact.
 *
 * What it is NOT is to scale, which is why it is a labelled, user-visible toggle and not the
 * only mode. The linear mapping remains the default for the inner system, where it is
 * honest and perfectly readable.
 */
const COMPRESS_K = 75;
const COMPRESS_R0 = 0.05;

/** Scene units for a heliocentric distance in metres, under the chosen mapping. */
export function radialUnits(radiusM: number, mode: RadialMode = 'linear'): number {
  if (mode === 'linear') return radiusM * UNITS_PER_M;
  const au = radiusM / AU_M;
  return COMPRESS_K * Math.log10(1 + Math.max(0, au) / COMPRESS_R0);
}

/**
 * Scales a heliocentric position vector into scene units, preserving direction.
 *
 * Both mappings are radial, so direction is untouched: the unit vector is scaled by the
 * mapped magnitude. Under `linear` this is exactly `toScene`.
 */
export function scalePosition(
  x: number,
  y: number,
  z: number,
  mode: RadialMode = 'linear',
): [number, number, number] {
  if (mode === 'linear') return toScene(x, y, z);
  const r = Math.hypot(x, y, z);
  if (r === 0) return [0, 0, 0];
  // The mapped scene radius, applied to the direction cosines. Note this must NOT go
  // through toScene afterwards: toScene converts metres to scene units, but this branch is
  // already in scene units, so passing through it would scale the result twice.
  const mappedRadius = radialUnits(r, mode);
  const k = mappedRadius / r;
  const sx = x * k;
  const sy = y * k;
  const sz = z * k;
  // Same axis convention as toScene: (x, y, z)_physics -> (x, z, -y)_scene.
  return [sx, sz, -sy];
}

/** Converts a physics position (metres) to scene units. */
export function toScene(x: number, y: number, z: number): [number, number, number] {
  return [x * UNITS_PER_M, z * UNITS_PER_M, -y * UNITS_PER_M];
}

/**
 * Frame convention.
 *
 * Physics is right-handed with +z toward the ecliptic north pole, viewed from +z looking
 * down. Three.js is right-handed with +y up and the camera looking down -z. Mapping
 * (x, y, z)_physics -> (x, z, -y)_scene keeps the ecliptic in the scene's xz plane, puts
 * ecliptic north along scene +y, and preserves handedness — so orbital motion stays
 * counter-clockwise when viewed from above, as it is in reality, rather than appearing
 * mirrored.
 */
export const FRAME_NOTE = 'physics (x,y,z) -> scene (x, z, -y)';
