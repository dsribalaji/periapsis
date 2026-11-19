/**
 * Scenario validation.
 *
 * The point of this module is that a malformed scenario produces a *list of reasons*, never a
 * half-loaded app and never a silently wrong orbit. Every check returns the field path that
 * failed so the UI can point at it, which is what M7.2's import error report needs.
 *
 * It validates structure, not physics: a scenario only names an epoch and a camera, so there
 * is no orbital state here that could be wrong. That is deliberate — deriving position from
 * the epoch means a scenario file cannot contradict the ephemeris.
 */

import { BODIES, type BodyId } from '../core/ephemeris/solarSystem.js';
import { jdFromIsoUtc } from '../core/time/time.js';
import { WARP_STEPS } from '../sim/clock.js';
import type { CraftSpec } from '../sim/craft.js';
import type { Maneuver, ManeuverFrame } from '../sim/maneuver.js';
import { SCENARIO_SCHEMA_VERSION, type Scenario } from './types.js';

export interface ScenarioIssue {
  /** Dot-separated path of the offending field, e.g. `view.distanceUnits`. */
  readonly path: string;
  readonly message: string;
}

export type ValidationResult =
  | { readonly ok: true; readonly scenario: Scenario }
  | { readonly ok: false; readonly issues: readonly ScenarioIssue[] };

const RADIAL_MODES = new Set(['linear', 'compressed']);
const MANEUVER_FRAMES = new Set<ManeuverFrame>(['local', 'inertial']);
const PROPAGATION_MODES = new Set(['twoBody', 'nbody']);

function issue(path: string, message: string): ScenarioIssue {
  return { path, message };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function nonEmptyString(v: unknown, path: string, issues: ScenarioIssue[]): string | null {
  if (typeof v !== 'string' || v.trim() === '') {
    issues.push(issue(path, 'must be a non-empty string'));
    return null;
  }
  return v;
}

function finiteNumber(v: unknown, path: string, issues: ScenarioIssue[]): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    issues.push(issue(path, 'must be a finite number'));
    return null;
  }
  return v;
}

/**
 * Validates an unknown value as a mission (spacecraft spec).
 *
 * Returns null and pushes issues when anything is wrong, so a bad mission can never reach
 * `craftFromSpec` and produce a state nobody checked.
 */
function validateMission(input: unknown, issues: ScenarioIssue[]): CraftSpec | null {
  if (input === undefined) return null;
  if (!isRecord(input)) {
    issues.push(issue('mission', 'must be an object when present'));
    return null;
  }

  const before = issues.length;
  const id = nonEmptyString(input['id'], 'mission.id', issues);
  const name = nonEmptyString(input['name'], 'mission.name', issues);

  const rawCentral = input['centralBody'];
  let centralBody: BodyId | null = null;
  if (typeof rawCentral !== 'string' || !(rawCentral in BODIES)) {
    issues.push(issue('mission.centralBody', `must be one of ${Object.keys(BODIES).join(', ')}`));
  } else {
    centralBody = rawCentral as BodyId;
  }

  const rawOrbit = input['orbit'];
  let orbit: CraftSpec['orbit'] | null = null;
  if (!isRecord(rawOrbit)) {
    issues.push(issue('mission.orbit', 'must be an object'));
  } else {
    const altitude = finiteNumber(rawOrbit['altitudeM'], 'mission.orbit.altitudeM', issues);
    const inclination = finiteNumber(
      rawOrbit['inclinationRad'],
      'mission.orbit.inclinationRad',
      issues,
    );
    const phase = finiteNumber(rawOrbit['phaseRad'], 'mission.orbit.phaseRad', issues);
    if (altitude !== null && !(altitude > 0)) {
      issues.push(
        issue('mission.orbit.altitudeM', 'must be positive: the orbit must clear the surface'),
      );
    }
    if (inclination !== null && !(inclination >= 0 && inclination <= Math.PI)) {
      issues.push(issue('mission.orbit.inclinationRad', 'must be within [0, pi]'));
    }
    if (altitude !== null && inclination !== null && phase !== null && altitude > 0) {
      orbit = { altitudeM: altitude, inclinationRad: inclination, phaseRad: phase };
    }
  }

  const budget = finiteNumber(input['deltaVBudget'], 'mission.deltaVBudget', issues);
  if (budget !== null && !(budget > 0)) {
    issues.push(issue('mission.deltaVBudget', 'must be positive'));
  }

  const rawPropagation = input['propagation'];
  if (typeof rawPropagation !== 'string' || !PROPAGATION_MODES.has(rawPropagation)) {
    issues.push(issue('mission.propagation', "must be 'twoBody' or 'nbody'"));
  }

  const horizon = finiteNumber(input['horizonSeconds'], 'mission.horizonSeconds', issues);
  if (horizon !== null && !(horizon > 0)) {
    issues.push(issue('mission.horizonSeconds', 'must be positive'));
  }

  const rawManeuvers = input['maneuvers'];
  let maneuvers: Maneuver[] | null = [];
  if (rawManeuvers !== undefined && !Array.isArray(rawManeuvers)) {
    issues.push(issue('mission.maneuvers', 'must be an array'));
    maneuvers = null;
  } else if (Array.isArray(rawManeuvers)) {
    const parsed: Maneuver[] = [];
    for (let i = 0; i < rawManeuvers.length; i++) {
      const m = validateManeuver(rawManeuvers[i], `mission.maneuvers[${i}]`, issues);
      if (m) parsed.push(m);
      else maneuvers = null;
    }
    if (maneuvers !== null) maneuvers = parsed;
  }

  if (
    issues.length > before ||
    id === null ||
    name === null ||
    centralBody === null ||
    orbit === null ||
    budget === null ||
    horizon === null ||
    maneuvers === null ||
    typeof rawPropagation !== 'string' ||
    !PROPAGATION_MODES.has(rawPropagation)
  ) {
    return null;
  }

  return {
    id,
    name,
    centralBody,
    orbit,
    deltaVBudget: budget,
    propagation: rawPropagation as CraftSpec['propagation'],
    horizonSeconds: horizon,
    maneuvers,
  };
}

