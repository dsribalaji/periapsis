import { describe, expect, it } from 'vitest';
import {
  SCENARIOS,
  defaultScenario,
  scenarioById,
  DEFAULT_SCENARIO_ID,
} from '../src/scenarios/catalogue.js';
import { validateScenario, assertScenario } from '../src/scenarios/validate.js';
import { SCENARIO_SCHEMA_VERSION } from '../src/scenarios/types.js';
import { jdFromIsoUtc, jdTtFromJdUtc } from '../src/core/time/time.js';
import { BODIES, type BodyId } from '../src/core/ephemeris/solarSystem.js';
import { WARP_STEPS } from '../src/sim/clock.js';
import { hohmannTransfer } from '../src/core/transfer/transfers.js';
import { SECONDS_PER_DAY } from '../src/core/constants.js';
import { bodyPosition } from '../src/core/ephemeris/ephemeris.js';
import { craftFromSpec } from '../src/sim/craft.js';
import { propagateTrajectory, type PropagationMode } from '../src/sim/trajectory.js';

const valid = {
  schemaVersion: SCENARIO_SCHEMA_VERSION,
  id: 'test',
  name: 'Test',
  description: 'A test scenario.',
  epochUtc: '2026-11-18T12:00:00Z',
  startWarp: 1e4,
  focus: 'earth',
  view: {
    radialMode: 'linear',
    azimuthRad: 0.5,
    elevationRad: 0.4,
    distanceUnits: 200,
    centeredOn: 'sun',
  },
};

/** Mutates a copy of `valid`, so each case states only what it is changing. */
function withChange(patch: Record<string, unknown>): Record<string, unknown> {
  return { ...structuredClone(valid), ...patch };
}

