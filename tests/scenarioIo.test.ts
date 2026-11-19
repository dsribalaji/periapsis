import { describe, expect, it } from 'vitest';
import {
  declaredVersion,
  exportScenario,
  importScenario,
  isReadableVersion,
  scenarioFilename,
} from '../src/scenarios/io.js';
import { SCENARIOS } from '../src/scenarios/catalogue.js';
import { SCENARIO_SCHEMA_VERSION, type Scenario } from '../src/scenarios/types.js';

/** A scenario with a mission, so the mission half of the export is exercised too. */
function withMission(): Scenario {
  const found = SCENARIOS.find((s) => s.mission);
  if (!found?.mission) throw new Error('no bundled scenario has a mission');
  return found;
}

describe('exporting a scenario', () => {
  it('round-trips every bundled scenario through export and import', () => {
    // The property that matters: whatever the app writes, the app reads back identically.
    for (const scenario of SCENARIOS) {
      const text = exportScenario(scenario);
      const result = importScenario(text);
      expect(result.ok, `${scenario.id} should re-import`).toBe(true);
      if (result.ok) expect(result.scenario).toEqual(scenario);
    }
  });

  it('writes the mission, including every maneuver component', () => {
    const scenario = withMission();
    const text = exportScenario(scenario, { pretty: true });
    const parsed = JSON.parse(text) as { mission: Record<string, unknown> };
    expect(parsed.mission['id']).toBe(scenario.mission!.id);
    expect(parsed.mission['propagation']).toBe(scenario.mission!.propagation);
    expect(parsed.mission['horizonSeconds']).toBe(scenario.mission!.horizonSeconds);

    const maneuvers = parsed.mission['maneuvers'] as Array<Record<string, unknown>>;
    expect(maneuvers).toHaveLength(scenario.mission!.maneuvers.length);
    for (let i = 0; i < maneuvers.length; i++) {
      const source = scenario.mission!.maneuvers[i]!;
      expect(maneuvers[i]!['a']).toBe(source.a);
      expect(maneuvers[i]!['b']).toBe(source.b);
      expect(maneuvers[i]!['c']).toBe(source.c);
      expect(maneuvers[i]!['frame']).toBe(source.frame);
    }
  });

  it('omits a maneuver label rather than writing null', () => {
    // `label: undefined` disappears from JSON but `label: null` would come back and fail
    // validation. The export builds the object explicitly so this cannot regress.
    const scenario = withMission();
    const bare: Scenario = {
      ...scenario,
      mission: {
        ...scenario.mission!,
        maneuvers: scenario.mission!.maneuvers.map((m) => {
          const { label, ...rest } = m;
          void label;
          return rest;
        }),
      },
    };
    const parsed = JSON.parse(exportScenario(bare)) as {
      mission: { maneuvers: Array<Record<string, unknown>> };
    };
    for (const m of parsed.mission.maneuvers) expect('label' in m).toBe(false);
  });

  it('is byte-identical across two exports of the same scenario', () => {
    // Field order is fixed by construction, so a scenario kept in a git repo does not churn.
    const scenario = withMission();
    expect(exportScenario(scenario)).toBe(exportScenario(scenario));
    expect(exportScenario(scenario, { pretty: true })).toBe(
      exportScenario(scenario, { pretty: true }),
    );
  });

  it('pretty-prints on request and not by default', () => {
    const scenario = SCENARIOS[0]!;
    expect(exportScenario(scenario)).not.toContain('\n');
    expect(exportScenario(scenario, { pretty: true })).toContain('\n  "id"');
  });

  it('does not write a mission key for a scenario without one', () => {
    const system = SCENARIOS.find((s) => !s.mission);
    expect(system).toBeDefined();
    const parsed = JSON.parse(exportScenario(system!)) as Record<string, unknown>;
    expect('mission' in parsed).toBe(false);
  });
});

