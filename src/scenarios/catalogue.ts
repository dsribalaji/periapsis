/**
 * Bundled scenarios.
 *
 * Each one is a starting point, chosen to make a different part of the app useful
 * immediately: the inner system at true scale, the whole system compressed, and a
 * spacecraft-scale view of Earth and the Moon.
 *
 * Every entry is validated at module load. These are build artefacts, not user data, so an
 * invalid entry is a programming error that must surface immediately rather than produce an
 * app that half-loads. `tests/scenario.test.ts` asserts the same thing from the outside.
 */

import type { Scenario } from './types.js';
import { SCENARIO_SCHEMA_VERSION } from './types.js';
import { assertScenario } from './validate.js';

const RAW: readonly Scenario[] = [
  {
    schemaVersion: SCENARIO_SCHEMA_VERSION,
    id: 'inner-system',
    name: 'Inner system',
    description: 'Mercury to Mars at true scale, from just above the ecliptic.',
    epochUtc: '2026-11-18T12:00:00Z',
    startWarp: 1e4,
    focus: 'earth',
    view: {
      radialMode: 'linear',
      azimuthRad: 0.6,
      elevationRad: 1.05,
      distanceUnits: 320,
      centeredOn: 'sun',
    },
  },
  {
    schemaVersion: SCENARIO_SCHEMA_VERSION,
    id: 'whole-system',
    name: 'Whole system',
    description:
      'Every planet at once on a logarithmic radius. Ordering is exact, distances are not.',
    epochUtc: '2026-11-18T12:00:00Z',
    startWarp: 1e5,
    focus: 'jupiter',
    view: {
      radialMode: 'compressed',
      azimuthRad: 0.9,
      elevationRad: 1.25,
      distanceUnits: 560,
      centeredOn: 'sun',
    },
  },
  {
    schemaVersion: SCENARIO_SCHEMA_VERSION,
    id: 'earth-moon',
    name: 'Earth and Moon',
    description: 'The Earth-Moon pair from close in: the scale a spacecraft actually works at.',
    // A distinct epoch from the other two, so a scenario switch is visibly a *restart* and
    // not just a re-frame. It also exercises the TT/UTC path at a different calendar date.
    epochUtc: '2027-04-07T12:00:00Z',
    startWarp: 1e3,
    focus: 'moon',
    view: {
      radialMode: 'linear',
      azimuthRad: 1.9,
      elevationRad: 0.35,
      distanceUnits: 60,
      centeredOn: 'focus',
    },
  },
];

export const SCENARIOS: readonly Scenario[] = RAW.map((s) =>
  assertScenario(s, `bundled scenario "${s.id}"`),
);

/** The scenario the app opens with when nothing else is specified. */
export const DEFAULT_SCENARIO_ID = 'inner-system';

export function scenarioById(id: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.id === id);
}

export function defaultScenario(): Scenario {
  const found = scenarioById(DEFAULT_SCENARIO_ID);
  if (!found) throw new Error(`Bundled default scenario "${DEFAULT_SCENARIO_ID}" is missing`);
  return found;
}
