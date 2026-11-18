import { describe, expect, it } from 'vitest';
import { buildMissionPlan, missionProgress } from '../src/ui/missionView.js';
import type { CraftSpec } from '../src/sim/craft.js';
import { BODIES } from '../src/core/ephemeris/solarSystem.js';

const EPOCH = '2026-11-18T12:00:00Z';

function spec(patch: Partial<CraftSpec> = {}): CraftSpec {
  return {
    id: 'sat',
    name: 'Sat',
    centralBody: 'earth',
    orbit: { altitudeM: 550e3, inclinationRad: 0.9, phaseRad: 0 },
    deltaVBudget: 120,
    propagation: 'twoBody',
    horizonSeconds: 11600,
    maneuvers: [],
    ...patch,
  };
}

const R_ORBIT = BODIES.earth.radius + 550e3;

describe('mission plan', () => {
  it('reports the circular speed and period of the initial orbit', () => {
    const plan = buildMissionPlan(spec(), EPOCH);
    expect(plan.initialSpeed).toBeGreaterThan(7500);
    expect(plan.initialSpeed).toBeLessThan(7700);
    expect(plan.initialPeriod / 60).toBeGreaterThan(94);
    expect(plan.initialPeriod / 60).toBeLessThan(97);
  });

  it('keeps a node-free circular orbit at a constant radius', () => {
    const plan = buildMissionPlan(spec(), EPOCH);
    expect(plan.minRadius).toBeCloseTo(R_ORBIT, -2);
    // Two-body propagation is exact, so the spread is only sampling noise.
    expect(plan.maxRadius - plan.minRadius).toBeLessThan(R_ORBIT * 1e-6 + 1);
  });

  it('raises apoapsis when a prograde node is planned on a circular orbit', () => {
    // A prograde burn on a circular orbit puts the burn point at periapsis and lifts apoapsis.
    const plan = buildMissionPlan(
      spec({ maneuvers: [{ id: 'b1', timeSeconds: 2900, a: 62, b: 0, c: 0, frame: 'local' }] }),
      EPOCH,
    );
    expect(plan.maxRadius).toBeGreaterThan(R_ORBIT + 100e3);
    expect(plan.minRadius).toBeCloseTo(R_ORBIT, -2);
  });

  it('totals planned delta-v as the sum of magnitudes', () => {
    const plan = buildMissionPlan(
      spec({
        maneuvers: [
          { id: 'b1', timeSeconds: 100, a: 30, b: 0, c: 0, frame: 'local' },
          { id: 'b2', timeSeconds: 200, a: 0, b: 40, c: 0, frame: 'local' },
        ],
      }),
      EPOCH,
    );
    expect(plan.plannedDeltaV).toBeCloseTo(70, 9);
    expect(plan.remainingDeltaV).toBeCloseTo(50, 9);
  });

  it('goes negative when the plan overdraws the budget', () => {
    const plan = buildMissionPlan(
      spec({
        deltaVBudget: 50,
        maneuvers: [{ id: 'b1', timeSeconds: 100, a: 70, b: 0, c: 0, frame: 'local' }],
      }),
      EPOCH,
    );
    expect(plan.remainingDeltaV).toBeCloseTo(-20, 9);
  });

  it('labels a node by its label, falling back to its id', () => {
    const plan = buildMissionPlan(
      spec({
        maneuvers: [
          { id: 'b1', timeSeconds: 100, a: 1, b: 0, c: 0, frame: 'local', label: 'Raise' },
          { id: 'b2', timeSeconds: 200, a: 1, b: 0, c: 0, frame: 'local' },
        ],
      }),
      EPOCH,
    );
    expect(plan.nodes.map((n) => n.label)).toEqual(['Raise', 'b2']);
  });

  it('produces drawable geometry', () => {
    const plan = buildMissionPlan(spec(), EPOCH);
    expect(plan.frame.positions.length).toBeGreaterThan(0);
    expect(plan.frame.unitsPerMetre).toBeGreaterThan(0);
    expect(plan.frame.extentUnits).toBeGreaterThan(0);
  });

  it('does not report an impact for a healthy orbit', () => {
    expect(buildMissionPlan(spec(), EPOCH).impacts).toBe(false);
  });

  it('reports an impact when the orbit reaches the surface', () => {
    const plan = buildMissionPlan(
      spec({
        // A retrograde burn large enough to drop periapsis below the surface.
        maneuvers: [{ id: 'b1', timeSeconds: 0, a: -2000, b: 0, c: 0, frame: 'local' }],
      }),
      EPOCH,
    );
    expect(plan.impacts).toBe(true);
  });
});