describe('the filename', () => {
  it('derives from the id and ends in .periapsis.json', () => {
    expect(scenarioFilename(SCENARIOS[0]!)).toMatch(/^[a-z0-9-]+\.periapsis\.json$/);
    expect(scenarioFilename(SCENARIOS[0]!)).toBe(`${SCENARIOS[0]!.id}.periapsis.json`);
  });

  it('neutralises path separators and other filesystem hazards', () => {
    // An imported file can carry any id the validator accepts, and a non-empty string is all it
    // requires. A slash in it must not become a directory traversal in a download.
    const hostile: Scenario = { ...SCENARIOS[0]!, id: '../../etc/passwd' };
    const name = scenarioFilename(hostile);
    expect(name).not.toContain('/');
    expect(name).not.toContain('..');
    expect(name).toBe('etc-passwd.periapsis.json');
  });

  it('falls back when the id has no safe characters at all', () => {
    const empty: Scenario = { ...SCENARIOS[0]!, id: '///' };
    expect(scenarioFilename(empty)).toBe('scenario.periapsis.json');
  });

  it('is case-folded so a Windows and a Linux checkout agree', () => {
    const upper: Scenario = { ...SCENARIOS[0]!, id: 'MyScenario' };
    expect(scenarioFilename(upper)).toBe('myscenario.periapsis.json');
  });
});

describe('importing a bad file', () => {
  const cases: Array<{ what: string; text: string; expect: RegExp }> = [
    { what: 'empty text', text: '   ', expect: /empty/i },
    { what: 'not JSON', text: '{ this is not json', expect: /not valid JSON/i },
    { what: 'a JSON array', text: '[1,2,3]', expect: /schemaVersion/i },
    { what: 'a JSON number', text: '42', expect: /schemaVersion/i },
    { what: 'null', text: 'null', expect: /schemaVersion/i },
    { what: 'an object with no version', text: '{"id":"x"}', expect: /cannot tell which build/i },
  ];

  for (const { what, text, expect: pattern } of cases) {
    it(`reports ${what} without throwing`, () => {
      expect(() => importScenario(text)).not.toThrow();
      const result = importScenario(text);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.summary).toMatch(pattern);
    });
  }

  it('names the field that failed, not just "invalid"', () => {
    const raw = JSON.parse(exportScenario(SCENARIOS[0]!)) as Record<string, unknown>;
    const view = raw['view'] as Record<string, unknown>;
    view['distanceUnits'] = -5;
    const result = importScenario(JSON.stringify(raw));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.summary).toContain('view.distanceUnits');
      expect(result.issues.some((i) => i.path === 'view.distanceUnits')).toBe(true);
    }
  });

  it('counts the further problems when there is more than one', () => {
    const raw = JSON.parse(exportScenario(SCENARIOS[0]!)) as Record<string, unknown>;
    raw['id'] = '';
    raw['name'] = '';
    raw['focus'] = 'pluto';
    const result = importScenario(JSON.stringify(raw));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.length).toBeGreaterThanOrEqual(3);
      expect(result.summary).toMatch(/and \d+ more/);
    }
  });

  it('refuses a newer schema version with both numbers in the message', () => {
    const raw = JSON.parse(exportScenario(SCENARIOS[0]!)) as Record<string, unknown>;
    raw['schemaVersion'] = SCENARIO_SCHEMA_VERSION + 1;
    const result = importScenario(JSON.stringify(raw));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.summary).toContain(String(SCENARIO_SCHEMA_VERSION + 1));
      expect(result.summary).toMatch(/newer build/);
    }
  });

  it('does not accept extra top-level fields as a channel for unvalidated data', () => {
    // The validator rebuilds the object from known fields, so a file cannot smuggle anything
    // into the app behind a passing check.
    const raw = JSON.parse(exportScenario(SCENARIOS[0]!)) as Record<string, unknown>;
    raw['__proto__'] = { polluted: true };
    raw['extra'] = 'ignored';
    const result = importScenario(JSON.stringify(raw));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect('extra' in result.scenario).toBe(false);
      expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    }
  });
});

describe('declaredVersion', () => {
  it('reads the version without validating the rest', () => {
    const raw = JSON.parse(exportScenario(SCENARIOS[0]!)) as Record<string, unknown>;
    raw['name'] = 42; // Invalid, but the version is still readable.
    expect(declaredVersion(JSON.stringify(raw))).toBe(SCENARIO_SCHEMA_VERSION);
  });

  it('returns null for anything unreadable', () => {
    for (const bad of [
      '',
      'nope',
      '[]',
      'null',
      '{"schemaVersion":"1"}',
      '{"schemaVersion":1.5}',
    ]) {
      expect(declaredVersion(bad), bad).toBeNull();
    }
  });

  it('says which versions this build can read', () => {
    expect(isReadableVersion(SCENARIO_SCHEMA_VERSION)).toBe(true);
    expect(isReadableVersion(SCENARIO_SCHEMA_VERSION - 1)).toBe(true);
    expect(isReadableVersion(SCENARIO_SCHEMA_VERSION + 1)).toBe(false);
    expect(isReadableVersion(null)).toBe(false);
  });
});
