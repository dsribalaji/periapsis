/**
 * Simulation clock: maps real elapsed time to simulation time, deterministically.
 *
 * The clock is a pure value object, not an ambient timer. It never reads `Date.now()`; a
 * caller advances it by passing in the real elapsed milliseconds. That keeps the whole
 * simulation reproducible and unit-testable, and it is what the core-purity lint rule
 * enforces.
 *
 * Three properties this design is built around:
 *
 * 1. **Warp means simulation seconds per real second.** Not a step count, not a frame
 *    multiplier. At warp 1000, one real second of wall time advances 1000 simulated
 *    seconds. Anything else makes the time control lie to the user.
 *
 * 2. **Step size is fixed and independent of frame rate.** A trajectory whose accuracy
 *    depends on how fast the machine rendered is not reproducible. Step size depends only
 *    on warp, so the same scenario at the same warp integrates identically on any machine.
 *
 * 3. **The step budget is honoured, and the cost is accuracy, not silent time loss.** At
 *    extreme warp a frame cannot afford enough steps at the accuracy floor. Rather than
 *    dropping time (which would make warp a lie) or stalling (which looks like a hang), the
 *    step size grows to fit the budget, and the clock reports `throttled` so the UI can
 *    show that integration has coarsened.
 *
 * The bank accumulates simulation time, and only real frame time is clamped. That detail is
 * what keeps both properties above true at once: with a 1 s accuracy floor and 16.7 ms
 * frames at warp 1, the clock must accumulate several frames before it can run a single
 * step, and clamping the *owed* amount instead would prevent it from ever reaching one.
 */

import { SECONDS_PER_DAY } from '../core/constants.js';

/** Warp factors offered to the user. 1 means one simulated second per real second. */
export const WARP_STEPS = [0, 1, 10, 100, 1e3, 1e4, 1e5, 1e6, 1e7] as const;

export type Warp = (typeof WARP_STEPS)[number];

export interface ClockConfig {
  /** Smallest simulation step, in sim seconds. Sets the accuracy at low warp. */
  readonly minStepSeconds: number;
  /** Maximum number of steps executed in one frame, i.e. the compute budget. */
  readonly maxStepsPerFrame: number;
  /** Real frame time above this is treated as a stall and clamped, in milliseconds. */
  readonly maxFrameMs: number;
}

export const DEFAULT_CLOCK_CONFIG: ClockConfig = {
  minStepSeconds: 1,
  maxStepsPerFrame: 120,
  maxFrameMs: 250,
};

export interface ClockState {
  /** Simulation time, seconds since the scenario epoch. */
  readonly simSeconds: number;
  /** Warp factor. 0 means paused. */
  readonly warp: Warp;
  /** Simulation time owed but not yet consumed, in sim seconds. */
  readonly bankedSeconds: number;
}

export interface FrameResult {
  readonly state: ClockState;
  /** Number of steps executed this frame. */
  readonly steps: number;
  /** Simulation step size used this frame, in sim seconds. */
  readonly stepSeconds: number;
  /** True when the step size had to grow beyond `minStepSeconds` to fit the budget. */
  readonly throttled: boolean;
  /** Simulation seconds advanced this frame. */
  readonly advancedSeconds: number;
}

export function createClock(warp: Warp = 1): ClockState {
  return { simSeconds: 0, warp, bankedSeconds: 0 };
}

/**
 * Advances the clock by one rendered frame.
 *
 * `realMs` is the wall-clock time the frame took, supplied by the caller. The bank is
 * capped at one frame's worth of budget, so a tab regaining focus after minutes in the
 * background cannot try to simulate all of it at once.
 */
export function advanceClock(
  state: ClockState,
  realMs: number,
  config: ClockConfig = DEFAULT_CLOCK_CONFIG,
): FrameResult {
  if (!Number.isFinite(realMs) || realMs < 0) {
    throw new Error('advanceClock: real elapsed time must be finite and non-negative');
  }
  if (!(config.minStepSeconds > 0)) {
    throw new Error('advanceClock: minStepSeconds must be positive');
  }
  if (!(config.maxStepsPerFrame >= 1)) {
    throw new Error('advanceClock: maxStepsPerFrame must be at least 1');
  }

  // Paused: discard owed time rather than banking it, so resuming does not jump.
  if (state.warp === 0) {
    return {
      state: { ...state, bankedSeconds: 0 },
      steps: 0,
      stepSeconds: 0,
      throttled: false,
      advancedSeconds: 0,
    };
  }

  // Clamp the real frame time, not the owed simulation time: a long stall is bounded, but
  // whatever the caller did report is honoured exactly. Clamping owed time instead would
  // make warp silently under-deliver, which is the one thing the clock must never do.
  const clampedMs = Math.min(realMs, config.maxFrameMs);
  const owedThisFrame = (clampedMs / 1000) * state.warp;
  const banked = state.bankedSeconds + owedThisFrame;

  let stepSeconds = config.minStepSeconds;
  let steps = Math.floor(banked / stepSeconds);

  if (steps > config.maxStepsPerFrame) {
    // More owed than the budget can cover at the accuracy floor: coarsen the step so the
    // frame still covers the requested duration, at reduced accuracy.
    stepSeconds = banked / config.maxStepsPerFrame;
    steps = config.maxStepsPerFrame;
  }

  const advancedSeconds = steps * stepSeconds;
  const leftover = Math.max(0, banked - advancedSeconds);

  return {
    state: {
      simSeconds: state.simSeconds + advancedSeconds,
      warp: state.warp,
      bankedSeconds: leftover,
    },
    steps,
    stepSeconds,
    throttled: stepSeconds > config.minStepSeconds,
    advancedSeconds,
  };
}

export function setWarp(state: ClockState, warp: Warp): ClockState {
  return { ...state, warp };
}

/** Formats elapsed simulation seconds as `Nd HH:MM:SS`. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return '--:--:--';
  const sign = seconds < 0 ? '-' : '';
  let s = Math.abs(Math.floor(seconds));
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${sign}${d > 0 ? `${d}d ` : ''}${p2(h)}:${p2(m)}:${p2(s)}`;
}

/** Simulation seconds expressed in days, for Julian-date offsets. */
export const simSecondsToDays = (simSeconds: number): number => simSeconds / SECONDS_PER_DAY;