function validateManeuver(input: unknown, path: string, issues: ScenarioIssue[]): Maneuver | null {
  if (!isRecord(input)) {
    issues.push(issue(path, 'must be an object'));
    return null;
  }
  const before = issues.length;
  const id = nonEmptyString(input['id'], `${path}.id`, issues);
  const time = finiteNumber(input['timeSeconds'], `${path}.timeSeconds`, issues);
  const a = finiteNumber(input['a'], `${path}.a`, issues);
  const b = finiteNumber(input['b'], `${path}.b`, issues);
  const c = finiteNumber(input['c'], `${path}.c`, issues);

  const rawFrame = input['frame'];
  if (typeof rawFrame !== 'string' || !MANEUVER_FRAMES.has(rawFrame as ManeuverFrame)) {
    issues.push(issue(`${path}.frame`, "must be 'local' or 'inertial'"));
  }

  const rawLabel = input['label'];
  let label: string | undefined;
  if (rawLabel !== undefined) {
    if (typeof rawLabel !== 'string') issues.push(issue(`${path}.label`, 'must be a string'));
    else label = rawLabel;
  }

  if (
    issues.length > before ||
    id === null ||
    time === null ||
    a === null ||
    b === null ||
    c === null ||
    typeof rawFrame !== 'string' ||
    !MANEUVER_FRAMES.has(rawFrame as ManeuverFrame)
  ) {
    return null;
  }
  return { id, timeSeconds: time, a, b, c, frame: rawFrame as ManeuverFrame, label };
}

/**
 * Validates an unknown value as a scenario.
 *
 * The returned scenario is a *fresh object* built from the validated fields, not the input
 * with a cast. Extra properties in the input are dropped, so nothing unvalidated can ride
 * along into the app behind a passing check.
 */
