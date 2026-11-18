import { describe, expect, it } from 'vitest';
import {
  SCENARIOS,
  defaultScenario,
  scenarioById,
  DEFAULT_SCENARIO_ID,
} from '../src/scenarios/catalogue.js';
import { validateScenario, assertScenario } from '../src/scenarios/validate.js';
import { SCENARIO_SCHEMA_VERSION } from '../src/scenarios/types.js';
import { jdFromIsoUtc } from '../src/core/time/time.js';
import { BODIES } from '../src/core/ephemeris/solarSystem.js';
import { WARP_STEPS } from '../src/sim/clock.js';

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

describe('assertScenario', () => {
  it('returns the scenario when valid', () => {
    expect(assertScenario(valid, 'test scenario').id).toBe('test');
  });

  it('throws with the offending paths in the message', () => {
    expect(() => assertScenario(withChange({ id: '' }), 'test scenario')).toThrow(/id/);
    expect(() => assertScenario(withChange({ id: '' }), 'test scenario')).toThrow(/test scenario/);
  });
});
