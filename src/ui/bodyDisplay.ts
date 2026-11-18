/**
 * Display metadata for bodies: names, ordering and colours.
 *
 * Kept separate from the physics (which owns masses, radii and elements) so the UI can
 * change its presentation without touching the model, and so nothing here can accidentally
 * become a source of physics truth.
 */

import type { BodyId } from '../core/ephemeris/solarSystem.js';

export interface BodyDisplayInfo {
  readonly id: BodyId;
  readonly label: string;
  /** CSS colour, matching the mesh colour in the renderer. */
  readonly color: string;
  /** Display order: Sun outward. */
  readonly order: number;
}

export const BODY_DISPLAY: readonly BodyDisplayInfo[] = [
  { id: 'sun', label: 'Sun', color: '#ffdd55', order: 0 },
  { id: 'mercury', label: 'Mercury', color: '#9a8f88', order: 1 },
  { id: 'venus', label: 'Venus', color: '#d9b382', order: 2 },
  { id: 'earth', label: 'Earth', color: '#4c8fd6', order: 3 },
  { id: 'moon', label: 'Moon', color: '#bfbfbf', order: 4 },
  { id: 'mars', label: 'Mars', color: '#c1440e', order: 5 },
  { id: 'jupiter', label: 'Jupiter', color: '#d8a172', order: 6 },
  { id: 'saturn', label: 'Saturn', color: '#e3cf9a', order: 7 },
  { id: 'uranus', label: 'Uranus', color: '#7fd4d8', order: 8 },
  { id: 'neptune', label: 'Neptune', color: '#4b6fd6', order: 9 },
];

export const BODY_LABEL: Record<BodyId, string> = BODY_DISPLAY.reduce(
  (acc, b) => ({ ...acc, [b.id]: b.label }),
  {} as Record<BodyId, string>,
);
