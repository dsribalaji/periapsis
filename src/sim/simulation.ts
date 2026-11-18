/**
 * Simulation driver: owns the epoch, the clock, and the derivation of body positions.
 *
 * Kept separate from React so that the "what time is it and where is everything" logic is
 * testable in isolation and free of render concerns. The React layer reads a snapshot from
 * here and hands it to the scene.
 */

import { jdTtFromJdUtc, jdFromIsoUtc, isoUtcFromJd, jdUtcFromJdTt } from '../core/time/time.js';
import { bodyPosition } from '../core/ephemeris/ephemeris.js';
import { BODIES, type BodyId } from '../core/ephemeris/solarSystem.js';
import type { Vec3 } from '../core/math/vec3.js';
import { advanceClock, createClock, setWarp, type ClockState, type Warp } from './clock.js';
import { simSecondsToDays } from './clock.js';

export interface SimulationSnapshot {
  /** Simulation time, seconds since epoch. */
  readonly simSeconds: number;
  /** Current UTC Julian date. */
  readonly jdUtc: number;
  /** Current UTC timestamp, ISO-8601, for display. */
  readonly isoUtc: string;
  /** Heliocentric positions in metres, physics frame. */
  readonly positions: ReadonlyMap<BodyId, Vec3>;
  /** Warp in effect during this snapshot. */
  readonly warp: Warp;
}

export class Simulation {
  /** UTC Julian date of simulation time zero. */
  private epochJdUtc: number;
  private clock: ClockState;

  constructor(epochIso: string = '2026-11-18T00:00:00Z', warp: Warp = 1) {
    this.epochJdUtc = jdFromIsoUtc(epochIso);
    this.clock = createClock(warp);
  }

  /**
   * Restarts at a new epoch.
   *
   * In place rather than by constructing a new `Simulation`, because the renderer and the
   * frame loop hold a reference to this object; swapping it would mean tearing down and
   * rebuilding the WebGL context just to change the date.
   */
  reset(epochIso: string, warp: Warp): void {
    this.epochJdUtc = jdFromIsoUtc(epochIso);
    this.clock = createClock(warp);
  }

  get epoch(): number {
    return this.epochJdUtc;
  }

  get warp(): Warp {
    return this.clock.warp;
  }

  setWarp(warp: Warp): void {
    this.clock = setWarp(this.clock, warp);
  }

  get paused(): boolean {
    return this.clock.warp === 0;
  }

  get simSeconds(): number {
    return this.clock.simSeconds;
  }

  /** UTC Julian date of the current simulation instant. */
  get jdUtc(): number {
    return this.epochJdUtc + simSecondsToDays(this.clock.simSeconds);
  }

  /** TT Julian date, which is what the ephemerides want. */
  get jdTt(): number {
    return jdTtFromJdUtc(this.jdUtc);
  }

  /** Advances one frame. Returns how many integration steps were run. */
  advance(realMs: number): { steps: number; throttled: boolean } {
    const result = advanceClock(this.clock, realMs);
    this.clock = result.state;
    return { steps: result.steps, throttled: result.throttled };
  }

  /** Sets the simulation instant directly, e.g. from a date picker. */
  setJdUtc(jdUtc: number): void {
    this.clock = { ...this.clock, simSeconds: (jdUtc - this.epochJdUtc) * 86400 };
  }

  /** Body positions at the current instant, in metres. */
  positions(): Map<BodyId, Vec3> {
    const jdTt = this.jdTt;
    const out = new Map<BodyId, Vec3>();
    for (const id of Object.keys(BODIES) as BodyId[]) {
      out.set(id, bodyPosition(id, jdTt));
    }
    return out;
  }

  snapshot(): SimulationSnapshot {
    const jdUtc = this.jdUtc;
    return {
      simSeconds: this.clock.simSeconds,
      jdUtc,
      isoUtc: isoUtcFromJd(jdUtc),
      positions: this.positions(),
      warp: this.clock.warp,
    };
  }

  /** UTC offset of a position given in TT, for callers that have one. */
  static ttToUtc(jdTt: number): number {
    return jdUtcFromJdTt(jdTt);
  }
}
