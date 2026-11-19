import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';

/**
 * The version is read from `package.json` rather than written twice.
 *
 * It appears in three places a user can see - the sidebar badge, the exported scenario file's
 * `appVersion`, and this build - and a hand-maintained copy of a version number is a copy that
 * will eventually be wrong. `package.json` is the source; this injects it as a compile-time
 * constant so the bundle carries the number without importing JSON at runtime.
 *
 * `tests/version.test.ts` asserts the constant matches the file, so a mistake in this wiring is
 * a failing test rather than a stale badge in a release.
 */
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};

export default defineConfig({
  plugins: [react()],
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 1400,
  },
  server: { port: 5183, strictPort: false },
  preview: { port: 5184, strictPort: false },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    reporters: ['default'],
    // 20 s, up from Vitest's 5 s default. Several tests here do real numerical work - the lunar
    // free-return flies a 4,000-sample N-body integration, the departure phase search scans many
    // geometries - and they run one file per worker on a CPU that other workers share. At the
    // default, the 4.0-4.4 s they take alone became timeouts when the whole suite ran at once,
    // which reports a loaded machine as a physics failure. The timeout is a load budget, not a
    // leniency setting: no assertion or tolerance was changed, and every number a test checks is
    // still the number it was written with (see PHYSICS.md).
    testTimeout: 20_000,
    coverage: {
      provider: 'v8',
      include: ['src/core/**', 'src/sim/**', 'src/scenarios/**'],
      reporter: ['text-summary'],
    },
  },
});
