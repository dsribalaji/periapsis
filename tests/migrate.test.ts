import { describe, expect, it } from 'vitest';
import {
  MIGRATIONS,
  legacyExaggeration,
  migrateScenario,
  migrateWith,
  type Migration,
} from '../src/scenarios/migrate.js';
import { SCENARIO_SCHEMA_VERSION } from '../src/scenarios/types.js';
import { assertScenario } from '../src/scenarios/validate.js';
import { SCENARIOS } from '../src/scenarios/catalogue.js';

/**
 * A minimal valid scenario at the *current* schema version, as a raw object.
 *
 * Built from a bundled scenario so it cannot drift out of step with what the validator wants:
 * if the catalogue gains a required field, this fixture gains it too.
 */
function currentScenario(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(SCENARIOS[0])) as Record<string, unknown>;
}

describe('schema versioning', () => {
  it('reads the current version without a migration', () => {
    const result = migrateScenario(currentScenario());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.scenario.ok).toBe(true);
  });

  it('rejects a missing version with a path and a reason', () => {
    const raw = currentScenario();
    delete raw['schemaVersion'];
    const result = migrateScenario(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]?.path).toBe('schemaVersion');
      expect(result.issues[0]?.message).toMatch(/cannot tell which build/);
    }
  });

  it('rejects a non-integer version rather than coercing it', () => {
    for (const bad of [1.5, '1', null, true]) {
      const raw = { ...currentScenario(), schemaVersion: bad };
      const result = migrateScenario(raw);
      expect(result.ok, `schemaVersion ${JSON.stringify(bad)} should be refused`).toBe(false);
    }
  });

  it('refuses a file from a newer build, and says so in both directions', () => {
    // The important half of versioning: forward compatibility is not attempted. A build that
    // silently dropped the fields it did not recognise would load a scenario that is not the
    // one the user saved, which is worse than refusing.
    const raw = { ...currentScenario(), schemaVersion: SCENARIO_SCHEMA_VERSION + 1 };
    const result = migrateScenario(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const message = result.issues[0]?.message ?? '';
      expect(message).toContain(String(SCENARIO_SCHEMA_VERSION + 1));
      expect(message).toContain(String(SCENARIO_SCHEMA_VERSION));
      expect(message).toMatch(/newer build/);
    }
  });

  it('treats a non-object as an unversioned failure, not a crash', () => {
    for (const bad of [null, 42, 'scenario', [1, 2]]) {
      expect(() => migrateScenario(bad)).not.toThrow();
      expect(migrateScenario(bad).ok).toBe(false);
    }
  });

  it('ships exactly one step per version gap', () => {
    // If a migration is added without bumping the version, or a version is bumped without
    // adding a migration, this fails.
    expect(MIGRATIONS).toHaveLength(SCENARIO_SCHEMA_VERSION - 1);
    expect(MIGRATIONS.map((m) => m.from)).toEqual(
      Array.from({ length: SCENARIO_SCHEMA_VERSION - 1 }, (_, i) => i + 1),
    );
  });
});

