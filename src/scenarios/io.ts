/**
 * Scenario files: export, import, and the error report an import produces.
 *
 * Pure. No DOM, no storage, no `Date.now` - the caller supplies the text and gets back either a
 * scenario or a list of issues. That split is what lets the import path be unit tested against
 * every malformed file I can think of, which is the only way to be confident that a bad file
 * produces a message rather than a broken app.
 *
 * The export format is deliberately plain: a JSON object with the same shape `validateScenario`
 * reads. No envelope, no signature, no compression. A scenario file a person can open and edit
 * in a text editor is a feature (it is how the bundled catalogue is written), and a format that
 * needs this app to read it would not be a file format so much as a serialisation of state.
 */

import { SCENARIO_SCHEMA_VERSION, type Scenario } from './types.js';
import { migrateScenario } from './migrate.js';
import type { ScenarioIssue } from './validate.js';

export interface ExportOptions {
  /** Pretty-print with two-space indent. Off by default for size. */
  readonly pretty?: boolean;
}

/**
 * Serialises a scenario to the file format.
 *
 * Field order is fixed by construction rather than by object key order, so two exports of the
 * same scenario are byte-identical. That matters for `git diff` on a scenario the user keeps in
 * a repo, and it is cheap to guarantee.
 */
export function exportScenario(scenario: Scenario, options: ExportOptions = {}): string {
  const ordered = {
    schemaVersion: scenario.schemaVersion,
    id: scenario.id,
    name: scenario.name,
    description: scenario.description,
    epochUtc: scenario.epochUtc,
    startWarp: scenario.startWarp,
    focus: scenario.focus,
    view: {
      radialMode: scenario.view.radialMode,
      azimuthRad: scenario.view.azimuthRad,
      elevationRad: scenario.view.elevationRad,
      distanceUnits: scenario.view.distanceUnits,
      centeredOn: scenario.view.centeredOn,
    },
    ...(scenario.mission
      ? {
          mission: {
            id: scenario.mission.id,
            name: scenario.mission.name,
            centralBody: scenario.mission.centralBody,
            orbit: {
              altitudeM: scenario.mission.orbit.altitudeM,
              inclinationRad: scenario.mission.orbit.inclinationRad,
              phaseRad: scenario.mission.orbit.phaseRad,
            },
            deltaVBudget: scenario.mission.deltaVBudget,
            propagation: scenario.mission.propagation,
            horizonSeconds: scenario.mission.horizonSeconds,
            maneuvers: scenario.mission.maneuvers.map((m) => ({
              id: m.id,
              timeSeconds: m.timeSeconds,
              a: m.a,
              b: m.b,
              c: m.c,
              frame: m.frame,
              ...(m.label === undefined ? {} : { label: m.label }),
            })),
          },
        }
      : {}),
  };

  return JSON.stringify(ordered, null, options.pretty ? 2 : 0);
}

/** A proposed filename for a scenario, derived from its id and safe on every filesystem. */
export function scenarioFilename(scenario: Scenario): string {
  // The id is already restricted by validation to a non-empty string, but it is not necessarily
  // filename-safe: a user-authored id could contain a slash or a colon. Everything outside
  // [a-z0-9-] becomes a hyphen and runs are collapsed, so the result cannot escape a directory
  // or be rejected by Windows.
  const safe = scenario.id
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return `${safe === '' ? 'scenario' : safe}.periapsis.json`;
}

export type ImportResult =
  | { readonly ok: true; readonly scenario: Scenario }
  | {
      readonly ok: false;
      /** One line for a banner: what went wrong, in a sentence. */
      readonly summary: string;
      /** Per-field detail, empty when the failure was at the file level. */
      readonly issues: readonly ScenarioIssue[];
    };

/**
 * Reads a scenario file.
 *
 * The failure modes are ordered by how much they tell the user, because "Invalid JSON" and
 * "mission.orbit.altitudeM: must be positive" are both failures but only one is actionable.
 * Every path returns, none throw: an import that can crash the app is worse than one that
 * refuses a file.
 */
export function importScenario(text: string): ImportResult {
  const trimmed = text.trim();
  if (trimmed === '') {
    return { ok: false, summary: 'The file is empty.', issues: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    // JSON.parse's own message includes the offending character position, which is the one
    // piece of information a person editing the file actually needs. Kept, but prefixed so it
    // is clear which layer refused.
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, summary: `The file is not valid JSON: ${detail}`, issues: [] };
  }

  const migrated = migrateScenario(parsed);
  if (!migrated.ok) {
    return { ok: false, summary: summarise(migrated.issues), issues: migrated.issues };
  }
  if (!migrated.scenario.ok) {
    return {
      ok: false,
      summary: summarise(migrated.scenario.issues),
      issues: migrated.scenario.issues,
    };
  }

  return { ok: true, scenario: migrated.scenario.scenario };
}

/** One sentence naming the first problem and, when there are more, how many. */
function summarise(issues: readonly ScenarioIssue[]): string {
  const first = issues[0];
  if (!first) return 'The file could not be read.';
  const where = first.path === '' ? 'the file' : first.path;
  const rest = issues.length > 1 ? ` (and ${issues.length - 1} more)` : '';
  return `${where}: ${first.message}${rest}`;
}

/**
 * The version a file declares, without validating anything else.
 *
 * Used to answer "is this a newer file?" before promising the user their scenario can be
 * opened. Returns null when there is no readable version at all.
 */
export function declaredVersion(text: string): number | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const raw = (parsed as Record<string, unknown>)['schemaVersion'];
  return typeof raw === 'number' && Number.isInteger(raw) ? raw : null;
}

/** True when a file is readable by this build (same version or migratable). */
export function isReadableVersion(version: number | null): boolean {
  return version !== null && version <= SCENARIO_SCHEMA_VERSION;
}
