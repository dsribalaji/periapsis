/**
 * Captures screenshots of each bundled scenario for visual review.
 *
 * The agent building this cannot view images, so these are never "looked at": they are fed to
 * scripts/inspect-screenshot.mjs, which reports measurable facts (dimensions, colour variety,
 * brightness distribution). That is enough to catch a black screen, a missing texture or a Moon
 * buried inside the Earth — and not enough to judge aesthetics, which is what a human is for.
 *
 * Usage: node scripts/capture-scenarios.mjs [outDir]
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const outDir = process.argv[2] ?? 'screenshots';
mkdirSync(outDir, { recursive: true });

const SCENARIOS = [
  ['inner-system', 'inner'],
  ['whole-system', 'whole'],
  ['earth-moon', 'earth-moon'],
  ['leo-raise', 'leo'],
  ['lunar-free-return', 'free-return'],
];

const browser = await chromium.launch({
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1400, height: 860 } });
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto('http://localhost:5183/');

for (const [id, name] of SCENARIOS) {
  await page.getByLabel('Scenario').selectOption(id);
  // Let the canvas settle: textures generate up front, but the first frames after a camera
  // move are where a partial build would show.
  await page.waitForTimeout(1400);
  await page.screenshot({ path: `${outDir}/scenario-${name}.png` });
  console.log(`captured ${id}`);
}

// A close pass on the Earth-Moon pair, which is the case the user reported as wrong.
await page.getByLabel('Scenario').selectOption('earth-moon');
await page.waitForTimeout(400);
await page.locator('.viewport').hover();
await page.mouse.wheel(0, -600);
await page.waitForTimeout(900);
await page.screenshot({ path: `${outDir}/scenario-earth-moon-close.png` });
console.log('captured earth-moon close');

await browser.close();

if (errors.length) {
  console.log(`\n${errors.length} console error(s):`);
  for (const e of errors) console.log('  ' + e);
  process.exitCode = 1;
} else {
  console.log('\nno console errors');
}
