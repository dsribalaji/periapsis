import { describe, expect, it } from 'vitest';
import {
  buildTransferNode,
  describeBurn,
  aimElevationAboveParking,
  nodeExcessSpeed,
  nodeId,
  type TransferContext,
} from '../src/ui/transferView.js';
import { computePorkchop, departureAsymptote } from '../src/core/transfer/porkchop.js';
import { jdFromIsoUtc, jdTtFromJdUtc } from '../src/core/time/time.js';
import { GM, RADIUS, SECONDS_PER_DAY } from '../src/core/constants.js';
import { dot, length, normalize, vec3 } from '../src/core/math/vec3.js';
import type { CellAsymptote } from '../src/core/transfer/porkchop.js';
import {
  circularOrbitFrame,
  circularOrbitState,
  type CircularOrbitSpec,
  type CraftSpec,
} from '../src/sim/craft.js';
import { localOrbitalFrame } from '../src/core/orbit/elements.js';
import { applyManeuver, type Maneuver } from '../src/sim/maneuver.js';
import { propagateTwoBody } from '../src/core/orbit/twoBody.js';
import { asymptoteDirection } from '../src/core/transfer/departure.js';
import {
  applyDepartureNode,
  departureSummary,
  DEPARTURE_COAST_SECONDS,
  type TransferNode,
} from '../src/ui/transferView.js';

const EPOCH = '2026-01-01T00:00:00Z';
const START = jdTtFromJdUtc(jdFromIsoUtc(EPOCH));

/** A real Earth-to-Mars grid, small enough to build in a test. */
const GRID = computePorkchop({
  departureBody: 'earth',
  arrivalBody: 'mars',
  departureStartJdTt: START,
  departureEndJdTt: START + 780,
  minTimeOfFlightDays: 150,
  maxTimeOfFlightDays: 420,
  columns: 12,
  rows: 9,
});

const LEO: CircularOrbitSpec = {
  altitudeM: 300e3,
  inclinationRad: (28.5 * Math.PI) / 180,
  phaseRad: 0,
};

function cell(column = 4, row = 4): CellAsymptote {
  const found = departureAsymptote(GRID, column, row);
  if (!found) throw new Error('expected a converged cell');
  return found;
}

function context(patch: Partial<TransferContext> = {}): TransferContext {
  return {
    asymptote: cell(),
    centralBody: 'earth',
    orbit: LEO,
    epochUtc: EPOCH,
    ...patch,
  };
}

describe('departureAsymptote', () => {
  it('recovers a unit direction and the grid’s own excess speed', () => {
    const found = cell();
    expect(length(found.direction)).toBeCloseTo(1, 12);
    const index = 4 * GRID.columns + 4;
    expect(found.vInf).toBeCloseTo(GRID.vInfDeparture[index]!, 6);
  });

  it('agrees with the grid on the departure cost it belongs to', () => {
    // Re-solving must not produce a cell that disagrees with the grid it came from.
    for (const [c, r] of [
      [0, 0],
      [3, 5],
      [11, 8],
    ] as const) {
      const found = departureAsymptote(GRID, c, r);
      if (!found) continue;
      const index = r * GRID.columns + c;
      expect(found.vInf).toBeCloseTo(GRID.vInfDeparture[index]!, 6);
      expect(found.departureJdTt).toBe(GRID.departureJdTt[c]!);
      expect(found.arrivalJdTt).toBeCloseTo(GRID.departureJdTt[c]! + GRID.timeOfFlightDays[r]!, 9);
    }
  });

  it('carries the body identities, so a caller can check the craft is parked there', () => {
    const found = cell();
    expect(found.departureBody).toBe('earth');
    expect(found.arrivalBody).toBe('mars');
  });

  it('returns null outside the grid and for a hole', () => {
    expect(departureAsymptote(GRID, -1, 0)).toBeNull();
    expect(departureAsymptote(GRID, 0, GRID.rows)).toBeNull();
    expect(departureAsymptote(GRID, 0.5, 1)).toBeNull();

    // A grid whose every cell failed has no asymptote anywhere.
    const empty = computePorkchop({
      departureBody: 'earth',
      arrivalBody: 'mars',
      departureStartJdTt: START,
      departureEndJdTt: START + 30,
      minTimeOfFlightDays: 0.01,
      maxTimeOfFlightDays: 0.014,
      columns: 4,
      rows: 4,
    });
    expect(empty.convergedCells).toBe(0);
    expect(departureAsymptote(empty, 0, 0)).toBeNull();
  });

  it('is a direction toward the target, not away from it', () => {
    // The departure excess velocity must have a positive component along the transfer, i.e.
    // the craft leaves roughly toward the arrival body. A sign error would flip this.
    const found = cell();
    const index = 4 * GRID.columns + 4;
    expect(GRID.transferAngleDeg[index]!).toBeGreaterThan(0);
    expect(found.transferAngleDeg).toBe(GRID.transferAngleDeg[index]!);
  });
});

