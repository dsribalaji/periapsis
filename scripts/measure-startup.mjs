/**
 * Measures how long the first frame takes after a cold load.
 *
 * Procedural textures are generated on the main thread at startup, so they are the obvious
 * suspect for a slow boot: ten bodies, each a per-pixel loop over up to 1024x1024 samples. If
 * that takes seconds, every e2e test's budget is quietly spent before the app is interactive.
 *
 * Usage: node scripts/measure-startup.mjs
 */
import { chromium } from 'playwright';

const browser = await chromium.launch({
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1400, height: 860 } });

const t0 = Date.now();
await page.goto('http://localhost:5183/');
let tSelect = 0;
let tCanvas = 0;
try {
  await page.getByLabel('Scenario').waitFor({ state: 'visible', timeout: 60_000 });
  tSelect = Date.now() - t0;
  await page.locator('.viewport canvas').waitFor({ state: 'visible', timeout: 60_000 });
  tCanvas = Date.now() - t0;
} catch (e) {
  console.log(`wait failed: ${String(e).slice(0, 200)}`);
}

// Time from navigation to the first painted frame with a readout, which is what a test waits on.
await page.waitForTimeout(200);
console.log(`scenario select visible: ${tSelect} ms`);
console.log(`canvas visible:          ${tCanvas} ms`);

// A reload is the slower path the persistence test exercises.
const t1 = Date.now();
await page.reload();
await page.getByLabel('Scenario').waitFor({ state: 'visible', timeout: 60_000 });
console.log(`after reload, select:    ${Date.now() - t1} ms`);

await browser.close();
