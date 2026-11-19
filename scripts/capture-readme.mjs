/**
 * Captures the screenshots the README shows.
 *
 * Separate from `capture-scenarios.mjs`, which exists for reviewing a change: this one is
 * curated. It writes the images that explain the project under `docs/screens/`.
 *
 * Three deliberate choices:
 *
 * - The 3D images zoom in before capturing. At the default framing Earth is a dot in a corner,
 *   which is honest but says nothing about the app; the screenshots show the view a person
 *   reaches by scrolling.
 * - The two analysis panels are captured as cropped figures on a 2x page. A porkchop plot 253 px
 *   wide inside a 1600 px screenshot is unreadable in a README, and upscaling a 1x crop only
 *   makes the labels blurry.
 * - Crops take a margin. A screenshot clipped to an element's own box cuts the last glyph of
 *   every right-aligned readout in half, because the box ends exactly where the text does.
 *
 * Usage: node scripts/capture-readme.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const outDir = 'docs/screens';
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
});

const errors = [];
const open = async (deviceScaleFactor) => {
  const page = await browser.newPage({
    viewport: { width: 1600, height: 900 },
    deviceScaleFactor,
  });
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('http://localhost:5183/');
  await page.getByLabel('Scenario').waitFor({ state: 'visible', timeout: 60_000 });
  return page;
};

const scenario = async (page, id) => {
  await page.getByLabel('Scenario').selectOption(id);
  await page.waitForTimeout(600);
};

/** Zooms the 3D view by `notches`, the same wheel gesture a person uses. */
const zoom = async (page, notches) => {
  await page.locator('.viewport').hover();
  for (let i = 0; i < notches; i++) {
    await page.mouse.wheel(0, -400);
    await page.waitForTimeout(90);
  }
};

// --- The 3D views, full window, 1x --------------------------------------
const scene = await open(1);

const shot = async (name) => {
  await scene.waitForTimeout(1200);
  await scene.screenshot({ path: `${outDir}/${name}.png` });
  console.log(`captured ${name}`);
};

// The inner system: the Sun's granulated photosphere and four planets on true-scale orbits.
await scenario(scene, 'inner-system');
await shot('inner-system');

// A mission: Earth with continents and cloud, and a 550 km orbit drawn as a visible arc.
await scenario(scene, 'leo-raise');
await zoom(scene, 3);
await shot('leo-orbit');

// The Earth-Moon pair: at true separation the pair fills the frame and Earth is a small disc,
// which is the whole point of the scenario. Zooming in would push the Moon out of shot.
await scenario(scene, 'earth-moon');
await shot('earth-moon');

// The free return: one burn, around the Moon, home, the flown path dimmed behind the craft.
await scenario(scene, 'lunar-free-return');
await zoom(scene, 1);
await shot('lunar-free-return');

// The whole system on the compressed layout, the only way all eight planets fit at once.
await scenario(scene, 'whole-system');
await shot('whole-system');

// --- The analysis panels, cropped, 2x -----------------------------------
const panels = await open(2);

/**
 * Screenshots a padded region of the page spanning `selector` down to `endSelector`.
 *
 * `padX` is needed even for a full-width panel: the sidebar's right edge is the viewport's, so a
 * box clipped to it slices the last character of every right-aligned readout.
 */
const figure = async (name, selector, { endSelector, padX = 12, padTop = 8, padBottom = 10 } = {}) => {
  // `boundingBox` is viewport-relative and so is `clip` here, because the page itself does not
  // scroll — the sidebar does. Scrolling the panel into view first is what keeps the clip on
  // screen; without it the figure sits below the fold and Playwright rejects the clip.
  await panels.locator(selector).first().scrollIntoViewIfNeeded();
  await panels.waitForTimeout(400);
  // `scrollIntoViewIfNeeded` only guarantees the element is on screen, which can leave it
  // straddling the bottom edge. The clip needs the whole figure visible, so the sidebar is
  // scrolled by the exact remainder.
  const pre = await panels.locator(selector).first().boundingBox();
  if (pre.y > 60) {
    await panels.locator('.sidebar').evaluate((el, delta) => {
      el.scrollTop += delta;
    }, pre.y - 40);
    await panels.waitForTimeout(300);
  }
  const box = await panels.locator(selector).first().boundingBox();
  const end = endSelector ? await panels.locator(endSelector).first().boundingBox() : null;
  const bottom = end ? end.y + end.height : box.y + box.height;
  const height = bottom - box.y + padTop + padBottom;
  if (box.y - padTop + height > 900) {
    throw new Error(`${name}: figure is ${Math.round(height)}px tall, taller than the viewport`);
  }
  // Horizontal extent comes from the sidebar, not the element: a narrow element would produce a
  // narrow image, and the panels all read as a column of text at sidebar width.
  const column = await panels.locator('.sidebar').boundingBox();
  const x = column.x + padX;
  const width = column.width - padX * 2;
  await panels.screenshot({
    path: `${outDir}/${name}.png`,
    clip: { x, y: box.y - padTop, width, height },
  });
  console.log(`captured ${name} (figure)`);
};

// The porkchop plot with its summary line, axis labels and the note that explains the axes.
// The form above it is left out: the figure is the subject, and the whole section is too tall to
// read comfortably at README width.
await scenario(panels, 'inner-system');
await panels.getByTestId('porkchop-toggle').click();
await panels.getByTestId('porkchop-compute').click();
await panels.waitForTimeout(2500);
await figure('porkchop', '[data-testid="porkchop-stats"]', {
  endSelector: '.porkchop-axis-note',
});

// The ground track figure and its lat/lon readouts, stopping before the long caveats.
await scenario(panels, 'leo-raise');
await figure('ground-track', '[data-testid="ground-track"]', {
  endSelector: '[data-testid="ground-track"] .readout',
});

await browser.close();

if (errors.length) {
  console.log(`\n${errors.length} console error(s):`);
  for (const e of errors) console.log('  ' + e);
  process.exitCode = 1;
} else {
  console.log('\nno console errors');
}
