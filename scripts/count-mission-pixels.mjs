/**
 * Counts mission-orange pixels the same way `e2e/shell.spec.ts` does.
 *
 * A WebGL canvas does not need `preserveDrawingBuffer` to be *screenshotted* by Playwright, but
 * `createImageBitmap(canvas)` inside the page reads a cleared buffer and returns nothing. So the
 * count uses `canvas.screenshot()` and decodes the PNG, which is exactly what the e2e assertion
 * measures, and therefore the only count that can explain it.
 *
 * Usage: node scripts/count-mission-pixels.mjs <scenarioId> [zooms]
 */
import { chromium } from 'playwright';

const scenarioId = process.argv[2] ?? 'leo-raise';
const zooms = Number(process.argv[3] ?? '0');

const browser = await chromium.launch({
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1400, height: 860 } });
await page.goto('http://localhost:5183/');
await page.getByLabel('Scenario').selectOption(scenarioId);
await page.waitForTimeout(1500);

if (zooms > 0) {
  await page.locator('.viewport').hover();
  for (let i = 0; i < zooms; i++) {
    await page.mouse.wheel(0, -400);
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(600);
}

const png = await page.locator('.viewport canvas').screenshot();
const count = await page.evaluate(async (base64) => {
  const blob = await (await fetch(`data:image/png;base64,${base64}`)).blob();
  const bitmap = await createImageBitmap(blob);
  const scratch = document.createElement('canvas');
  scratch.width = bitmap.width;
  scratch.height = bitmap.height;
  const ctx = scratch.getContext('2d');
  if (!ctx) throw new Error('no 2d context');
  ctx.drawImage(bitmap, 0, 0);
  const { data } = ctx.getImageData(0, 0, scratch.width, scratch.height);
  let count = 0;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i] ?? 0;
    const g = data[i + 1] ?? 0;
    const b = data[i + 2] ?? 0;
    if (r > 90 && g > 40 && g < 190 && b < 80 && r > g + 40) count++;
  }
  return count;
}, png.toString('base64'));

console.log(`${scenarioId}${zooms ? ` (+${zooms} zooms)` : ''}: ${count} mission-colour pixels`);
await browser.close();