describe('bundled scenarios', () => {
  it('validates every bundled entry', () => {
    for (const s of SCENARIOS) {
      const result = validateScenario(s);
      expect(result.ok, `${s.id} should be valid: ${JSON.stringify(result)}`).toBe(true);
    }
  });

  it('has unique ids', () => {
    const ids = SCENARIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('includes the default id in the catalogue', () => {
    expect(scenarioById(DEFAULT_SCENARIO_ID)).toBeDefined();
    expect(defaultScenario().id).toBe(DEFAULT_SCENARIO_ID);
  });

  it('throws a descriptive error for a missing default', () => {
    expect(scenarioById('no-such-scenario')).toBeUndefined();
  });

  it('names a real body as each focus', () => {
    for (const s of SCENARIOS) expect(Object.keys(BODIES)).toContain(s.focus);
  });

  it('uses a warp step the clock actually offers', () => {
    for (const s of SCENARIOS) expect(WARP_STEPS as readonly number[]).toContain(s.startWarp);
  });

  it('parses every epoch with the same parser the simulation uses', () => {
    for (const s of SCENARIOS) expect(Number.isFinite(jdFromIsoUtc(s.epochUtc))).toBe(true);
  });

  it('names the Earth-Moon scenario as focusing on a body rather than the Sun', () => {
    // A 60-unit camera aimed at the Sun from Earth would show neither Earth nor the Moon.
    const pair = scenarioById('earth-moon');
    expect(pair?.view.centeredOn).toBe('focus');
    expect(pair?.view.distanceUnits).toBeLessThan(200);
  });
});

describe('mission scenarios carry numbers that agree with the physics', () => {
  /**
   * The GTO scenario is two nodes and a claim: that combining a plane change with a
   * circularisation is cheaper than doing them separately. Both halves of that claim are
   * recomputed here from `hohmannTransfer`, so the scenario cannot drift into showing a burn
   * that no longer matches the transfer it says it is.
   */
  it('the GTO perigee burn is the Hohmann departure burn from its own park', () => {
    const scenario = scenarioById('gto-transfer');
    const mission = scenario?.mission;
    expect(mission).toBeDefined();
    if (!mission) return;

    const r1 = BODIES.earth.radius + mission.orbit.altitudeM;
    const r2 = 42164e3;
    const hohmann = hohmannTransfer(r1, r2, BODIES.earth.mu);
    const node = mission.maneuvers[0]!;

    expect(node.timeSeconds).toBe(0);
    expect(node.frame).toBe('local');
    // Prograde only: a Hohmann departure from a circular orbit has no other component.
    expect(node.b).toBe(0);
    expect(node.c).toBe(0);
    expect(node.a).toBeCloseTo(hohmann.legs[0]!.deltaV, 1);
  });

  it('the GTO apogee burn is cheaper than circularising and turning separately', () => {
    const scenario = scenarioById('gto-transfer');
    const mission = scenario?.mission;
    expect(mission).toBeDefined();
    if (!mission) return;

    const r1 = BODIES.earth.radius + mission.orbit.altitudeM;
    const r2 = 42164e3;
    const mu = BODIES.earth.mu;
    const hohmann = hohmannTransfer(r1, r2, mu);
    const node = mission.maneuvers[1]!;

    // The node is at the end of the half-ellipse and nowhere else.
    expect(node.timeSeconds).toBeCloseTo(hohmann.duration, -2);

    // Rebuild what the node's own components produce, in the circularisation frame: the
    // prograde component must close the gap between the transfer's apogee speed and the
    // circular speed, and the normal component must supply the whole plane change.
    const vCircular = Math.sqrt(mu / r2);
    const vApoapsis = Math.sqrt(mu * (2 / r2 - 1 / ((r1 + r2) / 2)));
    const incidence = mission.orbit.inclinationRad;
    const expectedPrograde = vCircular * Math.cos(incidence) - vApoapsis;
    const expectedNormal = vCircular * Math.sin(incidence);

    expect(node.a).toBeCloseTo(expectedPrograde, 0);
    expect(node.b).toBeCloseTo(expectedNormal, 0);
    expect(node.c).toBe(0);

    const combined = Math.hypot(node.a, node.b);
    const separate = hohmann.legs[1]!.deltaV + 2 * vCircular * Math.sin(incidence / 2);
    // The saving is the reason this scenario exists, and it is not a rounding difference.
    expect(combined).toBeLessThan(separate);
    expect(separate - combined).toBeGreaterThan(1000);
    expect(separate - combined).toBeLessThan(1300);
  });

  it('keeps the GTO plan inside its budget and its nodes inside its horizon', () => {
    for (const id of ['leo-raise', 'gto-transfer', 'earth-mars-departure']) {
      const mission = scenarioById(id)?.mission;
      expect(mission, `${id} should carry a mission`).toBeDefined();
      if (!mission) continue;
      const planned = mission.maneuvers.reduce((s, m) => s + Math.hypot(m.a, m.b, m.c), 0);
      expect(planned, `${id} should fit its budget`).toBeLessThanOrEqual(mission.deltaVBudget);
      for (const m of mission.maneuvers) {
        expect(m.timeSeconds, `${id} node ${m.id} inside the horizon`).toBeLessThanOrEqual(
          mission.horizonSeconds,
        );
      }
    }
  });

  it('the Earth-Mars park matches the inclination its departure solve was measured at', () => {
    const mission = scenarioById('earth-mars-departure')?.mission;
    expect(mission).toBeDefined();
    if (!mission) return;
    // 51.6 degrees is load-bearing: at that inclination the cheapest 2028 cell costs
    // 4,338 m/s against 6,581 from an equatorial park (PHYSICS.md section 12.4). A different
    // park would leave the scenario's description and its budget describing another mission.
    expect((mission.orbit.inclinationRad * 180) / Math.PI).toBeCloseTo(51.6, 6);
    expect(mission.orbit.altitudeM).toBe(300e3);
    // No node: the scenario exists so the first action is clicking a porkchop cell.
    expect(mission.maneuvers).toHaveLength(0);
    expect(mission.deltaVBudget).toBeGreaterThan(4338);
  });
});

describe('validateScenario', () => {
  it('accepts a well-formed scenario and returns a rebuilt object', () => {
    const result = validateScenario(valid);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scenario).toEqual(valid);
    // Not the same reference: validated output is a fresh object.
    expect(result.scenario).not.toBe(valid);
  });

  it('drops unknown properties instead of carrying them through', () => {
    const result = validateScenario(withChange({ evil: 'payload' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect('evil' in result.scenario).toBe(false);
  });

  it('rejects non-objects', () => {
    for (const input of [null, undefined, 42, 'scenario', [], [valid]]) {
      const result = validateScenario(input);
      expect(result.ok, `${JSON.stringify(input)} should be rejected`).toBe(false);
    }
  });

  it('rejects an unknown schema version and says which one it wants', () => {
    const result = validateScenario(withChange({ schemaVersion: 99 }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.path).toBe('schemaVersion');
    expect(result.issues[0]?.message).toContain(String(SCENARIO_SCHEMA_VERSION));
  });

  it('rejects an empty id or name, and reports the field path', () => {
    const result = validateScenario(withChange({ id: '   ', name: '' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((i) => i.path)).toEqual(['id', 'name']);
  });

  it('rejects an unparseable epoch', () => {
    for (const epochUtc of ['yesterday', '2026-13-45T00:00:00Z', '', 12345]) {
      const result = validateScenario(withChange({ epochUtc }));
      expect(result.ok, `${JSON.stringify(epochUtc)} should be rejected`).toBe(false);
      if (result.ok) continue;
      expect(result.issues.some((i) => i.path === 'epochUtc')).toBe(true);
    }
  });

  it('rejects a warp the clock does not offer', () => {
    for (const startWarp of [2, -1, 1.5, 1e9, 'fast']) {
      const result = validateScenario(withChange({ startWarp }));
      expect(result.ok, `${JSON.stringify(startWarp)} should be rejected`).toBe(false);
    }
  });

  it('rejects a focus that is not a known body', () => {
    for (const focus of ['pluto', 'Earth', '', null]) {
      const result = validateScenario(withChange({ focus }));
      expect(result.ok, `${JSON.stringify(focus)} should be rejected`).toBe(false);
    }
  });

  it('rejects a radial mode it cannot render', () => {
    const bad = structuredClone(valid) as Record<string, unknown>;
    (bad['view'] as Record<string, unknown>)['radialMode'] = 'mercator';
    const result = validateScenario(bad);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.path).toBe('view.radialMode');
  });

  it('rejects a non-finite or non-positive camera distance', () => {
    for (const distanceUnits of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, 'far']) {
      const bad = structuredClone(valid) as Record<string, unknown>;
      (bad['view'] as Record<string, unknown>)['distanceUnits'] = distanceUnits;
      expect(validateScenario(bad).ok, `${String(distanceUnits)} should be rejected`).toBe(false);
    }
  });

  it('rejects an elevation at or beyond the pole, where the up vector is undefined', () => {
    for (const elevationRad of [Math.PI / 2, -Math.PI / 2, 2, -2]) {
      const bad = structuredClone(valid) as Record<string, unknown>;
      (bad['view'] as Record<string, unknown>)['elevationRad'] = elevationRad;
      expect(validateScenario(bad).ok, `${elevationRad} should be rejected`).toBe(false);
    }
  });

  it('rejects a missing or unknown camera centre', () => {
    for (const centeredOn of [undefined, 'earth', 'moon']) {
      const bad = structuredClone(valid) as Record<string, unknown>;
      (bad['view'] as Record<string, unknown>)['centeredOn'] = centeredOn;
      expect(validateScenario(bad).ok).toBe(false);
    }
  });

  it('collects every problem rather than stopping at the first', () => {
    const result = validateScenario({ id: '', name: '', schemaVersion: 2 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // schemaVersion, id, name, description, epochUtc, startWarp, focus, view.
    expect(result.issues.length).toBeGreaterThanOrEqual(8);
  });

  it('is idempotent: a validated scenario validates again unchanged', () => {
    const once = validateScenario(valid);
    expect(once.ok).toBe(true);
    if (!once.ok) return;
    const twice = validateScenario(once.scenario);
    expect(twice.ok).toBe(true);
    if (!twice.ok) return;
    expect(twice.scenario).toEqual(once.scenario);
  });
});

describe('mission validation', () => {
  const mission = {
    id: 'sat',
    name: 'Sat',
    centralBody: 'earth',
    orbit: { altitudeM: 550e3, inclinationRad: 0.9, phaseRad: 0 },
    deltaVBudget: 120,
    propagation: 'twoBody',
    horizonSeconds: 11600,
    maneuvers: [{ id: 'b1', timeSeconds: 2900, a: 62, b: 0, c: 0, frame: 'local', label: 'Raise' }],
  };

  it('accepts a mission and keeps its nodes', () => {
    const r = validateScenario(withChange({ mission }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.scenario.mission?.maneuvers).toHaveLength(1);
    expect(r.scenario.mission?.maneuvers[0]?.a).toBe(62);
  });

  it('omits the mission key entirely when absent', () => {
    const r = validateScenario(valid);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect('mission' in r.scenario).toBe(false);
  });

  it('rejects a negative altitude with the field path', () => {
    const r = validateScenario(
      withChange({ mission: { ...mission, orbit: { ...mission.orbit, altitudeM: -1 } } }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.map((i) => i.path)).toContain('mission.orbit.altitudeM');
  });

  it('rejects an inclination outside [0, pi]', () => {
    const r = validateScenario(
      withChange({ mission: { ...mission, orbit: { ...mission.orbit, inclinationRad: 4 } } }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.map((i) => i.path)).toContain('mission.orbit.inclinationRad');
  });

  it('rejects an unknown central body', () => {
    const r = validateScenario(withChange({ mission: { ...mission, centralBody: 'pluto' } }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.map((i) => i.path)).toContain('mission.centralBody');
  });

  it('rejects an unknown propagation mode', () => {
    const r = validateScenario(withChange({ mission: { ...mission, propagation: 'magic' } }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.map((i) => i.path)).toContain('mission.propagation');
  });

  it('rejects a negative delta-v budget', () => {
    const r = validateScenario(withChange({ mission: { ...mission, deltaVBudget: -5 } }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.map((i) => i.path)).toContain('mission.deltaVBudget');
  });

  it('rejects a non-object mission', () => {
    const r = validateScenario(withChange({ mission: 'nope' }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.map((i) => i.path)).toContain('mission');
  });

  it('rejects a node with an unknown frame, naming its index', () => {
    const r = validateScenario(
      withChange({
        mission: { ...mission, maneuvers: [{ ...mission.maneuvers[0], frame: 'sideways' }] },
      }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.map((i) => i.path)).toContain('mission.maneuvers[0].frame');
  });

  it('rejects a node with a non-finite component', () => {
    const r = validateScenario(
      withChange({
        mission: { ...mission, maneuvers: [{ ...mission.maneuvers[0], a: Infinity }] },
      }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.map((i) => i.path)).toContain('mission.maneuvers[0].a');
  });

  it('drops a node label that is not a string rather than coercing it', () => {
    const r = validateScenario(
      withChange({
        mission: { ...mission, maneuvers: [{ ...mission.maneuvers[0], label: 7 }] },
      }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.map((i) => i.path)).toContain('mission.maneuvers[0].label');
  });
});

describe('assertScenario', () => {
  it('returns the scenario when valid', () => {
    expect(assertScenario(valid, 'test scenario').id).toBe('test');
  });

  it('throws with the offending paths in the message', () => {
    expect(() => assertScenario(withChange({ id: '' }), 'test scenario')).toThrow(/id/);
    expect(() => assertScenario(withChange({ id: '' }), 'test scenario')).toThrow(/test scenario/);
  });
});

describe('the free-return scenario', () => {
  const scenario = () => scenarioById('lunar-free-return')!;
  const mission = () => scenario().mission!;

  /** Propagates the scenario's own mission and reports what actually happened. */
  function fly(options: { bodies?: readonly BodyId[]; propagation?: PropagationMode } = {}) {
    const spec = mission();
    const epochJdTt = jdTtFromJdUtc(jdFromIsoUtc(scenario().epochUtc));
    const craft = craftFromSpec(spec);
    const trajectory = propagateTrajectory(craft, {
      horizonSeconds: spec.horizonSeconds,
      mode: options.propagation ?? spec.propagation,
      epochJdTt,
      enabledBodies: options.bodies,
    });

    let minMoonM = Infinity;
    let minMoonAtDays = 0;
    for (const p of trajectory.points) {
      const moon = bodyPosition('moon', epochJdTt + p.timeSeconds / SECONDS_PER_DAY);
      const d = Math.hypot(p.r.x - moon.x, p.r.y - moon.y, p.r.z - moon.z);
      if (d < minMoonM) {
        minMoonM = d;
        minMoonAtDays = p.timeSeconds / SECONDS_PER_DAY;
      }
    }

    // The return leg is everything after the flyby: a free return means the craft comes back
    // towards Earth *after* the Moon, not merely that it was once close.
    let minEarthAfterM = Infinity;
    let minEarthAfterDays = 0;
    for (const p of trajectory.points) {
      if (p.timeSeconds / SECONDS_PER_DAY <= minMoonAtDays) continue;
      const earth = bodyPosition('earth', epochJdTt + p.timeSeconds / SECONDS_PER_DAY);
      const d = Math.hypot(p.r.x - earth.x, p.r.y - earth.y, p.r.z - earth.z);
      if (d < minEarthAfterM) {
        minEarthAfterM = d;
        minEarthAfterDays = p.timeSeconds / SECONDS_PER_DAY;
      }
    }

    return { trajectory, minMoonM, minMoonAtDays, minEarthAfterM, minEarthAfterDays };
  }

  it('is one prograde burn and nothing else', () => {
    // A free return's whole claim is that the Moon turns the craft around, so any second burn
    // would be a different scenario wearing this one's name.
    const m = mission();
    expect(m.maneuvers).toHaveLength(1);
    const node = m.maneuvers[0]!;
    expect(node.frame).toBe('local');
    expect(node.timeSeconds).toBe(0);
    expect(node.b).toBe(0);
    expect(node.c).toBe(0);
    expect(node.a).toBeGreaterThan(3000);
    expect(node.a).toBeLessThan(3300);
  });

  it('is an N-body plan, because a two-body Earth orbit cannot bend around the Moon', () => {
    expect(mission().propagation).toBe('nbody');
  });

  it('the burn leaves a park whose apogee reaches lunar distance', () => {
    // Re-derived, not asserted from the file: the burn is a prograde impulse from a circular
    // 300 km orbit, so vis-viva gives the resulting apogee. If the number in the scenario stops
    // reaching the Moon, the scenario is a lie even though it still loads and still draws.
    const m = mission();
    const mu = BODIES.earth.mu;
    const r1 = BODIES.earth.radius + m.orbit.altitudeM;
    const vCircular = Math.sqrt(mu / r1);
    const speedAfter = vCircular + m.maneuvers[0]!.a;
    const specificEnergy = (speedAfter * speedAfter) / 2 - mu / r1;
    const semiMajor = -mu / (2 * specificEnergy);
    const apogee = 2 * semiMajor - r1;

    // The Moon's mean distance is 384,400 km; the craft must at least reach it, and the burn
    // is measured so the encounter is a flyby rather than a distant pass.
    expect(apogee).toBeGreaterThan(384_400e3);
    expect(apogee).toBeLessThan(700_000e3);
  });

  it('actually flies past the Moon and comes back to Earth', () => {
    const { minMoonM, minMoonAtDays, minEarthAfterM, minEarthAfterDays } = fly();
    const moonAltitudeKm = (minMoonM - BODIES.moon.radius) / 1000;
    const returnAltitudeKm = (minEarthAfterM - BODIES.earth.radius) / 1000;

    // A flyby, not an impact: clear of the surface by a wide margin.
    expect(moonAltitudeKm).toBeGreaterThan(500);
    expect(moonAltitudeKm).toBeLessThan(6000);
    // And home: back to roughly the altitude it left from, which is what "free return" means.
    expect(returnAltitudeKm).toBeGreaterThan(0);
    expect(returnAltitudeKm).toBeLessThan(2000);
    // The encounter is outbound and the return is later, so this is one loop and not a tangent.
    expect(minMoonAtDays).toBeGreaterThan(2);
    expect(minEarthAfterDays).toBeGreaterThan(minMoonAtDays + 1);
  });

  it('does not come home when the Moon is removed, so the Moon is the mechanism', () => {
    // The mutation that proves the test above is about the Moon rather than about Earth's
    // gravity. Note what this does *not* assert: the unperturbed path still passes close to the
    // Moon's position, because the burn is aimed there — measured 4,672 km of lunar altitude
    // against 2,694 km with the Moon present. Distance alone cannot separate the two cases.
    // What separates them is the return. Without the Moon the burn produces a closed ellipse
    // with a = 201,300 km and a 10.4-day period, so even at the end of this 9-day horizon the
    // craft is still 308,380 km from the Earth (302,009 km of altitude); with the Moon it is
    // 7,057 km out at 6.36 days, which is 337 km of altitude.
    const withMoon = fly();
    const withoutMoon = fly({ bodies: ['earth', 'sun'] });

    expect(withoutMoon.minEarthAfterM).toBeGreaterThan(100_000e3);
    // 43.7x measured. Stated as a ratio rather than as "it comes back" because a ratio of this
    // size cannot be produced by integration error; only a missing body produces it.
    expect(withoutMoon.minEarthAfterM).toBeGreaterThan(20 * withMoon.minEarthAfterM);
  });

  it('shows the whole return leg inside its horizon', () => {
    // The horizon is not decoration: if it ended at the flyby the panel would never show the
    // point of the scenario. The craft is home at 6.36 days, inside the 9-day plan.
    const { minEarthAfterDays, minEarthAfterM } = fly();
    expect(minEarthAfterDays).toBeLessThan(mission().horizonSeconds / SECONDS_PER_DAY);
    expect(minEarthAfterM).toBeLessThan(10_000e3);
  });

  it('is sensitive to the burn, which is the lesson the scenario teaches', () => {
    // A free return is a knife-edge. Asserting the sensitivity rather than hiding it is what
    // lets the scenario description say the solution is narrow and mean it.
    const m = mission();
    const epochJdTt = jdTtFromJdUtc(jdFromIsoUtc(scenario().epochUtc));

    const closestFor = (deltaV: number): number => {
      const patched: typeof m = {
        ...m,
        maneuvers: [{ ...m.maneuvers[0]!, a: deltaV }],
      };
      const trajectory = propagateTrajectory(craftFromSpec(patched), {
        horizonSeconds: m.horizonSeconds,
        mode: 'nbody',
        epochJdTt,
      });
      let best = Infinity;
      for (const p of trajectory.points) {
        const moon = bodyPosition('moon', epochJdTt + p.timeSeconds / SECONDS_PER_DAY);
        best = Math.min(best, Math.hypot(p.r.x - moon.x, p.r.y - moon.y, p.r.z - moon.z));
      }
      return best;
    };

    const nominal = closestFor(m.maneuvers[0]!.a);
    const low = closestFor(m.maneuvers[0]!.a - 20);
    const high = closestFor(m.maneuvers[0]!.a + 20);
    // Measured: the nominal flyby closes to 4,424 km from the Moon's centre (2,694 km of
    // altitude); 20 m/s low misses at 23,157 km of altitude and 20 m/s high at 24,459 km.
    // Twenty metres per second is 0.64% of the burn and it costs the flyby entirely, so the
    // claim asserted here is "there is no flyby left", not "it is a bit worse".
    expect(nominal).toBeLessThan(5_000e3);
    expect(low).toBeGreaterThan(20_000e3);
    expect(high).toBeGreaterThan(20_000e3);
  });
});
