/**
 * Boot: deciding which scenario the app opens with.
 *
 * A reload should put the user back where they were, but not at the cost of the app failing to
 * start. `loadScenario` already classifies every way a stored scenario can be unusable; this
 * module turns that classification into the three outcomes the UI has to distinguish:
 *
 *   - **Restored.** The stored scenario is what the app opens with, and the panel says so,
 *     because an app that silently opens somewhere other than the default is confusing on the
 *     first visit after a change.
 *   - **Discarded.** The entry was corrupt or no longer validated, and `loadScenario` has already
 *     removed it. The app opens the default and says the saved copy was dropped, rather than
 *     pretending nothing was ever there.
 *   - **Preserved.** The entry came from a newer build. It is deliberately *not* overwritten on
 *     this session's first save, because destroying a file this build cannot read in order to
 *     save a default is the one outcome worse than not restoring.
 *
 * Separated from `App.tsx` so all three can be unit tested against a fake store. The component
 * then only has to render what this returns.
 */

import { defaultScenario } from '../scenarios/catalogue.js';
import {
  browserStore,
  loadScenario,
  type KeyValueStore,
  type LoadResult,
} from '../scenarios/persist.js';
import type { Scenario } from '../scenarios/types.js';

export interface BootState {
  /** The scenario the app should open with. Never null: booting always produces something. */
  readonly scenario: Scenario;
  /**
   * What the store said, or null when there is no store at all.
   *
   * Null and "empty" are different answers: a browser with storage blocked and a first visit
   * both open the default, but only one of them is worth mentioning, and neither is a failure.
   */
  readonly restore: LoadResult | null;
  /** True when a stored scenario exists that this build must not overwrite. */
  readonly preserveStored: boolean;
}

/**
 * Reads the remembered scenario.
 *
 * Never throws. The store is a parameter with the browser's `localStorage` as its default so the
 * app does not have to pass one and a test does not have to fake a global.
 */
export function bootScenario(store: KeyValueStore | null = browserStore()): BootState {
  const fallback = defaultScenario();
  if (store === null) {
    return { scenario: fallback, restore: null, preserveStored: false };
  }

  const restore = loadScenario(store);
  if (restore.ok) {
    return { scenario: restore.value.scenario, restore, preserveStored: false };
  }

  // A newer store version is the only reason to hold back the first save. Corrupt entries have
  // already been discarded by `loadScenario`, so there is nothing left to protect.
  return { scenario: fallback, restore, preserveStored: restore.reason === 'newer' };
}