export function validateScenario(input: unknown): ValidationResult {
  const issues: ScenarioIssue[] = [];

  if (!isRecord(input)) {
    return { ok: false, issues: [issue('', 'scenario must be an object')] };
  }

  if (input['schemaVersion'] !== SCENARIO_SCHEMA_VERSION) {
    issues.push(
      issue(
        'schemaVersion',
        `unsupported schema version ${String(input['schemaVersion'])}; ` +
          `this build reads version ${SCENARIO_SCHEMA_VERSION}`,
      ),
    );
  }

  const id = nonEmptyString(input['id'], 'id', issues);
  const name = nonEmptyString(input['name'], 'name', issues);
  const description = nonEmptyString(input['description'], 'description', issues);

  let epochUtc: string | null = null;
  const rawEpoch = input['epochUtc'];
  if (typeof rawEpoch !== 'string') {
    issues.push(issue('epochUtc', 'must be an ISO-8601 UTC string'));
  } else {
    try {
      // jdFromIsoUtc is the same parser the simulation uses, so "valid here" means
      // "loadable there" — not merely that a regex matched.
      jdFromIsoUtc(rawEpoch);
      epochUtc = rawEpoch;
    } catch (err) {
      issues.push(
        issue(
          'epochUtc',
          `unreadable UTC timestamp: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
  }

  const rawWarp = input['startWarp'];
  let startWarp: Scenario['startWarp'] | null = null;
  if (typeof rawWarp !== 'number' || !(WARP_STEPS as readonly number[]).includes(rawWarp)) {
    issues.push(issue('startWarp', `must be one of ${WARP_STEPS.join(', ')}`));
  } else {
    startWarp = rawWarp as Scenario['startWarp'];
  }

  const rawFocus = input['focus'];
  let focus: BodyId | null = null;
  if (typeof rawFocus !== 'string' || !(rawFocus in BODIES)) {
    issues.push(issue('focus', `must be one of ${Object.keys(BODIES).join(', ')}`));
  } else {
    focus = rawFocus as BodyId;
  }

  const rawView = input['view'];
  let view: Scenario['view'] | null = null;
  if (!isRecord(rawView)) {
    issues.push(issue('view', 'must be an object'));
  } else {
    const mode = rawView['radialMode'];
    if (typeof mode !== 'string' || !RADIAL_MODES.has(mode)) {
      issues.push(issue('view.radialMode', "must be 'linear' or 'compressed'"));
    }
    const azimuth = finiteNumber(rawView['azimuthRad'], 'view.azimuthRad', issues);
    const elevation = finiteNumber(rawView['elevationRad'], 'view.elevationRad', issues);
    const distance = finiteNumber(rawView['distanceUnits'], 'view.distanceUnits', issues);
    const centeredOn = rawView['centeredOn'];
    if (centeredOn !== 'sun' && centeredOn !== 'focus' && centeredOn !== 'pair') {
      issues.push(issue('view.centeredOn', "must be 'sun', 'focus' or 'pair'"));
    }
    if (elevation !== null && !(Math.abs(elevation) < Math.PI / 2)) {
      issues.push(
        issue(
          'view.elevationRad',
          'must be strictly inside (-pi/2, pi/2): a top-down camera has no up vector',
        ),
      );
    }
    if (distance !== null && !(distance > 0)) {
      issues.push(issue('view.distanceUnits', 'must be positive'));
    }
    if (
      typeof mode === 'string' &&
      RADIAL_MODES.has(mode) &&
      azimuth !== null &&
      elevation !== null &&
      distance !== null &&
      (centeredOn === 'sun' || centeredOn === 'focus' || centeredOn === 'pair') &&
      Math.abs(elevation) < Math.PI / 2 &&
      distance > 0
    ) {
      view = {
        radialMode: mode as Scenario['view']['radialMode'],
        azimuthRad: azimuth,
        elevationRad: elevation,
        distanceUnits: distance,
        centeredOn,
      };
    }
  }

  const mission = validateMission(input['mission'], issues);

  if (
    issues.length > 0 ||
    id === null ||
    name === null ||
    description === null ||
    epochUtc === null ||
    startWarp === null ||
    focus === null ||
    view === null
  ) {
    return { ok: false, issues };
  }

  return {
    ok: true,
    scenario: {
      schemaVersion: SCENARIO_SCHEMA_VERSION,
      id,
      name,
      description,
      epochUtc,
      startWarp,
      focus,
      view,
      ...(mission ? { mission } : {}),
    },
  };
}

/** Throws on an invalid scenario. For bundled data, where a failure is a build bug. */
export function assertScenario(input: unknown, what = 'scenario'): Scenario {
  const result = validateScenario(input);
  if (result.ok) return result.scenario;
  const detail = result.issues.map((i) => `${i.path || '(root)'}: ${i.message}`).join('; ');
  throw new Error(`Invalid ${what}: ${detail}`);
}
