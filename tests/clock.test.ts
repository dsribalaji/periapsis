import { describe, expect, it } from 'vitest';
import {
  advanceClock,
  createClock,
  formatDuration,
  setWarp,
  simSecondsToDays,
  DEFAULT_CLOCK_CONFIG,
  type ClockState,
} from '../src/sim/clock.js';
import { SECONDS_PER_DAY } from '../src/core/constants.js';

/** Runs `frames` frames of `realMs` each and returns the final state. */
function runFrames(start: ClockState, frames: number, realMs: number): ClockState {
  let s = start;
  for (let i = 0; i < frames; i++) s = advanceClock(s, realMs).state;
  return s;
}

const STEP = DEFAULT_CLOCK_CONFIG.minStepSeconds;

describe('simulation clock', () => {
  it('advances sim time at real time when warp is 1', () => {
    // 60 fps at warp 1 for 10 real seconds must yield about 10 sim seconds. This is the
    // case that a real-time bank would break outright: 16.7 ms per frame can never reach a
    // 1 s step, so the clock would never move.
    const s = runFrames(createClock(1), 600, 16.667);
    const realSeconds = (600 * 16.667) / 1000;
    expect(Math.abs(s.simSeconds - realSeconds)).toBeLessThanOrEqual(STEP);
  });

  it('scales sim time by the warp factor', () => {
    const one = runFrames(createClock(1), 600, 16.667);
    const thousand = runFrames(createClock(1000), 600, 16.667);
    const ratio = thousand.simSeconds / one.simSeconds;
    // Same frame count, so warp 1000 must advance ~1000x the sim time.
    expect(ratio).toBeGreaterThan(900);
    expect(ratio).toBeLessThan(1100);
  });

  it('is linear in warp below the budget', () => {
    // One frame's worth of owed time, small enough that no step coarsening occurs.
    const realMs = 16.667;
    const at1 = runFrames(createClock(1), 600, realMs).simSeconds;
    const at10 = runFrames(createClock(10), 600, realMs).simSeconds;
    expect(at10 / at1).toBeGreaterThan(9);
    expect(at10 / at1).toBeLessThan(11);
  });

  it('does not advance while paused, and does not bank time', () => {
    const paused = setWarp(createClock(1), 0);
    const result = advanceClock(paused, 500);
    expect(result.steps).toBe(0);
    expect(result.advancedSeconds).toBe(0);
    expect(result.state.simSeconds).toBe(0);
    expect(result.state.bankedSeconds).toBe(0);
  });

  it('resuming after a pause does not jump forward', () => {
    let s = setWarp(createClock(1), 0);
    for (let i = 0; i < 100; i++) s = advanceClock(s, 16.667).state; // ~1.7 s paused
    s = setWarp(s, 1);
    const afterOneFrame = advanceClock(s, 16.667).state;
    // One frame at warp 1 cannot advance a whole step from a standing start.
    expect(afterOneFrame.simSeconds).toBeLessThanOrEqual(STEP);
  });

  it('caps the bank so a long stall cannot cause a catch-up burst', () => {
    const result = advanceClock(createClock(1), 600_000); // 10 minutes in one frame
    // The stall is clamped to one maxFrameMs, so at most that much real time is simulated.
    expect(result.advancedSeconds).toBeLessThanOrEqual(
      DEFAULT_CLOCK_CONFIG.maxFrameMs / 1000 + DEFAULT_CLOCK_CONFIG.minStepSeconds,
    );
    expect(result.steps).toBeLessThanOrEqual(DEFAULT_CLOCK_CONFIG.maxStepsPerFrame);
  });

  it('honours the step budget at every warp factor', () => {
    for (const warp of [1, 10, 1e3, 1e6, 1e7] as const) {
      const result = advanceClock(createClock(warp), 16.667);
      expect(result.steps).toBeLessThanOrEqual(DEFAULT_CLOCK_CONFIG.maxStepsPerFrame);
    }
  });

  it('never loses time: advanced seconds equal steps times step size', () => {
    for (const warp of [1, 10, 100, 1e4, 1e7] as const) {
      const result = advanceClock(createClock(warp), 16.667);
      expect(result.advancedSeconds).toBeCloseTo(result.steps * result.stepSeconds, 9);
    }
  });

  it('keeps the accuracy floor at low warp', () => {
    const result = advanceClock(createClock(1), 16.667);
    expect(result.stepSeconds).toBe(STEP);
    expect(result.throttled).toBe(false);
  });

  it('coarsens the step instead of dropping time at extreme warp', () => {
    const result = advanceClock(createClock(1e7), 16.667);
    expect(result.throttled).toBe(true);
    expect(result.stepSeconds).toBeGreaterThan(STEP);
    // Nothing is silently discarded: the requested duration is covered by the steps run.
    const owed = (16.667 / 1000) * 1e7;
    expect(result.advancedSeconds).toBeCloseTo(owed, 6);
  });

  it('tracks total sim time as the sum of frame advances', () => {
    let s = createClock(100);
    let total = 0;
    for (let i = 0; i < 50; i++) {
      const r = advanceClock(s, 16.667);
      total += r.advancedSeconds;
      s = r.state;
    }
    expect(s.simSeconds).toBeCloseTo(total, 6);
  });

  it('accumulates fractional steps rather than discarding them', () => {
    // Each frame owes less than one step; the clock must still progress every ~60 frames.
    let s = createClock(1);
    for (let i = 0; i < 60; i++) s = advanceClock(s, 16.667).state;
    expect(s.simSeconds).toBeGreaterThanOrEqual(STEP);
  });

  it('is deterministic for identical frame sequences', () => {
    const a = runFrames(createClock(1000), 200, 16.667);
    const b = runFrames(createClock(1000), 200, 16.667);
    expect(a).toEqual(b);
  });

  it('is independent of frame rate at the same total elapsed time', () => {
    // 60 fps for 2 s vs 30 fps for 2 s: the same simulation must be traversed.
    const fast = runFrames(createClock(100), 120, 16.667);
    const slow = runFrames(createClock(100), 60, 33.333);
    expect(Math.abs(fast.simSeconds - slow.simSeconds) / fast.simSeconds).toBeLessThan(0.05);
  });

  it('rejects non-physical elapsed time', () => {
    expect(() => advanceClock(createClock(1), -1)).toThrow(/non-negative/);
    expect(() => advanceClock(createClock(1), Number.NaN)).toThrow(/finite/);
    expect(() => advanceClock(createClock(1), Number.POSITIVE_INFINITY)).toThrow(/finite/);
  });

  it('rejects a non-positive step size or empty budget', () => {
    expect(() =>
      advanceClock(createClock(1), 16, { ...DEFAULT_CLOCK_CONFIG, minStepSeconds: 0 }),
    ).toThrow(/positive/);
    expect(() =>
      advanceClock(createClock(1), 16, { ...DEFAULT_CLOCK_CONFIG, maxStepsPerFrame: 0 }),
    ).toThrow(/at least 1/);
  });

  it('does not advance for a zero-length frame', () => {
    const result = advanceClock(createClock(1e7), 0);
    expect(result.advancedSeconds).toBe(0);
    expect(result.state.simSeconds).toBe(0);
  });
});

describe('duration formatting', () => {
  it('formats hours, minutes and seconds', () => {
    expect(formatDuration(0)).toBe('00:00:00');
    expect(formatDuration(59)).toBe('00:00:59');
    expect(formatDuration(3661)).toBe('01:01:01');
  });

  it('includes days when present', () => {
    expect(formatDuration(86400)).toBe('1d 00:00:00');
    expect(formatDuration(86400 * 2 + 3661)).toBe('2d 01:01:01');
  });

  it('handles negative and non-finite input', () => {
    expect(formatDuration(-61)).toBe('-00:01:01');
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe('--:--:--');
  });
});

describe('day conversion', () => {
  it('converts seconds to days', () => {
    expect(simSecondsToDays(SECONDS_PER_DAY)).toBe(1);
    expect(simSecondsToDays(SECONDS_PER_DAY * 365.25)).toBeCloseTo(365.25, 9);
  });
});
