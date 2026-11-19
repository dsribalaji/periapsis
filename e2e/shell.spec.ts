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
    // Scoped to the body list on purpose: the porkchop form also has <option> elements named
    // after planets, and a bare text match would find those (hidden) first.
    const list = page.locator('.body-list');
    for (const name of ['Sun', 'Mercury', 'Venus', 'Earth', 'Moon', 'Mars', 'Neptune']) {
      await expect(list.getByText(name, { exact: true }).first()).toBeVisible();
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

test.describe('porkchop plot', () => {
  /** Reads the plot canvas back. It is a 2D canvas, so `getImageData` works directly. */
  const readPlot = async (
    page: import('@playwright/test').Page,
  ): Promise<{ opaque: number; colours: number; total: number }> =>
    page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="porkchop-canvas"]');
      if (!canvas) throw new Error('no porkchop canvas');
      const context = canvas.getContext('2d');
      if (!context) throw new Error('no 2d context');
      const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
      let opaque = 0;
      const seen = new Set<string>();
      for (let i = 0; i < data.length; i += 4) {
        if ((data[i + 3] ?? 0) === 0) continue;
        opaque++;
        seen.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
      }
      return { opaque, colours: seen.size, total: data.length / 4 };
    });

  /** Expands the panel and computes the default plot. The panel starts collapsed. */
  const openAndCompute = async (page: import('@playwright/test').Page): Promise<void> => {
    const toggle = page.getByTestId('porkchop-toggle');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await page.getByTestId('porkchop-compute').click();
  };

  /**
   * Hovers a fractional point of the plot and returns the readout's first field.
   *
   * The plot sits low in a scrolling sidebar — at Playwright's default 720 px viewport its
   * lower half is below the fold, and `mouse.move` to a point outside the window silently
   * does nothing. Scrolling it into view first is what makes the hover an actual hover rather
   * than a test of the pointer's ability to leave the page.
   */
  const hoverPlot = async (
    page: import('@playwright/test').Page,
    fx: number,
    fy: number,
  ): Promise<void> => {
    const canvas = page.getByTestId('porkchop-canvas');
    await canvas.scrollIntoViewIfNeeded();
    const box = await canvas.boundingBox();
    if (!box) throw new Error('porkchop canvas has no box');
    await page.mouse.move(box.x + box.width * fx, box.y + box.height * fy);
  };

  test('starts collapsed so it cannot crowd out the rest of the sidebar', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('porkchop-toggle')).toHaveAttribute('aria-expanded', 'false');
    // The body list is the thing the panel was crowding off the bottom of the sidebar.
    await expect(page.locator('.body-list').getByText('Neptune', { exact: true })).toBeVisible();
    await expect(page.getByTestId('porkchop-compute')).toBeHidden();
  });

  test('computes a plot and paints it', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('porkchop')).toBeVisible();
    // Nothing is drawn until asked: 10,000 Lambert solves are not a page-load cost.
    await expect(page.getByTestId('porkchop-canvas')).toHaveCount(0);

    await openAndCompute(page);
    await expect(page.getByTestId('porkchop-canvas')).toBeVisible({ timeout: 20_000 });

    // Every cell converges for the default Earth-Mars window, and the ramp must produce a
    // gradient rather than one flat colour: a flat plot would mean the colour range collapsed.
    const plot = await readPlot(page);
    expect(plot.opaque).toBe(plot.total);
    expect(plot.colours).toBeGreaterThan(20);
  });

  test('reports the cheapest window in words', async ({ page }) => {
    await page.goto('/');
    await openAndCompute(page);
    const summary = page.getByTestId('porkchop-summary');
    await expect(summary).toContainText('Cheapest window', { timeout: 20_000 });
    await expect(summary).toContainText('km/s');
    await expect(summary).toContainText('C3');

    // The default window starts at the epoch, so the cheapest cell must not be in the past.
    // Measured: 2028-11-21 departure (the 2028 Mars window), 300 d, 6.00 km/s. Pinning the
    // year would only re-assert the epoch; the invariant worth testing is the ordering, since
    // a past cell is exactly what cannot become a manoeuvre node.
    const text = (await summary.textContent()) ?? '';
    const departure = /depart (\d{4}-\d{2}-\d{2})/.exec(text)?.[1];
    expect(departure).toBeDefined();
    const epochText = (await page.getByTestId('scenario-epoch').textContent()) ?? '';
    const epoch = /(\d{4}-\d{2}-\d{2})/.exec(epochText)?.[1];
    expect(epoch).toBeDefined();
    // ISO civil dates compare lexicographically in the same order as chronologically.
    expect(departure! >= epoch!).toBe(true);
    // A summary of a converged grid must never also claim there is no arc.
    await expect(summary).not.toContainText('No single-revolution arc');
  });

  test('hovering the plot reports the cell under the pointer', async ({ page }) => {
    await page.goto('/');
    await openAndCompute(page);
    await expect(page.getByTestId('porkchop-canvas')).toBeVisible({ timeout: 20_000 });

    const readout = page.getByTestId('porkchop-readout');
    await expect(readout.locator('dd').first()).toHaveText('--');

    // Two points well apart must report different cells: a readout that ignored the pointer
    // would still pass a single-hover test.
    await hoverPlot(page, 0.25, 0.3);
    const firstCell = readout.locator('dd').first();
    await expect(firstCell).not.toHaveText('--');
    const first = (await firstCell.textContent()) ?? '';

    await hoverPlot(page, 0.75, 0.7);
    await expect(firstCell).not.toHaveText(first);

    // The marker is placed as a percentage, so a non-empty left proves it was positioned.
    const markerLeft = await page
      .locator('.porkchop-marker')
      .evaluate((el) => (el as HTMLElement).style.left);
    expect(markerLeft).not.toBe('');
  });

  test('hovering survives the pointer resting still, as the layout must not move', async ({
    page,
  }) => {
    // The readout is a fixed-height block precisely so that filling it in cannot reflow the
    // sidebar and slide the plot out from under the pointer. This is the regression test for
    // that: hover once, wait, and the same cell must still be reported.
    await page.goto('/');
    await openAndCompute(page);
    await expect(page.getByTestId('porkchop-canvas')).toBeVisible({ timeout: 20_000 });

    await hoverPlot(page, 0.4, 0.4);
    const first = page.getByTestId('porkchop-readout').locator('dd').first();
    await expect(first).not.toHaveText('--');
    const parked = (await first.textContent()) ?? '';
    await page.waitForTimeout(700);
    await expect(first).toHaveText(parked);
  });

  test('rejects a mismatched body pair instead of computing', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('porkchop-toggle').click();
    // Earth to Earth: no transfer exists, so the button must be off.
    await page.getByLabel('Arrival body').selectOption('earth');
    await expect(page.getByTestId('porkchop-issues')).toContainText('must be different');
    await expect(page.getByTestId('porkchop-compute')).toBeDisabled();
  });

  test('reports an unparseable date window without crashing', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('porkchop-toggle').click();
    await page.getByLabel('Departure window start').fill('not a date');
    await expect(page.getByTestId('porkchop-issues')).toContainText('not a valid date');
    await expect(page.getByTestId('porkchop-compute')).toBeDisabled();
    // The rest of the app still works.
    await expect(page.getByRole('heading', { name: 'Periapsis' })).toBeVisible();
  });

  test('leaves holes transparent where no transfer exists', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('porkchop-toggle').click();
    // Twenty minutes to Mars: no single-revolution arc exists anywhere in this range.
    await page.getByLabel('Shortest time of flight, days').fill('0.01');
    await page.getByLabel('Longest time of flight, days').fill('0.014');
    await page.getByTestId('porkchop-compute').click();
    await expect(page.getByTestId('porkchop-canvas')).toBeVisible({ timeout: 20_000 });

    // Every cell must be a hole, and the panel must say so rather than printing a plausible
    // cost. Measured: 0 opaque pixels.
    const plot = await readPlot(page);
    expect(plot.opaque).toBe(0);
    await expect(page.getByTestId('porkchop-summary')).toContainText('No single-revolution arc');
    // And hovering a hole reports dashes, not NaN.
    await hoverPlot(page, 0.5, 0.5);
    await expect(page.getByTestId('porkchop-readout').locator('dd').first()).toHaveText('--');
  });

  test('stays usable across a scenario switch', async ({ page }) => {
    await page.goto('/');
    await openAndCompute(page);
    await expect(page.getByTestId('porkchop-canvas')).toBeVisible({ timeout: 20_000 });

    // earth-moon is a 2027 epoch, so the seeded window moves; the panel must still work.
    await page.getByLabel('Scenario').selectOption('earth-moon');
    await page.getByTestId('porkchop-compute').click();
    await expect(page.getByTestId('porkchop-summary')).toContainText('Cheapest window', {
      timeout: 20_000,
    });
    // Measured: the 2027-onward window's best Earth-Mars departure is 2028-11-27 at 6.01 km/s,
    // i.e. a later synodic window was found rather than the 2026 one that is no longer in range.
    await expect(page.getByTestId('porkchop-summary')).toContainText(/depart 202[7-9]-/);
  });
});

