/**
 * Scenario types.
 *
 * A scenario is a *starting point*, not a simulation: the epoch, the initial time control,
 * the body in focus, and the camera framing. Everything else is derived from the physics at
 * load time, so a scenario file can never smuggle in a wrong position.
 *
 * The schema is versioned from the first release even though only one version exists yet.
 * Adding a version field after files are in the wild is the change that is impossible to
 * make cleanly; adding it now costs one line.
 */

import type { BodyId } from '../core/ephemeris/solarSystem.js';
import type { RadialMode } from '../render/scale.js';
import type { Warp } from '../sim/clock.js';
import type { CraftSpec } from '../sim/craft.js';

/**
 * Bump only for a breaking change. Readers must reject versions they do not know.
 *
 * 2: bodies are drawn at true scale, so a body-centred `view.distanceUnits` means something
 * different (D-047). A version-1 file is upgraded by `migrate.ts`, not refused.
 */
export const SCENARIO_SCHEMA_VERSION = 2;

/**
 * Camera framing, in the renderer's own units and angles.
 *
 * Stored as data because "frame the inner system from 30 degrees above the ecliptic" is part
 * of what makes a scenario reproducible, and a camera that depends on whatever the previous
 * scenario left behind is not reproducible.
 */
export interface ScenarioView {
  readonly radialMode: RadialMode;
  /** Rotation about the ecliptic north axis, radians, measured in the scene frame. */
  readonly azimuthRad: number;
  /** Angle above the ecliptic plane, radians, clamped to (-pi/2, pi/2). */
  readonly elevationRad: number;
  /** Camera distance from the target, scene units (100 per AU, true scale). */
  readonly distanceUnits: number;
  /**
   * What the camera looks at.
   *
   * - `sun` — a system-wide view, for the inner or whole system.
   * - `focus` — the selected body, for a single planet or a craft's orbit around it.
   * - `pair` — the midpoint between the selected body and its parent, at a distance fitted to
   *   their separation. Aiming at either end of the Earth-Moon pair puts the other one off
   *   the edge of the frame; the midpoint is the framing that shows both.
   */
  readonly centeredOn: 'sun' | 'focus' | 'pair';
}

export interface Scenario {
  readonly schemaVersion: number;
  /** Stable identifier, used as a key and in the URL-free scenario switcher. */
  readonly id: string;
  readonly name: string;
  /** One sentence: what this starting point is for. */
  readonly description: string;
  /** ISO-8601 UTC instant of simulation time zero. */
  readonly epochUtc: string;
  /** Time control at load. 0 would open the scenario paused. */
  readonly startWarp: Warp;
  /** Body selected and framed when the scenario opens. */
  readonly focus: BodyId;
  readonly view: ScenarioView;
  /**
   * Optional mission: a spacecraft and the span it is planned over.
   *
   * Still data, and still no free state vector: the craft is an orbit parameterisation
   * (altitude, inclination, phase) resolved by `craftFromSpec`, so a scenario cannot carry a
   * state that contradicts its own description. `craft.horizonSeconds` is also the span that
   * gets drawn — one number, so the picture cannot disagree with the plan.
   */
  readonly mission?: CraftSpec;
}
