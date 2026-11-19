/**
 * Scene scale: converts physics distances (metres) into rendering units.
 *
 * **One scale for everything.** Positions, body radii, satellite offsets and spacecraft
 * trajectories all use the same metres-to-units factor. That is the only arrangement in which
 * every geometric relation on screen is true at once: the Moon is 60 Earth radii from an Earth
 * of the right size, a 550 km orbit hugs the planet at 1.086 radii, and no satellite can be
 * drawn inside, or absurdly far from, the body it orbits.
 *
 * Earlier versions drew bodies at a cube-root-compressed radius (Earth 282x too large) and then
 * had to drag every satellite and trajectory out by the same factor so they cleared the inflated
 * planet. The Moon then sat 72 units from Earth while Earth is only 100 units from the Sun, i.e.
 * three quarters of the way to the Sun. No camera angle fixes a position, so that design was
 * replaced rather than patched (DECISIONS.md D-047).
 *
 * **Visibility is a screen-space rule, not a world-space one.** At true scale Earth is 0.004
 * units across and invisible from 300 units away. So a body is drawn at whichever is larger:
 * its true radius, or a minimum radius in *pixels* (`MIN_PIXEL_RADIUS`). Zoomed in, bodies are
 * exactly their real size; zoomed out, they become markers of fixed apparent size, which is how
 * planetarium software stays legible without lying about where anything is.
 *
 * The one place the minimum-pixel rule would mislead is a satellite whose marker overlaps its
 * parent's. That is handled by `satelliteResolvable`: a satellite is drawn only once it is far
 * enough from its parent on screen to be seen as separate.
 */

import { AU_M } from '../core/constants.js';
import type { BodyId } from '../core/ephemeris/solarSystem.js';

/** Scene units per astronomical unit. Chosen so 1 AU = 100 units: comfortable camera range. */
export const UNITS_PER_AU = 100;

/** Scene units per metre, for positions, radii and body-relative offsets alike. */
export const UNITS_PER_M = UNITS_PER_AU / AU_M;

/** A body's true radius in scene units. */
export function trueRadiusUnits(radiusM: number): number {
  return radiusM * UNITS_PER_M;
}

/**
 * The smallest radius, in screen pixels, each body is drawn at.
 *
 * Ordered by real size so the markers still rank correctly (the Sun largest, the giants next,
 * the Moon smallest) even when every body is far below a pixel. The values are about what a
 * finger or a mouse pointer can hit; picking uses the drawn mesh, so the marker *is* the
 * click target.
 */
export const MIN_PIXEL_RADIUS: Readonly<Record<BodyId, number>> = {
  sun: 9,
  mercury: 3,
  venus: 3.6,
  earth: 3.8,
  moon: 2.4,
  mars: 3.3,
  jupiter: 5.5,
  saturn: 5,
  uranus: 4.4,
  neptune: 4.4,
};

/**
 * Scene units covered by one screen pixel at a given distance from a perspective camera.
 *
 * The visible height at distance `d` is `2 d tan(fov / 2)`; dividing by the viewport's pixel
 * height gives the size of a pixel there.
 */
export function unitsPerPixelAt(
  distanceUnits: number,
  verticalFovRad: number,
  viewportHeightPx: number,
): number {
  if (!(viewportHeightPx > 0)) return 0;
  return (2 * Math.max(0, distanceUnits) * Math.tan(verticalFovRad / 2)) / viewportHeightPx;
}

/**
 * The radius a body is drawn at: its true radius, or the minimum pixel size if that is bigger.
 *
 * Never smaller than the truth. That is the property that keeps the picture honest when
 * zoomed in: a body you can resolve is exactly its real size.
 */
export function drawnRadiusUnits(
  trueUnits: number,
  unitsPerPixel: number,
  minPixelRadius: number,
): number {
  return Math.max(trueUnits, minPixelRadius * unitsPerPixel);
}

/**
 * Whether a satellite can be told apart from its parent on screen.
 *
 * Both are drawn at least `MIN_PIXEL_RADIUS` across. When the camera is far away the Moon's
 * true 0.26-unit offset from Earth is a fraction of a pixel, so the two markers would overlap
 * and the Moon would read as a blemish on Earth. It is hidden until the gap between the two
 * discs is at least `gapPx` - which is a statement about the *screen*, made after the
 * position is already correct, not a fix for a wrong position.
 */
export function satelliteResolvable(
  separationPx: number,
  parentRadiusPx: number,
  childRadiusPx: number,
  gapPx = 3,
): boolean {
  return separationPx >= parentRadiusPx + childRadiusPx + gapPx;
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
 * view wide enough to hold Neptune puts Earth at 3% of the radius.
 *
 * A logarithmic radius compresses the whole system into 71-209 units, so everything can be
 * seen at once. It is radial and monotone, so ordering is exact and directions from the Sun
 * are exact; it is not to scale, which is why it is a labelled, user-visible toggle.
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
 * Scene units per metre for geometry *around* a body at a given distance from the Sun.
 *
 * Under the linear mapping this is simply `UNITS_PER_M`. Under the compressed mapping the
 * layout has no single scale, so a body-centred system (the Moon about Earth, a spacecraft
 * about its planet) uses the map's *local* scale at the body's distance - the derivative of
 * `radialUnits`. That keeps each local system internally consistent with its neighbourhood:
 * small offsets are drawn at the same scale the map uses for small radial steps right there.
 */
export function localUnitsPerMetre(heliocentricDistanceM: number, mode: RadialMode): number {
  if (mode === 'linear') return UNITS_PER_M;
  const au = Math.max(0, heliocentricDistanceM) / AU_M;
  const unitsPerAu = COMPRESS_K / (Math.LN10 * (COMPRESS_R0 + au));
  return unitsPerAu / AU_M;
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
  // Already in scene units here, so this must NOT go through toScene afterwards.
  const k = radialUnits(r, mode) / r;
  // Same axis convention as toScene: (x, y, z)_physics -> (x, z, -y)_scene.
  return [x * k, z * k, -y * k];
}

/** Converts a physics position (metres) to scene units. */
export function toScene(x: number, y: number, z: number): [number, number, number] {
  return [x * UNITS_PER_M, z * UNITS_PER_M, -y * UNITS_PER_M];
}

/** Scales a body-relative offset (metres) into scene units, keeping the frame convention. */
export function scaleOffset(
  x: number,
  y: number,
  z: number,
  unitsPerMetre: number,
): [number, number, number] {
  return [x * unitsPerMetre, z * unitsPerMetre, -y * unitsPerMetre];
}

/**
 * Frame convention.
 *
 * Physics is right-handed with +z toward the ecliptic north pole, viewed from +z looking
 * down. Three.js is right-handed with +y up and the camera looking down -z. Mapping
 * (x, y, z)_physics -> (x, z, -y)_scene keeps the ecliptic in the scene's xz plane, puts
 * ecliptic north along scene +y, and preserves handedness - so orbital motion stays
 * counter-clockwise when viewed from above, as it is in reality, rather than appearing
 * mirrored.
 */
export const FRAME_NOTE = 'physics (x,y,z) -> scene (x, z, -y)';