describe('1 -> 2: true-scale bodies', () => {
  /** A version-1 file as the v1.0.0 build wrote it. */
  function v1File(view: Record<string, unknown>, focus = 'earth'): Record<string, unknown> {
    const raw = currentScenario();
    return { ...raw, schemaVersion: 1, focus, view: { ...(raw['view'] as object), ...view } };
  }

  it("divides a body-centred distance by the body's old exaggeration", () => {
    // v1.0.0's LEO scenario: Earth drawn at 1.2 units, camera 26 units out. Earth's true radius
    // is 0.004259 units, so the same framing is 26 * 0.004259 / 1.2 = 0.0923 units.
    expect(legacyExaggeration('earth')).toBeCloseTo(281.8, 1);
    const result = migrateScenario(v1File({ distanceUnits: 26, centeredOn: 'focus' }));
    expect(result.ok).toBe(true);
    if (result.ok && result.scenario.ok) {
      expect(result.scenario.scenario.schemaVersion).toBe(2);
      expect(result.scenario.scenario.view.distanceUnits).toBeCloseTo(0.0923, 4);
    } else {
      expect.fail('a v1 file should migrate and validate');
    }
  });

  it('leaves a Sun-centred distance alone, because planet positions never changed scale', () => {
    const result = migrateScenario(v1File({ distanceUnits: 320, centeredOn: 'sun' }));
    expect(result.ok && result.scenario.ok && result.scenario.scenario.view.distanceUnits).toBe(
      320,
    );
  });

  it("uses the parent's factor for a pair view", () => {
    const result = migrateScenario(v1File({ distanceUnits: 60, centeredOn: 'pair' }, 'moon'));
    expect(result.ok && result.scenario.ok).toBe(true);
    if (result.ok && result.scenario.ok) {
      expect(result.scenario.scenario.view.distanceUnits).toBeCloseTo(
        60 / legacyExaggeration('earth'),
        9,
      );
    }
  });

  it('passes a malformed view through for the validator to report, rather than throwing', () => {
    const raw = { ...currentScenario(), schemaVersion: 1, view: 'not a view' };
    const result = migrateScenario(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.scenario.ok).toBe(false);
      if (!result.scenario.ok)
        expect(result.scenario.issues.some((i) => i.path === 'view')).toBe(true);
    }
  });
});