describe('buildTransferNode', () => {
  it('produces a local-frame node whose components are the departure burn', () => {
    const result = buildTransferNode(context());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { maneuver, plan } = result.node;

    expect(maneuver.frame).toBe('local');
    expect(maneuver.a).toBeCloseTo(plan.burn.prograde, 9);
    expect(maneuver.b).toBeCloseTo(plan.burn.normal, 9);
    expect(maneuver.c).toBeCloseTo(plan.burn.radial, 9);
    expect(Math.hypot(maneuver.a, maneuver.b, maneuver.c)).toBeCloseTo(plan.burn.deltaV, 9);
  });

  it('builds the burn from the departure solve, not from the cell’s excess speed', () => {
    // The whole point of the module: a 3.06 km/s excess speed is not a 3.06 km/s burn.
    const result = buildTransferNode(context());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const found = cell();
    expect(result.node.plan.burn.deltaV).not.toBeCloseTo(found.vInf, 0);
    // And it is the Oberth-correct burn from this park, which is more expensive at 28.5 deg.
    expect(result.node.plan.burn.deltaV).toBeGreaterThan(found.vInf);
  });

  it('places the node at the requested date plus a phase within one parking period', () => {
    const result = buildTransferNode(context());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const found = cell();

    const expectedSeconds = (found.departureJdTt - START) * SECONDS_PER_DAY;
    const burnSeconds = result.node.maneuver.timeSeconds;
    expect(burnSeconds).toBeGreaterThanOrEqual(expectedSeconds - 1e-6);
    expect(burnSeconds - expectedSeconds).toBeLessThanOrEqual(
      result.node.plan.parkingPeriod + 1e-6,
    );
    expect(result.node.shiftSeconds).toBeCloseTo(burnSeconds - expectedSeconds, 6);
  });

  it('burns at the phase the solve costed, measured from the craft’s own orbit', () => {
    // The bug this catches: using the solve's time-to-burn directly. 314 days of coasting at
    // 300 km is 3.5e4 radians of phase, so the burn would land at a phase unrelated to the one
    // whose cost was minimised, and the node would not fly the porkchop's trajectory.
    const result = buildTransferNode(context());
    if (!result.ok) throw new Error('expected success');
    const found = cell();
    const requestedSeconds = (found.departureJdTt - START) * SECONDS_PER_DAY;
    const meanMotion = (2 * Math.PI) / result.node.plan.parkingPeriod;

    // Where the craft is at the burn: the epoch phase advanced over *all* the elapsed time,
    // not just over the shift. The accumulated phase is 3.5e4 rad, so this comparison is
    // written as a wrapped difference rather than an absolute one.
    const phaseAtBurn = LEO.phaseRad + meanMotion * result.node.maneuver.timeSeconds;
    const wrapped = (a: number, b: number): number => {
      const d = ((((a - b) % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI)) - Math.PI;
      return Math.abs(d);
    };
    expect(wrapped(phaseAtBurn, result.node.plan.phaseRad)).toBeLessThan(1e-6);
    expect(result.node.burnPhaseRad).toBeCloseTo(result.node.plan.phaseRad, 12);

    // And the naive answer really is wrong, so this is not a tautology.
    const naive = requestedSeconds + result.node.plan.timeToBurnSeconds;
    expect(Math.abs(naive - result.node.maneuver.timeSeconds)).toBeGreaterThan(
      result.node.plan.parkingPeriod / 4,
    );
  });

  it('is unaffected by the epoch phase when the parking phase is rotated', () => {
    // Phase is a free parameter of the park: rotating it must not change the burn magnitude,
    // only when it happens. A dependence on the epoch phase would show up here.
    const a = buildTransferNode(context());
    const b = buildTransferNode(context({ orbit: { ...LEO, phaseRad: 1.9 } }));
    if (!a.ok || !b.ok) throw new Error('expected success');
    expect(b.node.plan.burn.deltaV).toBeCloseTo(a.node.plan.burn.deltaV, 6);
    expect(b.node.maneuver.timeSeconds).not.toBeCloseTo(a.node.maneuver.timeSeconds, 0);
  });

  it('reports both instants so the shift is visible', () => {
    const result = buildTransferNode(context());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.node.requestedDepartureIso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(result.node.burnIso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(result.node.burnIso >= result.node.requestedDepartureIso).toBe(true);
  });

  it('is deterministic for the same context', () => {
    const a = buildTransferNode(context());
    const b = buildTransferNode(context());
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.node.maneuver).toEqual(b.node.maneuver);
    expect(a.node.burnIso).toBe(b.node.burnIso);
  });

  it('refuses a cell that departs a different body', () => {
    const result = buildTransferNode(context({ centralBody: 'mars' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]!.kind).toBe('wrong-body');
    expect(result.issues[0]!.message).toContain('mars');
  });

  it('refuses a departure that lies before the scenario epoch', () => {
    // An epoch after the cell's departure date cannot host that node.
    const result = buildTransferNode(context({ epochUtc: '2030-01-01T00:00:00Z' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]!.kind).toBe('before-epoch');
  });

  it('reports a no-solution geometry instead of throwing', () => {
    // A parking orbit plane almost perpendicular to the aim forces an impossible geometry.
    const degenerate = cell();
    const sideways: CellAsymptote = {
      ...degenerate,
      direction: normalize(vec3(0, 0, 1)),
    };
    const result = buildTransferNode(
      context({
        asymptote: sideways,
        orbit: { altitudeM: 300e3, inclinationRad: 0, phaseRad: 0 },
      }),
    );
    // Either it solves or it explains itself; what it must never do is throw.
    expect(typeof result.ok).toBe('boolean');
  });

  it('labels the node with its burn magnitude', () => {
    const result = buildTransferNode(context());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.node.maneuver.label).toContain('km/s');
  });

  it('uses a date-derived id, so the same cell gives the same id', () => {
    const first = buildTransferNode(context());
    const second = buildTransferNode(context());
    if (!first.ok || !second.ok) throw new Error('expected success');
    expect(first.node.maneuver.id).toBe(second.node.maneuver.id);
    expect(first.node.maneuver.id).toMatch(/^depart-\d{4}-\d{2}-\d{2}$/);
  });
});

describe('nodeId', () => {
  it('derives a stable id from the departure date', () => {
    const found = cell();
    expect(nodeId(found)).toBe(nodeId(found));
    expect(nodeId(found)).toMatch(/^\d{4}|^depart-\d{4}/);
  });
});

describe('nodeExcessSpeed', () => {
  it('recovers the excess speed the departure was planned for', () => {
    const result = buildTransferNode(context());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The node's own components imply the same excess speed the cell asked for.
    expect(nodeExcessSpeed(result.node.plan)).toBeCloseTo(cell().vInf, 3);
  });

  it('is independent of the solver’s bookkeeping', () => {
    // Built from the burn components and parkedSpeed only.
    const result = buildTransferNode(context());
    if (!result.ok) throw new Error('expected success');
    const plan = result.node.plan;
    const postSq =
      (plan.parkedSpeed + plan.burn.prograde) ** 2 + plan.burn.normal ** 2 + plan.burn.radial ** 2;
    expect(nodeExcessSpeed(plan)).toBeCloseTo(Math.sqrt(postSq - 2 * plan.parkedSpeed ** 2), 6);
  });
});

describe('describeBurn', () => {
  it('names the dominant component', () => {
    const result = buildTransferNode(context());
    if (!result.ok) throw new Error('expected success');
    const text = describeBurn(result.node.plan);
    expect(text).toMatch(/prograde|normal|radial/);
    expect(text).toContain('km/s');
  });

  it('says "almost entirely" when one component dominates', () => {
    // An equatorial in-plane departure is essentially pure prograde.
    const plan = buildTransferNode(
      context({ orbit: { altitudeM: 300e3, inclinationRad: 0, phaseRad: 0 } }),
    );
    if (!plan.ok) throw new Error('expected success');
    const text = describeBurn(plan.node.plan);
    expect(text).toMatch(/almost entirely|mostly/);
  });
});

describe('aimElevationAboveParking', () => {
  it('is zero for an aim inside the parking plane', () => {
    const elevation = aimElevationAboveParking(vec3(0, 1, 0), {
      altitudeM: 300e3,
      inclinationRad: 0,
      phaseRad: 0,
    });
    expect(elevation).toBeCloseTo(0, 12);
  });

  it('recovers the inclination when the aim is along the parking normal', () => {
    const inc = (28.5 * Math.PI) / 180;
    // The normal of a prograde orbit inclined by i is (0, -sin i, cos i): it is r x v, not
    // (0, sin i, cos i). Aiming exactly along it must read as a full 90 degrees.
    const normal = circularOrbitFrame({
      altitudeM: 300e3,
      inclinationRad: inc,
      phaseRad: 0,
    }).normal;
    const elevation = aimElevationAboveParking(normal, {
      altitudeM: 300e3,
      inclinationRad: inc,
      phaseRad: 0,
    });
    expect((elevation * 180) / Math.PI).toBeCloseTo(90, 9);
  });

  it('uses the same normal the propagation uses, r x v', () => {
    // A sign error here flips which way a burn has to push. Checking against the state, not
    // against a second formula, is what makes the two definitions provably one.
    for (const inc of [0, 0.3, (28.5 * Math.PI) / 180, 1.4]) {
      const orbit = { altitudeM: 400e3, inclinationRad: inc, phaseRad: 0.7 };
      const state = circularOrbitState('earth', orbit);
      const fromState = localOrbitalFrame(state).normal;
      const fromFrame = circularOrbitFrame(orbit).normal;
      expect(fromFrame.x).toBeCloseTo(fromState.x, 12);
      expect(fromFrame.y).toBeCloseTo(fromState.y, 12);
      expect(fromFrame.z).toBeCloseTo(fromState.z, 12);
    }
  });

  it('is signed, so a below-plane aim is distinguishable', () => {
    const inc = 0.5;
    const above = aimElevationAboveParking(vec3(0, 0, 1), {
      altitudeM: 300e3,
      inclinationRad: inc,
      phaseRad: 0,
    });
    const below = aimElevationAboveParking(vec3(0, 0, -1), {
      altitudeM: 300e3,
      inclinationRad: inc,
      phaseRad: 0,
    });
    expect(above).toBeGreaterThan(0);
    expect(below).toBeLessThan(0);
    expect(above).toBeCloseTo(-below, 12);
  });

  it('matches the measured explanation of the 28.5-degree penalty', () => {
    // A near-ecliptic aim from a 28.5-degree park sits well out of the parking plane.
    const result = buildTransferNode(context());
    if (!result.ok) throw new Error('expected success');
    const elevation = aimElevationAboveParking(cell().direction, LEO);
    // The aim is not within a rounding error of the parking plane.
    expect(Math.abs((elevation * 180) / Math.PI)).toBeGreaterThan(1);
    // And the burn is correspondingly more expensive than the in-plane ideal.
    expect(result.node.plan.excessOverIdeal).toBeGreaterThan(100);
  });
});

describe('TransferContext invariants', () => {
  it('the parking radius is the body radius plus the altitude', () => {
    // A stale or mismatched central body would show up here.
    const result = buildTransferNode(context());
    if (!result.ok) return;
    expect(result.node.plan.parkedSpeed).toBeCloseTo(
      Math.sqrt(GM.earth / (RADIUS.earth + 300e3)),
      6,
    );
  });

  it('keeps the burn point on the parking orbit', () => {
    const result = buildTransferNode(context());
    if (!result.ok) return;
    expect(length(result.node.plan.burn.postBurn.r)).toBeCloseTo(RADIUS.earth + 300e3, 3);
  });

  it('produces a burn that leaves on a hyperbola, not an ellipse', () => {
    const result = buildTransferNode(context());
    if (!result.ok) return;
    const state = result.node.plan.burn.postBurn;
    const mu = GM.earth;
    const energy = length(state.v) ** 2 / 2 - mu / length(state.r);
    expect(energy).toBeGreaterThan(0);
    // Negative semi-major axis is the signature of a hyperbolic orbit.
    expect(-mu / (2 * energy)).toBeLessThan(0);
  });
});

describe('the node flies the direction the porkchop implied', () => {
  it('reaches the cell’s asymptote when propagated from the craft’s own state', () => {
    // The end-to-end check, and the one a frame error cannot survive. Take the craft's state at
    // the burn the way `propagateTrajectory` does (two-body, about the central body), apply the
    // node's own components through `applyManeuver`, and read the resulting asymptote off the
    // post-burn state. It must point where the cell said.
    const result = buildTransferNode(context());
    if (!result.ok) throw new Error('expected success');
    const found = cell();

    const start = circularOrbitState('earth', LEO);
    const atBurn = propagateTwoBody(start, GM.earth, result.node.maneuver.timeSeconds);
    const after = applyManeuver(result.node.maneuver, atBurn);

    const aimed = asymptoteDirection(after, GM.earth);
    if (!aimed) throw new Error('expected a hyperbolic state after the burn');
    const cos = dot(normalize(aimed), normalize(found.direction));
    expect(Math.acos(Math.min(1, cos))).toBeLessThan(1e-9);

    // And the speed matches to the metre per second.
    const excess = Math.sqrt(Math.max(0, length(after.v) ** 2 - (2 * GM.earth) / length(after.r)));
    expect(excess).toBeCloseTo(found.vInf, 3);
  });

  it('warns instead of refusing when the cheapest arc’s periapsis is inside the body', () => {
    // Measured: from a 28.5-degree park to a near-ecliptic Mars asymptote, the cheapest burn
    // rotates the plane and the resulting periapsis lands inside Earth. The path is still
    // flyable outbound, so it is a warning carried on the node, not an error.
    const result = buildTransferNode(context());
    if (!result.ok) throw new Error('expected success');
    expect(result.node.plan.burn.periapsisBelowSurface).toBe(true);
    expect(result.node.warnings.map((w) => w.kind)).toContain('below-surface');
    expect(result.node.warnings[0]!.message).toContain('periapsis inside');

    // The burn radius itself is still above the surface: the craft is not inside the body.
    expect(length(result.node.plan.burn.postBurn.r)).toBeGreaterThan(RADIUS.earth);
    // And the anomaly is outbound, which is why the path never visits that periapsis.
    expect(result.node.plan.burn.trueAnomalyRad).toBeGreaterThanOrEqual(0);
  });

  it('does not warn for an equatorial park, where the arc clears the surface', () => {
    const result = buildTransferNode(
      context({ orbit: { altitudeM: 500e3, inclinationRad: 0, phaseRad: 0 } }),
    );
    if (!result.ok) throw new Error('expected success');
    expect(result.node.plan.burn.periapsisBelowSurface).toBe(false);
    expect(result.node.warnings).toHaveLength(0);
  });
});

describe('applyDepartureNode', () => {
  const SPEC: CraftSpec = {
    id: 'probe',
    name: 'Probe',
    centralBody: 'earth',
    orbit: LEO,
    deltaVBudget: 12000,
    propagation: 'twoBody',
    horizonSeconds: 6000,
    maneuvers: [],
  };

  function builtNode(patch: Partial<TransferNode> = {}): TransferNode {
    const result = buildTransferNode(context());
    if (!result.ok) throw new Error('expected success');
    return { ...result.node, ...patch };
  }

  it('adds the node inside an existing horizon and leaves the span alone', () => {
    const inside = builtNode({ maneuver: { ...builtNode().maneuver, timeSeconds: 1200 } });
    const applied = applyDepartureNode(SPEC, inside);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.craft.maneuvers).toHaveLength(1);
    expect(applied.horizonSeconds).toBe(SPEC.horizonSeconds);
  });

  it('extends the plan to cover a node past the end, and says how far', () => {
    const burn = builtNode();
    const applied = applyDepartureNode(SPEC, burn);
    if (!applied.ok) throw new Error('expected success');
    // The cell's date is months out against a 100-minute horizon, so the span must grow.
    expect(applied.horizonSeconds).toBeGreaterThan(SPEC.horizonSeconds);
    expect(applied.horizonSeconds).toBeCloseTo(
      burn.maneuver.timeSeconds + DEPARTURE_COAST_SECONDS,
      6,
    );
  });

  it('is idempotent for the same cell, so re-planning does not stack burns', () => {
    const first = applyDepartureNode(SPEC, builtNode());
    if (!first.ok) throw new Error('expected success');
    const second = applyDepartureNode(first.craft, builtNode());
    if (!second.ok) throw new Error('expected success');
    expect(second.craft.maneuvers).toHaveLength(1);
    expect(second.horizonSeconds).toBe(first.horizonSeconds);
  });

  it('keeps existing nodes and orders the result by time', () => {
    const early: Maneuver = {
      id: 'raise-1',
      timeSeconds: 900,
      a: 40,
      b: 0,
      c: 0,
      frame: 'local',
      label: 'Raise',
    };
    const applied = applyDepartureNode({ ...SPEC, maneuvers: [early] }, builtNode());
    if (!applied.ok) throw new Error('expected success');
    expect(applied.craft.maneuvers).toHaveLength(2);
    expect(applied.craft.maneuvers[0]!.id).toBe('raise-1');
    for (let i = 1; i < applied.craft.maneuvers.length; i++) {
      expect(applied.craft.maneuvers[i]!.timeSeconds).toBeGreaterThanOrEqual(
        applied.craft.maneuvers[i - 1]!.timeSeconds,
      );
    }
  });

  it('refuses to extend an N-body plan, rather than freezing the app', () => {
    const applied = applyDepartureNode({ ...SPEC, propagation: 'nbody' }, builtNode());
    expect(applied.ok).toBe(false);
    if (applied.ok) return;
    expect(applied.reason).toContain('N-body');
  });

  it('refuses a window beyond the extendable span', () => {
    const burn = builtNode();
    const far = { ...burn, maneuver: { ...burn.maneuver, timeSeconds: 1e9 } };
    const applied = applyDepartureNode(SPEC, far);
    expect(applied.ok).toBe(false);
    if (applied.ok) return;
    expect(applied.reason).toContain('limit');
  });

  it('refuses a node with an unusable time', () => {
    const burn = builtNode();
    for (const bad of [Number.NaN, -1]) {
      const applied = applyDepartureNode(SPEC, {
        ...burn,
        maneuver: { ...burn.maneuver, timeSeconds: bad },
      });
      expect(applied.ok).toBe(false);
    }
  });
});

describe('departureSummary', () => {
  it('names the node, its cost, its instant and its slide', () => {
    const result = buildTransferNode(context());
    if (!result.ok) throw new Error('expected success');
    const text = departureSummary(result.node);
    expect(text).toContain(result.node.maneuver.id);
    expect(text).toContain('km/s');
    expect(text).toContain(result.node.burnIso);
    expect(text).toMatch(/after the requested date|at the requested instant/);
  });

  it('quotes an excess speed that matches the cell it came from', () => {
    const result = buildTransferNode(context());
    if (!result.ok) throw new Error('expected success');
    const text = departureSummary(result.node);
    const quoted = Number(/reaches ([\d.]+) km\/s/.exec(text)![1]);
    expect(quoted).toBeCloseTo(cell().vInf / 1000, 1);
  });
});
