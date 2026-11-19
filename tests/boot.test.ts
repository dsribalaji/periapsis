import { describe, expect, it } from 'vitest';
import { bootScenario } from '../src/ui/boot.js';
import { SCENARIOS, defaultScenario } from '../src/scenarios/catalogue.js';
import {
  STORAGE_KEY,
  STORE_VERSION,
  saveScenario,
  type KeyValueStore,
} from '../src/scenarios/persist.js';

function memoryStore(): KeyValueStore & { readonly data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
}

const SAVED_AT = '2026-11-19T10:00:00Z';
const stored = SCENARIOS.find((s) => s.id !== defaultScenario().id && s.mission)!;

describe('booting', () => {
  it('opens the default with no store at all, and says nothing about it', () => {
    // A browser with storage blocked is not a failure: the app works, it just cannot remember.
    // `restore: null` is how the UI tells "no store" apart from "nothing saved yet".
    const state = bootScenario(null);
    expect(state.scenario).toEqual(defaultScenario());
    expect(state.restore).toBeNull();
    expect(state.preserveStored).toBe(false);
  });

  it('opens the default on a first visit without pretending something broke', () => {
    const state = bootScenario(memoryStore());
    expect(state.scenario).toEqual(defaultScenario());
    expect(state.restore?.ok).toBe(false);
    if (state.restore && !state.restore.ok) expect(state.restore.reason).toBe('empty');
    expect(state.preserveStored).toBe(false);
  });

  it('restores a saved scenario exactly', () => {
    const store = memoryStore();
    saveScenario(store, stored, SAVED_AT);
    const state = bootScenario(store);
    expect(state.scenario).toEqual(stored);
    expect(state.restore?.ok).toBe(true);
    expect(state.preserveStored).toBe(false);
  });

  it('falls back and reports a discarded entry after a corrupt one', () => {
    const store = memoryStore();
    store.setItem(STORAGE_KEY, '{ not json');
    const state = bootScenario(store);
    expect(state.scenario).toEqual(defaultScenario());
    expect(state.restore?.ok).toBe(false);
    if (state.restore && !state.restore.ok) expect(state.restore.reason).toBe('corrupt');
    // Corrupt entries are already gone, so there is nothing to protect from the first save.
    expect(state.preserveStored).toBe(false);
  });

  it('never overwrites an entry from a newer build', () => {
    // The one case where the app must not save: the stored scenario may be the user's only copy,
    // and this build cannot read it. Saving the default over it would destroy it silently.
    const store = memoryStore();
    store.setItem(
      STORAGE_KEY,
      JSON.stringify({ storeVersion: STORE_VERSION + 1, savedAt: SAVED_AT, scenario: stored }),
    );
    const state = bootScenario(store);
    expect(state.scenario).toEqual(defaultScenario());
    expect(state.preserveStored).toBe(true);
    expect(store.data.has(STORAGE_KEY)).toBe(true);
  });

  it('boots a scenario that is valid but not in the bundled catalogue', () => {
    // An imported file keeps its own id, which no `SCENARIOS` entry has. Boot must still open it
    // rather than silently substituting the default for a scenario the user chose to keep.
    const store = memoryStore();
    const custom = { ...stored, id: 'my-custom-mission', name: 'My custom mission' };
    saveScenario(store, custom, SAVED_AT);
    const state = bootScenario(store);
    expect(state.scenario.id).toBe('my-custom-mission');
    expect(state.scenario.name).toBe('My custom mission');
  });

  it('does not mutate the store while booting', () => {
    // A reload that failed to restore must leave the store exactly as it found it, so a later
    // build (or a bug fix) can still read what is there.
    const store = memoryStore();
    store.setItem(
      STORAGE_KEY,
      JSON.stringify({ storeVersion: STORE_VERSION + 1, savedAt: SAVED_AT, scenario: stored }),
    );
    const before = store.data.get(STORAGE_KEY);
    bootScenario(store);
    expect(store.data.get(STORAGE_KEY)).toBe(before);
  });
});
