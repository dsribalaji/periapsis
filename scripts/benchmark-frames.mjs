/**
 * Measures the two costs only a browser can answer: frame cadence and long tasks.
 *
 * `scripts/benchmark.mjs` measures the pure work - a plan build, a porkchop grid - by calling it
 * directly, which is the right way to time a function. It cannot answer "does the app hold 60 fps"
 * because that depends on the renderer and the compositor, so this script drives the real app in
 * the same headless Chromium the e2e suite uses and reads the frame timing out of it.
 *
 * It is a measurement, not a test: it prints numbers and always exits 0, so a slow machine cannot
 * fail a build. The figures it produces are what TESTING.md and STATE.md quote.
 *
 * Every scenario is measured separately, because they differ by a factor of sixty in sample count
 * and a frame-rate claim that is true for one is not necessarily true for another.
 */

import { chromium } from '@playwright/test';
import { createServer } from 'vite';

const SCENARIOS = [
  'inner-system',
  'whole-system',
  'earth-moon',
  'leo-raise',
  'gto-transfer',
  'earth-mars-departure',
  'lunar-free-return',
];

const FRAMES = 180;

/** The scenarios that build a mission plan on switch: the ones with a craft. */
const missionsWithACraft = [
  'leo-raise',
  'gto-transfer',
  'earth-mars-departure',
  'lunar-free-return',
];

const server = await createServer({ server: { port: 5199, strictPort: true } });
await server.listen();
const url = 'http://localhost:5199/';

const browser = await chromium.launch({
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
});

/**
 * Runs the frame-timing measurement at one viewport size.
 *
 * Viewport size is a parameter because it is the experiment that separates the two possible
 * causes of a missed frame: JavaScript that takes too long, and a rasteriser that cannot fill the
 * canvas. If the frame rate rises with a smaller canvas while the long-task count stays at zero,
 * the main thread was never the bottleneck.
 */
async function measure(viewport, scenarioIds) {
  const page = await browser.newPage({ viewport });
  const rows = [];

  for (const id of scenarioIds) {
    await page.goto(url);
    // A fresh document per scenario, so one scenario's warm-up is not another's measurement.
    await page.getByLabel('Scenario').selectOption(id);
    // Let the scenario settle: the first frames after a switch include the plan build.
    await page.waitForTimeout(1500);

    const result = await page.evaluate(
      async ({ frames }) => {
        const gaps = [];
        const longTasks = [];
        let worst = 0;

        // `longtask` is the browser's own report of work that blocked the main thread for more
        // than 50 ms, which is the definition that matters for interactivity.
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            longTasks.push(entry.duration);
            if (entry.duration > worst) worst = entry.duration;
          }
        });
        try {
          observer.observe({ entryTypes: ['longtask'] });
        } catch {
          // Not supported in this browser build: report no long tasks rather than failing.
        }

        await new Promise((resolve) => {
          let previous = performance.now();
          let count = 0;
          const tick = (now) => {
            gaps.push(now - previous);
            previous = now;
            count += 1;
            if (count >= frames) {
              resolve();
              return;
            }
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        });

        observer.disconnect();
        gaps.sort((a, b) => a - b);
        return {
          p50: gaps[Math.floor(gaps.length / 2)],
          p95: gaps[Math.floor(gaps.length * 0.95)],
          longTasks: longTasks.length,
          worst,
        };
      },
      { frames: FRAMES },
    );

    rows.push({ id, ...result });
    console.log(
      `${id.padEnd(20)} ${result.p50.toFixed(2).padStart(8)} ms ${result.p95
        .toFixed(2)
        .padStart(9)} ms ${(1000 / result.p50).toFixed(0).padStart(8)}   ` +
        `${String(result.longTasks).padStart(10)}   ${result.worst.toFixed(1).padStart(8)} ms`,
    );
  }

  await page.close();
  return rows;
}

console.log('Periapsis browser frame timing');
console.log('headless chromium, software GL (swiftshader)');
console.log('');
console.log('1280x800, every bundled scenario');
console.log('scenario              frame p50   frame p95   fps est   long tasks   worst task');
await measure({ width: 1280, height: 800 }, SCENARIOS);

console.log('');
console.log('320x200, the same scenarios: a quarter of the pixels to rasterise');
console.log('scenario              frame p50   frame p95   fps est   long tasks   worst task');
await measure({ width: 320, height: 200 }, SCENARIOS);

/**
 * Time from choosing a scenario to the mission panel agreeing with it.
 *
 * This is the cost a person actually feels, and it is invisible to both other measurements: the
 * frame loop is idle during it because the tab is blocked, and `benchmark.mjs` times the plan
 * build without React's render or the scene's trajectory rebuild on top. A long task here is
 * worse than a slow frame - nothing on the page responds until it finishes.
 */
console.log('');
console.log('scenario switch: choose it, wait for the mission panel to name it');
console.log('scenario              wall clock   long tasks during switch   worst task');
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  for (const id of missionsWithACraft) {
    await page.goto(url);
    // A fresh start every time: the app remembers the last scenario, so without this the
    // "before" state of one iteration is another iteration's result.
    await page.evaluate(() => localStorage.clear());
    await page.goto(url);
    await page.waitForTimeout(500);

    const timing = await page.evaluate(async (scenarioId) => {
      const tasks = [];
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) tasks.push(entry.duration);
      });
      try {
        observer.observe({ entryTypes: ['longtask'] });
      } catch {
        // Reported as no long tasks when the browser will not provide them.
      }

      const select = document.querySelector('select[aria-label="Scenario"]');
      // Queried on every poll, not captured once: switching *to* the first mission scenario
      // mounts the panel, so a node captured while the default was loaded is null forever.
      const panelText = () =>
        document.querySelector('[data-testid="mission-planned"]')?.textContent ?? '';
      const before = panelText();
      const t0 = performance.now();

      // The native setter plus a change event is what a user's selection does, without needing
      // Playwright's actionability checks inside the measurement window.
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      setter.call(select, scenarioId);
      select.dispatchEvent(new Event('change', { bubbles: true }));

      // Wait for the panel to actually change rather than for a fixed delay: the number being
      // measured is how long that takes.
      await new Promise((resolve) => {
        const deadline = performance.now() + 5000;
        const poll = () => {
          if (panelText() !== before || performance.now() > deadline) {
            resolve();
            return;
          }
          setTimeout(poll, 8);
        };
        poll();
      });

      const elapsed = performance.now() - t0;
      await new Promise((resolve) => setTimeout(resolve, 100));
      observer.disconnect();
      return { elapsed, tasks, worst: tasks.length ? Math.max(...tasks) : 0 };
    }, id);

    console.log(
      `${id.padEnd(20)} ${timing.elapsed.toFixed(0).padStart(9)} ms ${String(
        timing.tasks.length,
      ).padStart(24)}   ${timing.worst.toFixed(1).padStart(8)} ms`,
    );
  }
  await page.close();
}

await browser.close();
await server.close();
