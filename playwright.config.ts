import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end configuration.
 *
 * The suite runs against the Vite dev server, which Playwright starts and stops itself so
 * that a test run needs no manual setup. Chromium only: the app is a canvas + React shell
 * with no browser-specific behaviour worth tripling the runtime for.
 *
 * WebGL matters here. Headless Chromium needs `--use-gl=swiftshader` to provide a software
 * GL implementation; without it the canvas context fails to create and the smoke test would
 * be checking the error path rather than the real one.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  timeout: 30_000,
  use: {
    baseURL: 'http://localhost:5183',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
        },
      },
    },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5183',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
