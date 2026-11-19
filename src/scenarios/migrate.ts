/**
 * Scenario migration.
 *
 * `validateScenario` already rejects a version it does not know. This module answers the other
 * half of the question: a file written by an *older* build should be upgraded and loaded, not
 * refused, as long as the upgrade is something this build actually knows how to do.
 *
 * The chain has one real step today, 1 -> 2 (true-scale bodies; see `migrate1to2`). The rules
 * it follows were written down before any step existed, because the decision that matters is
 * not "which migrations exist" but "what happens when they do":
 *
 *   - A file from a *newer* build is rejected with a message naming both versions. Loading it
 *     would mean guessing at fields this build has never seen, and a scenario that half-loads
 *     is worse than one that refuses to.
 *   - A file from an older build is upgraded by a registered step, then validated normally.
 *   - An *unregistered* gap (version 1 file, build at 3, no step for 1->2) is an error, not a
 *     best-effort parse. A missing migration is a build bug that would otherwise present as
 *     "your file is corrupt".
 *
 * `migrateWith` takes the chain as an argument so the mechanism can be tested with a synthetic
 * chain. Testing it against the real, empty chain would only prove that empty chains are empty.
 */

import { BODIES, type BodyId } from '../core/ephemeris/solarSystem.js';
import { SCENARIO_SCHEMA_VERSION } from './types.js';
import { validateScenario, type ScenarioIssue, type ValidationResult } from './validate.js';

/** One step: turns a raw object at version `from` into the shape of version `from + 1`. */
export interface Migration {
  readonly from: number;
  /** Returns the upgraded raw object. Throws only on genuinely unreadable input. */
  readonly apply: (input: Record<string, unknown>) => Record<string, unknown>;
}

/**
 * How many times larger than its true radius a version-1 build drew a body.
 *
 * Version 1 drew bodies at a cube-root-compressed radius (Earth at 1.2 scene units, 282x its
 * true 0.00426), floored at 0.35 units, and a satellite at its true ratio to its parent's drawn
 * radius. Restated here, frozen, because the renderer no longer has it and a migration must
 * describe the build that *wrote* the file, not the one reading it.
 */
export function legacyExaggeration(id: BodyId): number {
  const AU_M = 1.495978707e11;
  const trueUnits = (r: number) => (r * 100) / AU_M;
  const earthR = 6.371e6;
  const def = BODIES[id];
  let drawn: number;
  if (def.parent !== null && def.parent !== 'sun') {
    const parent = BODIES[def.parent];
    const parentDrawn = Math.max(0.35, 1.2 * Math.cbrt(parent.radius / earthR));
    drawn = Math.max(0.35, parentDrawn * (def.radius / parent.radius));
  } else {
    drawn = Math.max(0.35, 1.2 * Math.cbrt(def.radius / earthR));
  }
  return drawn / trueUnits(def.radius);
}

/**
 * 1 -> 2: bodies went from an exaggerated radius to true scale.
 *
 * A system-wide view (`centeredOn: 'sun'`) is unaffected: planet positions were always at true
 * scale. A body-centred view stored a distance tuned to the exaggerated body, so it is divided
 * by that body's old exaggeration, which frames the body at the same apparent size it had. For
 * a `pair` view the parent's factor is used; the app refits a pair on load anyway, so this is
 * only the fallback.
 *
 * Tolerant of a malformed `view`: anything it cannot read is passed through unchanged, and the
 * validator that runs next reports it with the usual field path.
 */
const migrate1to2: Migration = {
  from: 1,
  apply: (input) => {
    const view = input['view'];
    const focus = input['focus'];
    if (typeof view !== 'object' || view === null || Array.isArray(view)) {
      return { ...input, schemaVersion: 2 };
    }
    const v = view as Record<string, unknown>;
    const distance = v['distanceUnits'];
    const centeredOn = v['centeredOn'];
    if (
      typeof distance !== 'number' ||
      typeof focus !== 'string' ||
      !(focus in BODIES) ||
      (centeredOn !== 'focus' && centeredOn !== 'pair')
    ) {
      return { ...input, schemaVersion: 2 };
    }
    const body = focus as BodyId;
    const reference = centeredOn === 'pair' ? (BODIES[body].parent ?? body) : body;
    return {
      ...input,
      schemaVersion: 2,
      view: { ...v, distanceUnits: distance / legacyExaggeration(reference) },
    };
  },
};

/** The real chain, oldest first. */
export const MIGRATIONS: readonly Migration[] = [migrate1to2];

export type MigrationResult =
  | { readonly ok: true; readonly scenario: ValidationResult }
  | { readonly ok: false; readonly issues: readonly ScenarioIssue[] };

function readVersion(input: unknown): number | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const raw = (input as Record<string, unknown>)['schemaVersion'];
  return typeof raw === 'number' && Number.isInteger(raw) ? raw : null;
}

/**
 * Migrates and then validates, using the given chain. Pure: no I/O, no globals beyond the
 * version constant.
 *
 * `target` exists so the walker can be tested at a version gap this build does not have. The
 * app always uses the default; the parameter is what lets a test prove that a two-step upgrade
 * applies in order and that a step which fails to advance its own version is caught rather than
 * looping forever.
 */
export function migrateWith(
  chain: readonly Migration[],
  input: unknown,
  target: number = SCENARIO_SCHEMA_VERSION,
): MigrationResult {
  const version = readVersion(input);
  if (version === null) {
    return {
      ok: false,
      issues: [
        {
          path: 'schemaVersion',
          message: 'missing or non-integer: cannot tell which build wrote this file',
        },
      ],
    };
  }

  if (version > target) {
    return {
      ok: false,
      issues: [
        {
          path: 'schemaVersion',
          message:
            `file was written by a newer build (schema ${version}); this build reads up to ` +
            `${target}. Refusing rather than guessing at fields it has never seen`,
        },
      ],
    };
  }

  let current = input as Record<string, unknown>;
  let at = version;
  // Each iteration consumes exactly one version gap and `at` is advanced by this loop, not by
  // the step, so the walk cannot repeat a version and cannot fail to terminate. There is
  // deliberately no step-count guard: a guard here would be unreachable code, and unreachable
  // code is only a place for a future bug to hide. The step is trusted to transform the object;
  // it is not trusted to declare which version it produced.
  while (at < target) {
    const step = chain.find((m) => m.from === at);
    if (!step) {
      return {
        ok: false,
        issues: [
          {
            path: 'schemaVersion',
            message:
              `no migration from schema ${at} to ${at + 1}. The file may be fine and this ` +
              'build incomplete; it is not being loaded either way',
          },
        ],
      };
    }
    current = step.apply(current);
    at += 1;
  }

  return { ok: true, scenario: validateScenario(current) };
}

/** Migrates against the real chain. The entry point the app should call. */
export function migrateScenario(input: unknown): MigrationResult {
  return migrateWith(MIGRATIONS, input);
}
