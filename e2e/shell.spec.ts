import { expect, test } from '@playwright/test';

/**
 * Smoke tests for the application shell.
 *
 * These assert things a unit test cannot: that the page boots, React mounts, the WebGL
 * canvas is created, and the time controls actually move simulated time. A passing unit
 * suite says nothing about whether the app runs.
 */

test.describe('application shell', () => {
  test('boots and renders the shell', async ({ page }) => {
    await page.goto('/');

    await expect(page).toHaveTitle(/Periapsis/);
    await expect(page.getByRole('heading', { name: 'Periapsis' })).toBeVisible();

    // The time bar and body list are the two things a user needs on load.
    await expect(page.getByText('offline · no data leaves this machine')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible();
  });

  test('creates a WebGL canvas in the viewport', async ({ page }) => {
    await page.goto('/');
    const canvas = page.locator('.viewport canvas');
    await expect(canvas).toBeVisible();

    const size = await canvas.boundingBox();
    expect(size?.width ?? 0).toBeGreaterThan(100);
    expect(size?.height ?? 0).toBeGreaterThan(100);
  });

  test('lists every body with a distance readout', async ({ page }) => {
    await page.goto('/');
    for (const name of ['Sun', 'Mercury', 'Venus', 'Earth', 'Moon', 'Mars', 'Neptune']) {
      await expect(page.getByText(name, { exact: true }).first()).toBeVisible();
    }
  });

  test('advances the simulation clock while running', async ({ page }) => {
    await page.goto('/');
    const time = page.locator('.sim-time');
    const first = await time.textContent();
    // At warp 1 the readout changes every second or so; allow a generous window.
    await expect(time).not.toHaveText(first ?? '', { timeout: 8000 });
  });

  test('pausing stops the clock', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Pause' }).click();
    await expect(page.getByText('paused')).toBeVisible();

    const time = page.locator('.sim-time');
    const frozen = await time.textContent();
    await page.waitForTimeout(1200);
    await expect(time).toHaveText(frozen ?? '');
  });

  test('selecting a body updates the inspector', async ({ page }) => {
    await page.goto('/');
    await page.locator('.body-row', { hasText: 'Mars' }).click();
    // "Body" row in the Selected panel must now read Mars.
    await expect(page.locator('.readout dd').first()).toHaveText('Mars');
  });

  test('runs with no console errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    page.on('pageerror', (err) => errors.push(err.message));

    await page.goto('/');
    await page.waitForTimeout(1500);

    expect(errors).toEqual([]);
  });

  test('dragging orbits the camera and does not change the selection', async ({ page }) => {
    await page.goto('/');
    const canvas = page.locator('.viewport canvas');
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    if (!box) return;

    // Select Mars first, so a stray click during the drag would be visible.
    await page.locator('.body-row', { hasText: 'Mars' }).click();
    await expect(page.locator('.readout dd').first()).toHaveText('Mars');

    const before = await canvas.screenshot();
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 180, cy + 40, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(400);

    // The view must have changed...
    const after = await canvas.screenshot();
    expect(Buffer.compare(before, after)).not.toBe(0);
    // ...but the selection must not have, because a drag is not a click.
    await expect(page.locator('.readout dd').first()).toHaveText('Mars');
  });

  test('the mouse wheel zooms the view', async ({ page }) => {
    await page.goto('/');
    const canvas = page.locator('.viewport canvas');
    const box = await canvas.boundingBox();
    if (!box) return;

    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const before = await canvas.screenshot();
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(400);
    const after = await canvas.screenshot();
    expect(Buffer.compare(before, after)).not.toBe(0);
  });

  test('switching to whole-system scale brings the outer planets into view', async ({ page }) => {
    await page.goto('/');
    const canvas = page.locator('.viewport canvas');
    const note = page.getByTestId('offscreen-note');

    // True scale fits only the inner system at the reset camera distance, and the app says
    // so rather than silently hiding Neptune.
    await expect(note).toContainText('Neptune');
    await expect(note).not.toContainText('Every body');

    const countContent = async (): Promise<number> => {
      const png = await canvas.screenshot();
      return page.evaluate(async (base64) => {
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
          // Clear colour is 0x05060a; anything clearly brighter is drawn content.
          if ((data[i] ?? 0) > 24 || (data[i + 1] ?? 0) > 24 || (data[i + 2] ?? 0) > 32) count++;
        }
        return count;
      }, png.toString('base64'));
    };

    const linear = await countContent();

    await page.getByRole('button', { name: 'Whole system', exact: true }).click();

    // The compressed layout maps every body inside a ~210 unit disc, which the widest camera
    // distance frames completely.
    await expect(note).toHaveText('Every body is on screen.');

    const compressed = await countContent();
    expect(compressed).toBeGreaterThan(linear);
  });
});
