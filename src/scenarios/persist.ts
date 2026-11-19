/**
 * Persistence: remembering the last scenario across a reload.
 *
 * Storage is optional by construction. Every function here takes the `Storage`-shaped object as
 * an argument rather than reaching for `window.localStorage`, for three reasons: `src/sim` and
 * `src/core` may not touch the DOM; the app must work when storage is unavailable (private
 * mode, quota exceeded, cookies blocked) and "works when storage throws" is a case a test can
 * only reach if the store is a parameter; and a fake store makes the version-mismatch and
 * corrupt-data paths testable without leaving junk in a real browser profile.
 *
 * The stored payload is an envelope, not a bare scenario:
 *
 *     { "storeVersion": 1, "savedAt": "...", "scenario": { ... } }
 *
 * The envelope's own version is separate from `scenario.schemaVersion` on purpose. They answer
 * different questions: the scenario's version says how to read the scenario, the envelope's says
 * how to read the *box*. A change to the envelope (say, storing several scenarios) must not look
 * like a change to the scenario schema.
 */

import { SCENARIO_SCHEMA_VERSION, type Scenario } from './types.js';
import { migrateScenario } from './migrate.js';

/** Bump when the envelope changes shape. Independent of the scenario schema version. */
export const STORE_VERSION = 1;

/** The key this app uses. Namespaced so it cannot collide with another app on the same origin. */
export const STORAGE_KEY = 'periapsis.scenario.v1';

/** The subset of `Storage` this module needs. Lets a test pass an object literal. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface StoredScenario {
  readonly scenario: Scenario;
  /** ISO-8601 instant the scenario was saved. Metadata only; never used in physics. */
  readonly savedAt: string;
}

export type LoadResult =
  | { readonly ok: true; readonly value: StoredScenario }
  | {
      readonly ok: false;
      /** `empty` is a first run; `corrupt` was discarded; `unreadable` could not be read. */
      readonly reason: 'empty' | 'corrupt' | 'unreadable' | 'newer';
      readonly detail: string;
    };

/**
 * Saves a scenario.
 *
 * Returns false rather than throwing when the store refuses - a full quota or a blocked
 * localStorage is a normal condition in a browser, not an error worth unwinding React for. The
 * caller may show a hint; the app keeps working because nothing depends on the write.
 */
export function saveScenario(store: KeyValueStore, scenario: Scenario, savedAt: string): boolean {
  const payload = JSON.stringify({
    storeVersion: STORE_VERSION,
    savedAt,
    scenario,
  });
  try {
    store.setItem(STORAGE_KEY, payload);
    return true;
  } catch {
    return false;
  }
}

/**
 * Loads the remembered scenario.
 *
 * A corrupt or unreadable entry is *removed* on the way out, because the alternative is an app
 * that fails to restore on every load forever and never self-heals. The removal is best-effort:
 * if the store refuses to delete, the failure to load is still reported.
 */
export function loadScenario(store: KeyValueStore): LoadResult {
  let raw: string | null;
  try {
    raw = store.getItem(STORAGE_KEY);
  } catch (err) {
    return {
      ok: false,
      reason: 'unreadable',
      detail: `storage could not be read: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (raw === null || raw === '') return { ok: false, reason: 'empty', detail: 'nothing saved' };

  let envelope: unknown;
  try {
    envelope = JSON.parse(raw);
  } catch {
    discard(store);
    return {
      ok: false,
      reason: 'corrupt',
      detail: 'the saved scenario is not valid JSON; it has been discarded',
    };
  }

  if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope)) {
    discard(store);
    return {
      ok: false,
      reason: 'corrupt',
      detail: 'the saved scenario is not an object; it has been discarded',
    };
  }

  const box = envelope as Record<string, unknown>;
  const storeVersion = box['storeVersion'];
  if (typeof storeVersion !== 'number' || !Number.isInteger(storeVersion)) {
    discard(store);
    return {
      ok: false,
      reason: 'corrupt',
      detail: 'the saved scenario has no store version; it has been discarded',
    };
  }
  if (storeVersion > STORE_VERSION) {
    // Deliberately *not* discarded: a newer build's file may be perfectly good, and deleting it
    // would destroy the user's work to punish a forward-compatibility case.
    return {
      ok: false,
      reason: 'newer',
      detail:
        `the saved scenario was written by a newer build (store ${storeVersion}, ` +
        `this build writes ${STORE_VERSION}) and is being left in place`,
    };
  }

  const migrated = migrateScenario(box['scenario']);
  if (!migrated.ok || !migrated.scenario.ok) {
    const issues = migrated.ok
      ? migrated.scenario.ok
        ? []
        : migrated.scenario.issues
      : migrated.issues;
    discard(store);
    return {
      ok: false,
      reason: 'corrupt',
      detail:
        `the saved scenario no longer validates (${issues[0]?.path ?? '?'}: ` +
        `${issues[0]?.message ?? 'unknown'}); it has been discarded`,
    };
  }

  const savedAt = typeof box['savedAt'] === 'string' ? box['savedAt'] : '';
  return { ok: true, value: { scenario: migrated.scenario.scenario, savedAt } };
}

/** Clears the remembered scenario. Best-effort, like every other write here. */
export function clearScenario(store: KeyValueStore): void {
  discard(store);
}

function discard(store: KeyValueStore): void {
  try {
    store.removeItem(STORAGE_KEY);
  } catch {
    // A store that refuses to delete is a store this app cannot fix. The load still failed,
    // which is the part the caller acts on.
  }
}

/**
 * The browser's localStorage, or null when it is unavailable.
 *
 * Accessed through a getter rather than at module load: touching `window.localStorage` itself
 * throws in some configurations (a sandboxed iframe, cookies fully blocked), so the probe has to
 * be wrapped. A build without a DOM (the unit test run) gets null and every caller degrades.
 */
export function browserStore(): KeyValueStore | null {
  try {
    if (typeof globalThis.localStorage === 'undefined') return null;
    const store = globalThis.localStorage;
    // A storage object that exists but refuses writes is not usable, so probe with a real write
    // and remove it again. Safari's private mode used to behave exactly like this.
    const probe = 'periapsis.probe';
    store.setItem(probe, '1');
    store.removeItem(probe);
    return store;
  } catch {
    return null;
  }
}

/** The scenario schema version this build writes, re-exported for callers that need both. */
export { SCENARIO_SCHEMA_VERSION };
