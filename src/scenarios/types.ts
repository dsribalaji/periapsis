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

/** Bump only for a breaking change. Readers must reject versions they do not know. */
export const SCENARIO_SCHEMA_VERSION = 1;

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
  /** Camera distance from the target, scene units. */
  readonly distanceUnits: number;
  /**
   * What the camera looks at. The Sun is right for a system-wide view; the focus body is
   * right when the scenario is about a pair (Earth and Moon), where a 60-unit camera aimed
   * at the Sun would show neither.
   */
  readonly centeredOn: 'sun' | 'focus';
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
}
