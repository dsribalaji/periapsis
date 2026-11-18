/**
 * Measures a screenshot instead of looking at it.
 *
 * The agent that built this cannot see images, so "the screenshot looks right" is not a claim
 * it can make. What it can do is decode the PNG and report facts: dimensions, how much of the
 * frame is not the background, and whether the mission colour is present. That is enough to
 * catch the failure modes that matter here — a blank canvas, a black frame, a scene with no
 * trajectory — without pretending to a visual judgement.
 *
 * Usage: node scripts/inspect-screenshot.mjs screenshots/m4-leo-raise.png
 */

import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/inspect-screenshot.mjs <file.png>');
  process.exit(2);
}

const path = resolve(file);
const base64 = readFileSync(path).toString('base64');

const browser = await chromium.launch();
const page = await browser.newPage();
const result = await page.evaluate(async (data) => {
  const blob = await (await fetch(`data:image/png;base64,${data}`)).blob();
  const bitmap = await createImageBitmap(blob);
  const scratch = document.createElement('canvas');
  scratch.width = bitmap.width;
  scratch.height = bitmap.height;
  const ctx = scratch.getContext('2d');
  if (!ctx) throw new Error('no 2d context');
  ctx.drawImage(bitmap, 0, 0);
  const { data: px } = ctx.getImageData(0, 0, scratch.width, scratch.height);

  let orange = 0;
  let nonDark = 0;
  let sum = 0;
  const histogram = new Map();
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i] ?? 0;
    const g = px[i + 1] ?? 0;
    const b = px[i + 2] ?? 0;
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    sum += luma;
    if (luma > 24) nonDark++;
    if (r > 90 && g > 40 && g < 190 && b < 80 && r > g + 40) orange++;
    const key = `${r >> 4},${g >> 4},${b >> 4}`;
    histogram.set(key, (histogram.get(key) ?? 0) + 1);
  }
  const pixels = px.length / 4;
  const top = [...histogram.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
  return {
    width: bitmap.width,
    height: bitmap.height,
    pixels,
    meanLuma: sum / pixels,
    nonDarkFraction: nonDark / pixels,
    orangePixels: orange,
    distinctColourBuckets: histogram.size,
    topColourBuckets: top.map(([key, count]) => ({ bucket: key, count })),
  };
}, base64);

await browser.close();

const pct = (x) => `${(x * 100).toFixed(1)}%`;
console.log(`file                 ${path}`);
console.log(`size                 ${result.width}x${result.height} (${result.pixels} px)`);
console.log(`mean luma            ${result.meanLuma.toFixed(1)} / 255`);
console.log(`non-background       ${pct(result.nonDarkFraction)}`);
console.log(`distinct buckets     ${result.distinctColourBuckets}`);
console.log(`mission orange       ${result.orangePixels} px`);
console.log(
  'top colour buckets   ' + result.topColourBuckets.map((b) => `${b.bucket}:${b.count}`).join('  '),
);

const problems = [];
if (result.width < 400 || result.height < 300) problems.push('frame is too small to show a scene');
if (result.nonDarkFraction < 0.01) problems.push('frame is essentially blank');
if (result.orangePixels < 50) problems.push('mission colour is absent: no trajectory drawn');
if (result.distinctColourBuckets < 6) problems.push('too few colours: probably a flat frame');

if (problems.length > 0) {
  console.error('\nFAILED: ' + problems.join('; '));
  process.exit(1);
}
console.log('\nPASSED: a non-blank frame containing the mission colour.');