describe('the migration chain', () => {
  /**
   * A synthetic chain from version 0 to the real current version.
   *
   * The real chain is empty, so testing it proves nothing about the code that walks a chain.
   * These steps are deliberately trivial (rename a field, add a field) because what is under
   * test is the walker: does it apply in order, does it stop on a gap, does it validate after.
   */
  const stepFrom0: Migration = {
    from: 0,
    apply: (input) => {
      // v0 called the description `summary` and did not carry a schemaVersion per mission.
      const { summary, ...rest } = input;
      return { ...rest, description: summary, schemaVersion: 1 };
    },
  };
  // The synthetic first step, then the real chain, so a version-0 file walks all the way to
  // the current version.
  const chain: readonly Migration[] = [stepFrom0, ...MIGRATIONS];

  it('upgrades an older file and validates the result', () => {
    if (SCENARIO_SCHEMA_VERSION < 1) return; // The chain is meaningless at schema 0.
    const { description, ...rest } = currentScenario();
    const old = { ...rest, schemaVersion: 0, summary: description };
    const result = migrateWith(chain, old);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.scenario.ok).toBe(true);
      if (result.scenario.ok) expect(result.scenario.scenario.description).toBe(description);
    }
  });

  it('applies steps in version order, not in array order', () => {
    // Registering the steps backwards must still work, because the chain is looked up by
    // `from` rather than walked by index.
    const reversed = [...chain].reverse();
    const { description, ...rest } = currentScenario();
    const old = { ...rest, schemaVersion: 0, summary: description };
    const result = migrateWith(reversed, old);
    expect(result.ok).toBe(true);
  });

  it('fails on a gap in the chain rather than parsing best-effort', () => {
    const { description, ...rest } = currentScenario();
    const old = { ...rest, schemaVersion: 0, summary: description };
    // No steps at all: there is no path from 0 to 1.
    const result = migrateWith([], old);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]?.message).toMatch(/no migration from schema 0 to 1/);
      expect(result.issues[0]?.message).toMatch(/not being loaded/);
    }
  });

  it('does not run a step that is not needed', () => {
    let calls = 0;
    const counted: Migration = {
      from: 0,
      apply: (input) => {
        calls += 1;
        return input;
      },
    };
    const result = migrateWith([counted], currentScenario());
    expect(result.ok).toBe(true);
    expect(calls).toBe(0);
  });

  it('validates *after* migrating, so a step cannot smuggle an invalid field through', () => {
    const bad = { from: 0, apply: (input: Record<string, unknown>) => ({ ...input, id: '' }) };
    const { description, ...rest } = currentScenario();
    const old = { ...rest, schemaVersion: 0, summary: description };
    const result = migrateWith([bad, ...MIGRATIONS], old);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.scenario.ok).toBe(false);
      if (!result.scenario.ok)
        expect(result.scenario.issues.some((i) => i.path === 'id')).toBe(true);
    }
  });

  it('cannot loop, because the walker owns the version counter', () => {
    // The property that makes a termination guard unnecessary: a step is never asked which
    // version it produced. Even a step that returns the input unchanged (and a chain that keeps
    // offering the same `from`) advances by exactly one gap per iteration, so the walk is
    // bounded by the number of versions that exist.
    let calls = 0;
    const inert: Migration = {
      from: 0,
      apply: (input) => {
        calls += 1;
        return input;
      },
    };
    const { description, ...rest } = currentScenario();
    const old = { ...rest, schemaVersion: 0, summary: description };
    const result = migrateWith([inert], old, 3);
    // Two gaps (0->1, 1->2->3 needs 1 and 2, which do not exist): the first step runs once,
    // then the gap at version 1 is reported. The step cannot cause a third call.
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.message).toMatch(/no migration from schema 1 to 2/);
    expect(calls).toBe(1);
  });

  it('applies a multi-step chain in order', () => {
    // The walker is the thing under test, so give it a real gap: 0 -> 1 -> 2, where the field
    // is renamed once and added once. Order matters, because step 2 reads what step 1 wrote.
    //
    // The target is one past the version this build reads, so the *validator* rejects the
    // result on `schemaVersion` and nothing else. That is the assertion: if step 0 had not run,
    // the validator would also complain that `description` is missing, and if the steps had
    // swapped order there would be a leftover `summary`. One issue, and only that one, proves
    // the walk.
    const target = SCENARIO_SCHEMA_VERSION + 1;
    const v1: Migration = {
      from: 0,
      apply: ({ summary, ...rest }) => ({ ...rest, description: summary, schemaVersion: 1 }),
    };
    const v2: Migration = {
      from: 1,
      apply: (input) => ({ ...input, startWarp: 1e4, schemaVersion: 2 }),
    };
    // Identity steps up to the target, so only the first two do any work.
    const rest2: Migration[] = Array.from({ length: target - 2 }, (_, i) => ({
      from: i + 2,
      apply: (input: Record<string, unknown>) => ({ ...input, schemaVersion: i + 3 }),
    }));
    const { description, startWarp, ...rest } = currentScenario();
    const old = { ...rest, schemaVersion: 0, summary: description };
    const result = migrateWith([...rest2, v2, v1], old, target);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.scenario.ok).toBe(false);
      if (!result.scenario.ok) {
        expect(result.scenario.issues.map((i) => i.path)).toEqual(['schemaVersion']);
      }
    }
    void startWarp;
  });
});

describe('the bundled catalogue survives the migration path', () => {
  it('every bundled scenario migrates without a migration step', () => {
    // Bundled data is the input the app actually loads on every start, so this is the check
    // that the version gate does not reject the app's own files.
    for (const scenario of SCENARIOS) {
      const result = migrateScenario(JSON.parse(JSON.stringify(scenario)));
      expect(result.ok, `${scenario.id} should migrate`).toBe(true);
      if (result.ok) expect(result.scenario.ok, `${scenario.id} should validate`).toBe(true);
    }
  });

  it('round-trips through JSON without losing anything the validator needs', () => {
    // The realistic path for an exported file. `undefined` fields vanish in JSON, so a scenario
    // that relied on `label: undefined` being present would fail here rather than in the field.
    for (const scenario of SCENARIOS) {
      const roundTripped = JSON.parse(JSON.stringify(scenario));
      expect(() => assertScenario(roundTripped, `${scenario.id} after JSON`)).not.toThrow();
    }
  });
});
