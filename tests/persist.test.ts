import { describe, expect, it } from 'vitest';
import {
  STORAGE_KEY,
  STORE_VERSION,
  browserStore,
  clearScenario,
  loadScenario,
  saveScenario,
  type KeyValueStore,
} from '../src/scenarios/persist.js';
import { SCENARIOS } from '../src/scenarios/catalogue.js';

/** A store that behaves like a plain Map. */
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

/** A store whose writes fail, like a full quota or Safari private mode. */
function refusingStore(): KeyValueStore {
  return {
    getItem: () => null,
    setItem: () => {
      throw new DOMException('quota exceeded', 'QuotaExceededError');
    },
    removeItem: () => {
      throw new DOMException('blocked', 'SecurityError');
    },
  };
}

/** A store whose reads fail, like a blocked cookie jar. */
function unreadableStore(): KeyValueStore {
  return {
    getItem: () => {
      throw new DOMException('blocked', 'SecurityError');
    },
    setItem: () => undefined,
    removeItem: () => undefined,
  };
}

const scenario = SCENARIOS.find((s) => s.mission)!;
const SAVED_AT = '2026-11-19T10:00:00Z';

describe('saving a scenario', () => {
  it('writes an envelope with its own version and the save time', () => {
    const store = memoryStore();
    expect(saveScenario(store, scenario, SAVED_AT)).toBe(true);

    const raw = store.data.get(STORAGE_KEY);
    expect(raw).toBeDefined();
    const parsed = JSON.parse(raw!) as Record<string, unknown>;
    expect(parsed['storeVersion']).toBe(STORE_VERSION);
    expect(parsed['savedAt']).toBe(SAVED_AT);
    expect((parsed['scenario'] as Record<string, unknown>)['id']).toBe(scenario.id);
  });

  it('reports failure instead of throwing when the store refuses', () => {
    // A blocked or full localStorage is a normal browser condition. Unwinding React over it
    // would take the app down for something the user cannot act on.
    expect(() => saveScenario(refusingStore(), scenario, SAVED_AT)).not.toThrow();
    expect(saveScenario(refusingStore(), scenario, SAVED_AT)).toBe(false);
  });
});

describe('loading a scenario', () => {
  it('returns what was saved, with its timestamp', () => {
    const store = memoryStore();
    saveScenario(store, scenario, SAVED_AT);
    const result = loadScenario(store);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.scenario).toEqual(scenario);
      expect(result.value.savedAt).toBe(SAVED_AT);
    }
  });

  it('reports an empty store distinctly from a broken one', () => {
    // The app treats "nothing saved" as a normal first run and says nothing; a corrupt entry
    // warns. Collapsing the two would make every first launch look like a failure.
    const result = loadScenario(memoryStore());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('empty');
      expect(result.detail).toMatch(/nothing saved/);
    }
  });

  it('discards corrupt JSON and says so, so the next load is clean', () => {
    const store = memoryStore();
    store.setItem(STORAGE_KEY, '{not json');
    const result = loadScenario(store);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('corrupt');
      expect(result.detail).toMatch(/discarded/);
    }
    expect(store.data.has(STORAGE_KEY)).toBe(false);

    // The self-healing property: the second load is a plain empty store, not the same error.
    const second = loadScenario(store);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('empty');
  });

  it('discards an envelope that is not an object', () => {
    for (const bad of ['[]', '42', '"string"']) {
      const store = memoryStore();
      store.setItem(STORAGE_KEY, bad);
      const result = loadScenario(store);
      expect(result.ok, bad).toBe(false);
      if (!result.ok) expect(result.reason).toBe('corrupt');
      expect(store.data.has(STORAGE_KEY), bad).toBe(false);
    }
  });

  it('discards a scenario that no longer validates', () => {
    // The realistic case: a build wrote a scenario, then a rule tightened. The saved copy must
    // not block every subsequent load.
    const store = memoryStore();
    const broken = JSON.parse(JSON.stringify(scenario)) as Record<string, unknown>;
    (broken['view'] as Record<string, unknown>)['distanceUnits'] = -1;
    store.setItem(
      STORAGE_KEY,
      JSON.stringify({ storeVersion: STORE_VERSION, savedAt: SAVED_AT, scenario: broken }),
    );
    const result = loadScenario(store);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('corrupt');
      expect(result.detail).toContain('view.distanceUnits');
    }
    expect(store.data.has(STORAGE_KEY)).toBe(false);
  });

  it('leaves a newer envelope alone rather than deleting the user work', () => {
    // Forward compatibility, one level up: a newer build's file is not this build's to destroy.
    const store = memoryStore();
    store.setItem(
      STORAGE_KEY,
      JSON.stringify({ storeVersion: STORE_VERSION + 1, savedAt: SAVED_AT, scenario }),
    );
    const result = loadScenario(store);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('newer');
      expect(result.detail).toMatch(/left in place/);
    }
    expect(store.data.has(STORAGE_KEY)).toBe(true);
  });

  it('reports an unreadable store without throwing', () => {
    expect(() => loadScenario(unreadableStore())).not.toThrow();
    const result = loadScenario(unreadableStore());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unreadable');
  });

  it('treats an empty string as nothing saved, not as corrupt', () => {
    const store = memoryStore();
    store.setItem(STORAGE_KEY, '');
    const result = loadScenario(store);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('empty');
  });

  it('clears on request', () => {
    const store = memoryStore();
    saveScenario(store, scenario, SAVED_AT);
    clearScenario(store);
    expect(store.data.has(STORAGE_KEY)).toBe(false);
  });

  it('survives a clear on a store that refuses to delete', () => {
    expect(() => clearScenario(refusingStore())).not.toThrow();
  });
});

describe('round-tripping the whole catalogue', () => {
  it('every bundled scenario saves and loads unchanged', () => {
    for (const s of SCENARIOS) {
      const store = memoryStore();
      expect(saveScenario(store, s, SAVED_AT), s.id).toBe(true);
      const result = loadScenario(store);
      expect(result.ok, s.id).toBe(true);
      if (result.ok) expect(result.value.scenario).toEqual(s);
    }
  });

  it('stores missions with their maneuvers intact', () => {
    const store = memoryStore();
    saveScenario(store, scenario, SAVED_AT);
    const result = loadScenario(store);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.scenario.mission!.maneuvers).toEqual(scenario.mission!.maneuvers);
    }
  });
});

describe('browserStore', () => {
  it('returns null outside a browser rather than throwing', () => {
    // The unit-test run has no DOM. This is the same path a blocked-cookie browser takes.
    expect(() => browserStore()).not.toThrow();
    expect(browserStore()).toBeNull();
  });

  it('accepts a storage object that works', () => {
    const store = memoryStore();
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      value: store,
      configurable: true,
      writable: true,
    });
    try {
      expect(browserStore()).toBe(store);
      // The probe must not leave a key behind.
      expect(store.data.has('periapsis.probe')).toBe(false);
    } finally {
      if (original) Object.defineProperty(globalThis, 'localStorage', original);
      else Reflect.deleteProperty(globalThis, 'localStorage');
    }
  });

  it('rejects a storage object that refuses writes, as Safari private mode did', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      value: refusingStore(),
      configurable: true,
      writable: true,
    });
    try {
      expect(browserStore()).toBeNull();
    } finally {
      if (original) Object.defineProperty(globalThis, 'localStorage', original);
      else Reflect.deleteProperty(globalThis, 'localStorage');
    }
  });
});
