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
    await expect(page.getByText('no data leaves this machine')).toBeVisible();
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

  test('switching scenarios loads the bundled framing and epoch', async ({ page }) => {
    await page.goto('/');

    const picker = page.getByLabel('Scenario');
    await expect(picker).toHaveValue('inner-system');

    // The default scenario starts at warp 1e4, so the clock is running on load.
    await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible();

    await picker.selectOption('whole-system');
    await expect(page.getByTestId('scenario-epoch')).toContainText('2026-11-18 12:00:00 UTC');
    await expect(page.getByRole('button', { name: 'Whole system', exact: true })).toHaveClass(
      /active/,
    );
    // The compressed layout fits every body; that is the point of the scenario.
    await expect(page.getByTestId('offscreen-note')).toHaveText('Every body is on screen.');

    await picker.selectOption('earth-moon');
    // Switching restarts at the scenario's own epoch. The date alone is asserted: the clock
    // is running again immediately, so any assertion on the time of day would race.
    await expect(page.getByTestId('scenario-epoch')).toContainText('2027-04-07 12:00:00 UTC');
    await expect(page.locator('.sim-time')).toContainText('2027-04-07');
  });

  test('switching scenarios does not leak the previous selection', async ({ page }) => {
    await page.goto('/');
    await page.locator('.body-row', { hasText: 'Mars' }).click();
    await expect(page.locator('.readout dd').first()).toHaveText('Mars');

    await page.getByLabel('Scenario').selectOption('earth-moon');
    // The scenario declares its focus, and that focus must win over whatever was selected.
    await expect(page.locator('.readout dd').first()).toHaveText('Moon');
  });

  test('the whole-system scale brings the outer planets into view', async ({ page }) => {
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

test.describe('mission and maneuvers', () => {
  test('a mission scenario shows its plan and delta-v budget', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Scenario').selectOption('leo-raise');

    const panel = page.getByTestId('mission');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('Constellation A');
    // 62 m/s planned out of a 120 m/s budget.
    await expect(page.getByTestId('mission-planned')).toHaveText('62.0 m/s');
    await expect(page.getByTestId('mission-remaining')).toHaveText('58.0 m/s');
    await expect(page.getByTestId('mission-spent')).toHaveText('0.0 m/s');
    await expect(page.getByTestId('mission-over-budget')).toHaveCount(0);
  });

  test('the mission panel disappears for a scenario without a craft', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('mission')).toHaveCount(0);
    await page.getByLabel('Scenario').selectOption('leo-raise');
    await expect(page.getByTestId('mission')).toBeVisible();
    await page.getByLabel('Scenario').selectOption('earth-moon');
    await expect(page.getByTestId('mission')).toHaveCount(0);
  });

  test('the orbit radius stays near the planned altitude while running', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Scenario').selectOption('leo-raise');
    const altitude = page.getByTestId('mission-altitude');

    // The scenario opens paused at the epoch: radius is exactly the initial orbit.
    await expect(altitude).toHaveText('550.0 km');

    // Fly at warp 100 for a while and check the craft is still on a sane orbit.
    await page.getByRole('button', { name: '100', exact: true }).click();
    await expect(altitude).not.toHaveText('550.0 km', { timeout: 15000 });

    const text = (await altitude.textContent()) ?? '';
    const km = Number.parseFloat(text.replace(' km', ''));
    expect(km).toBeGreaterThan(-1000);
    expect(km).toBeLessThan(1000);
  });

  test('the maneuver node is drawn as applied once the clock passes it', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Scenario').selectOption('leo-raise');

    const node = page.getByTestId('mission-nodes').locator('.node-row').first();
    await expect(node).toContainText('Raise 62 m/s');
    await expect(node).not.toHaveClass(/applied/);

    // The node is at T+00:48:20. At warp 10k that is a few real seconds.
    await page.getByRole('button', { name: '10k', exact: true }).click();
    await expect(node).toHaveClass(/applied/, { timeout: 20000 });
    await expect(page.getByTestId('mission-spent')).toHaveText('62.0 m/s');
  });

  test('the trajectory is actually drawn on the canvas', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Scenario').selectOption('earth-moon');
    await expect(page.getByTestId('mission')).toHaveCount(0);

    const canvas = page.locator('.viewport canvas');

    /**
     * Pixels matching the mission colour (#ff9f1c).
     *
     * Counted by colour rather than by total brightness on purpose: switching scenarios also
     * moves the camera and the epoch, so a total-brightness difference could come from the
     * body arrangement. Nothing but the trajectory is drawn in orange.
     */
    const countMissionColour = async (): Promise<number> => {
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
          const r = data[i] ?? 0;
          const g = data[i + 1] ?? 0;
          const b = data[i + 2] ?? 0;
          // Orange: strong red, middling green, little blue. The dim flown half is drawn at
          // 42% brightness, so the threshold is generous on the low side.
          if (r > 90 && g > 40 && g < 190 && b < 80 && r > g + 40) count++;
        }
        return count;
      }, png.toString('base64'));
    };

    const before = await countMissionColour();

    await page.getByLabel('Scenario').selectOption('leo-raise');
    // Wait for the frame loop to publish a readout, so the path is definitely in the scene.
    await expect(page.getByTestId('mission-altitude')).toHaveText('550.0 km');

    const after = await countMissionColour();
    // Measured: 0 before and over a thousand after. The line is a long arc across a close-up
    // view, so hundreds of pixels is the floor and a few stray antialiased pixels cannot pass.
    expect(before).toBeLessThan(50);
    expect(after).toBeGreaterThan(400);
  });
});
