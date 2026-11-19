import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { version as packageVersion } from '../package.json';

/**
 * The version has one source: `package.json`.
 *
 * Three places show it to a person - the sidebar badge, this file's build, and the release tag -
 * and the badge used to be a hand-typed string that had already drifted from the package version
 * (`v0.1.0-dev` against `0.0.0`). A wrong version number is a small lie that makes every other
 * number in a bug report suspect, so it is worth a test that costs nothing to run.
 *
 * The assertion is against the *injected constant*, not against a second copy of the string: this
 * checks the wiring in `vite.config.ts`, which is the part that can break, rather than checking
 * that a literal equals itself.
 */
describe('version', () => {
  it('is injected into the bundle from package.json', () => {
    expect(__APP_VERSION__).toBe(packageVersion);
  });

  it('is a version a release can be tagged with', () => {
    // Loose semver: this is a sanity check on the format, not a second semver parser.
    expect(packageVersion).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  });

  it('matches what package.json declares, not a copy of it', () => {
    // Reading the file directly as well, because `version` above is the resolved import: if the
    // import were ever pointed somewhere else, this catches it.
    const text = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    const parsed = JSON.parse(text) as { version?: unknown };
    expect(parsed.version).toBe(__APP_VERSION__);
  });
});
