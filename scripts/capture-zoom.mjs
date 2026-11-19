/**
 * Zooms into a scenario and captures, to check what a small body actually looks like.
 *
 * A body a few pixels across in the default framing is the honest result of a linear layout,
 * and the only way to tell "correctly tiny" from "not drawn" is to get close.
 *
 * Usage: node scripts/capture-zoom.mjs <scenarioId> <notches> <outName>
 */
import { chromium } from 'playwright';

const scenarioId = process.argv[2] ?? 'inner-system';
const notches = Number(process.argv[3] ?? '4');
const outName = process.argv[4] ?? `zoom-${scenarioId}`;

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
await page.getByLabel('Scenario').selectOption(scenarioId);
await page.waitForTimeout(1000);
await page.locator('.viewport').hover();
for (let i = 0; i < notches; i++) {
  await page.mouse.wheel(0, -400);
  await page.waitForTimeout(120);
}
await page.waitForTimeout(600);
await page.screenshot({ path: `screenshots/${outName}.png` });
console.log(`captured ${outName} (${notches} zoom notches)`);
if (errors.length) {
  for (const e of errors) console.log('error: ' + e);
  process.exitCode = 1;
}
await browser.close();