test.describe('transfer to maneuver node', () => {
  /**
   * Clicks a fractional point of the plot, which *selects* the cell.
   *
   * A click rather than a hover is what the workflow needs: the departure button sits below the
   * plot, and moving the pointer to it raises `pointerleave` on the canvas. A hover-only design
   * would therefore disable the button at the instant the user reached for it.
   */
  const chooseCell = async (
    page: import('@playwright/test').Page,
    fx: number,
    fy: number,
  ): Promise<void> => {
    const canvas = page.getByTestId('porkchop-canvas');
    await canvas.scrollIntoViewIfNeeded();
    const box = await canvas.boundingBox();
    if (!box) throw new Error('porkchop canvas has no box');
    await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
  };

  const openComputeAndChoose = async (page: import('@playwright/test').Page): Promise<void> => {
    await page.getByTestId('porkchop-toggle').click();
    await page.getByTestId('porkchop-compute').click();
    await expect(page.getByTestId('porkchop-canvas')).toBeVisible({ timeout: 20_000 });
    await chooseCell(page, 0.45, 0.45);
  };

  test('the departure button is disabled until a cell is chosen', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Scenario').selectOption('leo-raise');
    await page.getByTestId('porkchop-toggle').click();
    await page.getByTestId('porkchop-compute').click();
    await expect(page.getByTestId('porkchop-canvas')).toBeVisible({ timeout: 20_000 });

    const plan = page.getByTestId('porkchop-plan-departure');
    await expect(plan).toBeDisabled();
    await chooseCell(page, 0.5, 0.5);
    await expect(plan).toBeEnabled();

    // And the selection survives the pointer leaving the plot, which is what makes the button
    // reachable at all.
    await page.mouse.move(5, 5);
    await page.waitForTimeout(100);
    await expect(plan).toBeEnabled();
  });

  test('a chosen cell becomes a node on the craft, with its cost and instant', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Scenario').selectOption('leo-raise');
    await openComputeAndChoose(page);

    // One node from scenario data, one from the cell.
    const nodes = page.getByTestId('mission-nodes').locator('.node-row');
    await expect(nodes).toHaveCount(1);

    await page.getByTestId('porkchop-plan-departure').click();

    await expect(nodes).toHaveCount(2);
    const transfer = nodes.filter({ hasText: 'Depart' });
    await expect(transfer).toHaveCount(1);
    // The burn is thousands of m/s, not the cell's 3-6 km/s of excess speed, because it comes
    // from the departure solve rather than the Lambert cost.
    await expect(page.getByTestId('mission-planned')).toContainText('m/s');

    // The note says what happened, in words, including the timing slide.
    const note = page.getByTestId('porkchop-departure-note');
    await expect(note).toContainText('Node depart-');
    await expect(note).toContainText('km/s');
    await expect(note).toContainText(/after the requested date|at the requested instant/);
    await expect(page.getByTestId('porkchop-departure-issue')).toHaveCount(0);
  });

  test('the plan is extended to cover a departure months out, and says so', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Scenario').selectOption('leo-raise');
    await openComputeAndChoose(page);

    // The 550 km park laps every 96 minutes; the default window's cheapest cell is ~740 days
    // out, far beyond the scenario's 11,600 s horizon.
    await page.getByTestId('porkchop-plan-departure').click();
    await expect(page.getByTestId('porkchop-departure-note')).toContainText('days further');

    // And the mission panel states that the drawn coast is now too coarse to read as an orbit.
    await expect(page.getByTestId('mission-aliased')).toBeVisible();
  });

  test('re-planning the same cell replaces its node instead of stacking a second', async ({
    page,
  }) => {
    await page.goto('/');
    await page.getByLabel('Scenario').selectOption('leo-raise');
    await openComputeAndChoose(page);

    const nodes = page.getByTestId('mission-nodes').locator('.node-row');
    await page.getByTestId('porkchop-plan-departure').click();
    await expect(nodes).toHaveCount(2);
    const planned = await page.getByTestId('mission-planned').textContent();

    await page.getByTestId('porkchop-plan-departure').click();
    await expect(nodes).toHaveCount(2);
    await expect(page.getByTestId('mission-planned')).toHaveText(planned ?? '');
  });

  test('refuses with a reason when the scenario has no spacecraft', async ({ page }) => {
    await page.goto('/');
    // inner-system has no craft, so there is nothing to burn from.
    await openComputeAndChoose(page);
    await expect(page.getByTestId('porkchop-plan-departure')).toBeDisabled();
    await expect(page.getByTestId('mission')).toHaveCount(0);
  });

  test('a filled grid everywhere in the window produces a node from any cell', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Scenario').selectOption('leo-raise');
    await page.getByTestId('porkchop-toggle').click();
    await page.getByTestId('porkchop-compute').click();
    await expect(page.getByTestId('porkchop-canvas')).toBeVisible({ timeout: 20_000 });

    // Three distant cells must each produce a node: the workflow is not a single lucky cell.
    const nodes = page.getByTestId('mission-nodes').locator('.node-row');
    for (const [fx, fy, expected] of [
      [0.15, 0.85, 2],
      [0.5, 0.5, 3],
      [0.85, 0.15, 4],
    ] as const) {
      await chooseCell(page, fx, fy);
      await page.getByTestId('porkchop-plan-departure').click();
      await expect(nodes).toHaveCount(expected);
    }
  });
});