describe('mission progress', () => {
  it('starts at the first sample when the clock is at zero', () => {
    const plan = buildMissionPlan(spec(), EPOCH);
    const p = missionProgress(plan, 0);
    expect(p.position).not.toBeNull();
    expect(p.flownSegments).toBe(0);
    expect(p.spentDeltaV).toBe(0);
  });

  it('reports a radius that matches the initial orbit at t = 0', () => {
    const plan = buildMissionPlan(spec(), EPOCH);
    const p = missionProgress(plan, 0);
    expect(p.radius).toBeCloseTo(R_ORBIT, -3);
    expect(p.altitude).toBeCloseTo(550e3, -3);
  });

  it('advances the craft with the clock', () => {
    const plan = buildMissionPlan(spec(), EPOCH);
    const a = missionProgress(plan, 0).position!;
    const b = missionProgress(plan, 600).position!;
    const moved = Math.abs(b.x - a.x) + Math.abs(b.y - a.y) + Math.abs(b.z - a.z);
    expect(moved).toBeGreaterThan(0);
  });

  it('splits flown and future segments at the clock', () => {
    const plan = buildMissionPlan(spec(), EPOCH);
    const early = missionProgress(plan, 0);
    const late = missionProgress(plan, 6000);
    expect(early.flownSegments).toBe(0);
    expect(late.flownSegments).toBeGreaterThan(0);
    expect(late.flownSegments).toBeLessThanOrEqual(plan.frame.segmentTimes.length);
  });

  it('counts a node as spent once the clock passes it, not before', () => {
    const plan = buildMissionPlan(
      spec({
        maneuvers: [
          { id: 'b1', timeSeconds: 100, a: 10, b: 0, c: 0, frame: 'local' },
          { id: 'b2', timeSeconds: 9000, a: 10, b: 0, c: 0, frame: 'local' },
        ],
      }),
      EPOCH,
    );
    expect(missionProgress(plan, 0).spentDeltaV).toBe(0);
    expect(missionProgress(plan, 50).appliedNodeIds).toEqual([]);
    expect(missionProgress(plan, 100).appliedNodeIds).toEqual(['b1']);
    expect(missionProgress(plan, 100).spentDeltaV).toBeCloseTo(10, 9);
    expect(missionProgress(plan, 9500).appliedNodeIds).toEqual(['b1', 'b2']);
    expect(missionProgress(plan, 9500).spentDeltaV).toBeCloseTo(20, 9);
  });

  it('clamps past the end of the path instead of returning nothing', () => {
    const plan = buildMissionPlan(spec(), EPOCH);
    const past = missionProgress(plan, plan.horizonSeconds * 4);
    expect(past.position).not.toBeNull();
    expect(past.flownSegments).toBe(plan.frame.segmentTimes.length);
  });

  it('interpolates between samples rather than snapping', () => {
    const plan = buildMissionPlan(spec(), EPOCH);
    const times = plan.frame.pointTimes;
    const mid = (times[0]! + times[1]!) / 2;
    const a = missionProgress(plan, times[0]!).position!;
    const b = missionProgress(plan, times[1]!).position!;
    const m = missionProgress(plan, mid).position!;
    // The midpoint must lie between the two samples on each axis.
    for (const axis of ['x', 'y', 'z'] as const) {
      const lo = Math.min(a[axis], b[axis]);
      const hi = Math.max(a[axis], b[axis]);
      expect(m[axis]).toBeGreaterThanOrEqual(lo - 1e-6);
      expect(m[axis]).toBeLessThanOrEqual(hi + 1e-6);
    }
  });
});
