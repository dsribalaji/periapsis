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
  {
    schemaVersion: SCENARIO_SCHEMA_VERSION,
    id: 'leo-raise',
    name: 'LEO orbit raise',
    description:
      'A satellite in a 550 km orbit at 53 degrees, with one prograde raise node planned.',
    epochUtc: '2026-11-18T12:00:00Z',
    // Paused: a 550 km orbit laps in 96 minutes, and at warp 1000 that is 24 revolutions a
    // minute. The point of this scenario is to read the node, so it opens still.
    startWarp: 0,
    focus: 'earth',
    view: {
      radialMode: 'linear',
      azimuthRad: 1.2,
      elevationRad: 0.55,
      distanceUnits: 26,
      centeredOn: 'focus',
    },
    mission: {
      id: 'sat-a',
      name: 'Constellation A',
      centralBody: 'earth',
      orbit: { altitudeM: 550e3, inclinationRad: (53 * Math.PI) / 180, phaseRad: 0 },
      // A small budget: one raise plus margin. The plan below spends 62 m/s of it.
      deltaVBudget: 120,
      propagation: 'twoBody',
      // Two revolutions, so the drawn arc closes and a full orbit is visible at once.
      horizonSeconds: 11600,
      maneuvers: [
        {
          id: 'raise-1',
          timeSeconds: 2900,
          a: 62,
          b: 0,
          c: 0,
          frame: 'local',
          label: 'Raise 62 m/s',
        },
      ],
    },
  },
  {
    schemaVersion: SCENARIO_SCHEMA_VERSION,
    id: 'gto-transfer',
    name: 'GTO to GEO',
    description:
      'A two-burn geostationary transfer from a 300 km park, with the plane change combined into the apogee burn.',
    epochUtc: '2026-11-18T12:00:00Z',
    // Paused: the whole mission is five hours and two nodes, and one of them is at T+0.
    // Playing at any warp would hide the perigee burn before it could be read.
    startWarp: 0,
    focus: 'earth',
    view: {
      radialMode: 'linear',
      azimuthRad: 0.9,
      elevationRad: 0.42,
      // 42,164 km is 6.6 Earth radii; at Earth's 282x exaggeration that is about 7.9 scene
      // units of orbit radius, so a 30-unit camera holds the whole transfer with room to spare.
      distanceUnits: 30,
      centeredOn: 'focus',
    },
    mission: {
      id: 'geo-sat',
      name: 'GEO satellite',
      centralBody: 'earth',
      // 28.5 degrees: the real Cape Canaveral latitude, and this model's ecliptic datum
      // (PHYSICS.md §10.4). The park's plane is preserved through the apogee burn, so the
      // 28.5-degree tilt is what the plane change has to remove.
      orbit: { altitudeM: 300e3, inclinationRad: (28.5 * Math.PI) / 180, phaseRad: 0 },
      // Measured: 2,427.8 + 1,830.7 = 4,258.4 m/s. A real GTO-to-GEO budget is around
      // 4,300-4,500 m/s including margin, so 4,400 leaves 141 m/s rather than pretending the
      // impulsive model pays for a real spacecraft's losses.
      deltaVBudget: 4400,
      propagation: 'twoBody',
      // Half the transfer ellipse (18,986 s) plus one sidereal day (86,164 s) of coast at GEO,
      // so the circularised orbit closes rather than ending at the burn.
      horizonSeconds: 105150,
      maneuvers: [
        {
          id: 'perigee-raise',
          // At the epoch: the craft starts at perigee, which is where this burn belongs. The
          // propagator applies a T+0 node before propagating anything.
          timeSeconds: 0,
          // Hohmann departure burn from 300 km to the transfer ellipse, 2,427.77 m/s.
          a: 2427.77,
          b: 0,
          c: 0,
          frame: 'local',
          label: 'Perigee raise 2.43 km/s',
        },
        {
          id: 'apogee-circularise',
          // Half the transfer ellipse, measured: 18,986.0 s.
          timeSeconds: 18986,
          // Circularisation at GEO combined with the 28.5-degree plane change. Separate they
          // cost 1,467.6 + 1,513.7 = 2,981.2 m/s; combined they cost 1,830.7, because a plane
          // change is cheaper wherever the velocity is smallest - and at apogee it is 1.61 km/s.
          // Same saving a real GTO mission flies.
          a: 1094.97,
          b: 1467.1,
          c: 0,
          frame: 'local',
          label: 'GEO insertion 1.83 km/s',
        },
      ],
    },
  },
  {
    schemaVersion: SCENARIO_SCHEMA_VERSION,
    id: 'earth-mars-departure',
    name: 'Earth to Mars departure',
    description:
      'A spacecraft parked at 300 km, 51.6 degrees, with the 2028 Mars window one porkchop click away.',
    // A 2028 epoch, so the next Mars window is inside the default three-year plot window
    // rather than behind it. The cheapest cell measured from this epoch is 2028-11-21.
    epochUtc: '2028-11-01T00:00:00Z',
    startWarp: 0,
    focus: 'earth',
    view: {
      radialMode: 'linear',
      azimuthRad: 1.0,
      elevationRad: 0.5,
      distanceUnits: 22,
      centeredOn: 'focus',
    },
    mission: {
      id: 'tmi-craft',
      name: 'Mars transfer vehicle',
      centralBody: 'earth',
      // 51.6 degrees is the ISS/launch-site inclination, and measured as the best of the
      // realistic parks for this window: it aims only 8.8 degrees out of the parking plane at
      // an asymptote 25.9 degrees above the ecliptic, so the forced plane change is small.
      // The same cell from equatorial costs 6,581 m/s against 4,338 here (PHYSICS.md §12.4).
      orbit: { altitudeM: 300e3, inclinationRad: (51.6 * Math.PI) / 180, phaseRad: 0 },
      // Measured burn for the default window's cheapest cell: 4,338 m/s. A little margin on
      // top, since a real departure also pays for gravity losses and a residual.
      deltaVBudget: 4700,
      propagation: 'twoBody',
      // One parking revolution. No departure node is planned yet, which is the point of the
      // scenario: the user opens the porkchop and clicks a cell, and `applyDepartureNode`
      // extends this horizon out to the burn and its coast.
      horizonSeconds: 5422,
      maneuvers: [],
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
