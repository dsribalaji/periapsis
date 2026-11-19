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
    coverage: {
      provider: 'v8',
      include: ['src/core/**', 'src/sim/**', 'src/scenarios/**'],
      reporter: ['text-summary'],
    },
  },
});
