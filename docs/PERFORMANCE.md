# Performance

Measured, not estimated. Every number on this page comes from one of two scripts in `scripts/`,
both of which run the shipped TypeScript rather than a copy of it:

| Script                 | Answers                                                     | Command                |
| ---------------------- | ----------------------------------------------------------- | ---------------------- |
| `benchmark.mjs`        | how long a piece of pure work takes                         | `npm run bench`        |
| `benchmark-frames.mjs` | whether the app holds a frame rate, and what blocks the tab | `npm run bench:frames` |

Neither is a test. They print numbers and always exit 0, because a slow machine must not fail a
build - the point is to have a figure to quote, not a threshold to trip. `benchmark.mjs` loads the
sources through Vite's `runnerImport`, so it measures the modules the app imports, with the same
TypeScript and the same config; `benchmark-frames.mjs` drives the real app in the same headless
Chromium the e2e suite uses, with the same software-GL flags.

## The machine

All figures below were measured on:

- **CPU** Intel Core i5-10310U @ 1.70 GHz, 8 logical cores, Windows 11 / x64
- **Node** v24.22.0
- **Browser** headless Chromium 141 via Playwright 1.65.1, software GL (swiftshader)

This is a throttled ultra-low-power laptop part, so it is a pessimistic baseline: a desktop CPU is
several times faster on the same work, and a machine with a real GPU is not rasteriser-bound at
all. The figures are useful because they are a floor, and because the _ratios_ between them hold
regardless of the machine.

**Read the ranges, not the point values.** This CPU varies by 2x run to run under thermal
throttling (measured: `leo-raise` plan build ranged 8.5-50 ms across five runs). Every table gives
the best and worst observed value across repeated runs so the noise is visible rather than hidden
behind a single median that happens to look precise.

## Plan builds

`buildMissionPlan` is the work behind a scenario switch and behind "Plan departure": propagate the
trajectory, convert it to the body's local frame, compute the orbit-radius series, and build the
ground track. It is the most expensive thing the app does on a user action.

| Scenario               | Samples | Build, best | Build, worst |
| ---------------------- | ------- | ----------- | ------------ |
| `earth-mars-departure` | 92      | 4.4 ms      | 13.5 ms      |
| `leo-raise`            | 197     | 8.5 ms      | 50 ms        |
| `gto-transfer`         | 1,755   | 85 ms       | 208 ms       |
| `lunar-free-return`    | 4,001   | 401 ms      | 1,044 ms     |

The cost is essentially linear in sample count, and sample count is set by
`defaultSamples(horizonSeconds)` capped at `MAX_TRAJECTORY_POINTS = 4000`. The free-return
scenario hits the cap because it spans nine days and needs the density to show the lunar encounter
at all: at a coarser sampling the flyby is a single vertex and the path cuts the corner through
where the Moon was.

**This is the app's one real performance limitation, and it is documented rather than fixed.** A
scenario switch to the lunar free return blocks the main thread for about a second on this
machine. It is not a bug in the sense of being avoidable without a design change:

- the work is a genuine 4,001-sample N-body propagation, not overhead;
- it happens on a deliberate user action (choosing a scenario), not during flight;
- the app is responsive again as soon as it finishes, and the result is cached for the scenario's
  lifetime - the clock advancing costs 5-9 us per frame, not a re-propagation.

The alternatives all trade correctness or simplicity for latency: propagate at a coarser sampling
and lose the flyby, propagate lazily in a worker (which would put the physics core behind a message
boundary and make every scenario async), or cache the built plan in the scenario file (which would
make the file a build artefact rather than an input). None of them is worth it for a one-second
pause on the most demanding bundled scenario. It is listed as a limitation in STATE.md.

## The frame loop

`Simulation.advance` plus `positions()` is what runs every frame. Measured on the
longest-horizon scenario at each warp step, against a 16.7 ms (60 Hz) frame:

| Warp   | advance + positions | Share of a 60 Hz frame |
| ------ | ------------------- | ---------------------- |
| 1x     | 90-150 us           | 0.5-0.9%               |
| 1,000x | 50-75 us            | 0.3-0.4%               |
| 100kx  | 49-65 us            | 0.3-0.4%               |
| 10Mx   | 50-66 us            | 0.3-0.4%               |

The simulation is not the bottleneck at any warp step, and the cost does not grow with warp: the
clock takes bigger steps, not more of them per frame. `missionProgress` adds 1-14 us per frame
depending on the plan, and the per-frame UI update is throttled to 10 Hz by design.

## Frame rate in the browser

This is the measurement that needed a real browser, and the result is a clean answer.

| Scenario               | 1280x800 p50 | 320x200 p50  | Long tasks at 1280x800 |
| ---------------------- | ------------ | ------------ | ---------------------- |
| `inner-system`         | 16.7 ms (60) | 16.7 ms (60) | 0-1                    |
| `whole-system`         | 33.3 ms (30) | 16.7 ms (60) | 0-1                    |
| `earth-moon`           | 16.7-33.3 ms | 16.7 ms (60) | 0-17                   |
| `leo-raise`            | 33.3-49.9 ms | 16.7 ms (60) | 0                      |
| `gto-transfer`         | 33.3 ms (30) | 16.7 ms (60) | 0                      |
| `earth-mars-departure` | 33.3 ms (30) | 16.7 ms (60) | 0-1                    |
| `lunar-free-return`    | 33.3 ms (30) | 16.7 ms (60) | 0-1                    |

**At 320x200 every scenario holds 60 fps. At 1280x800 most hold 30.** That is the experiment, not
an accident: a quarter of the pixels to rasterise and the frame time halves exactly, while the
long-task count stays at zero. The JavaScript is not the bottleneck - the software rasteriser is.
The per-frame JavaScript costs under 1% of a frame (above), so there is nothing to optimise in the
app's own code; the frame rate is what software GL can push for this many lit, textured objects.

On a machine with a real GPU this does not apply. The software path is the honest worst case, and
it is the one the test environment can measure. A 30 fps floor on a headless CPU rasteriser is a
reasonable place to be, and the number is recorded so it is a known property rather than a
surprise.

## Scenario switch, as felt

Time from dispatching the change event to the mission panel showing the new plan - the number a
person experiences, including React's render and the scene's trajectory rebuild:

| Scenario               | Wall clock     | Long tasks | Worst task     |
| ---------------------- | -------------- | ---------- | -------------- |
| `earth-mars-departure` | 37-52 ms       | 1-3        | 65-86 ms       |
| `leo-raise`            | 54-82 ms       | 2-3        | 78-123 ms      |
| `gto-transfer`         | 194-297 ms     | 1-3        | 194-297 ms     |
| `lunar-free-return`    | 1,015-1,184 ms | 2-3        | 1,015-1,184 ms |

These are longer than the pure build times because they include the React commit and the
`BufferGeometry` rebuild for the 3D path. The free-return case is the same one-second pause
described above; the others are all under a third of a second, which is within the range where a
deliberate action feels immediate.

## Porkchop

`computePorkchop` solves Lambert's problem once per grid cell. This is the app's most expensive
deliberate action, and the only one with a user-controlled size:

| Grid    | Best   | Worst  | Cells  |
| ------- | ------ | ------ | ------ |
| 100x100 | 94 ms  | 160 ms | 10,000 |
| 200x200 | 362 ms | 566 ms | 40,000 |

The default is 100x100 and the field accepts up to 200x200. Even the largest grid stays under
0.6 s on this machine, so the plot appears without a progress indicator - which is why there
isn't one. A slower machine would make the 200x200 case noticeably laggy, and that is the
threshold at which a "computing" state would be worth adding.

## Ground track

`groundTrackImage` plus `summariseGroundTrack` run once per Earth mission plan, not per frame: the
map is a `putImageData` of a pre-rendered buffer, and only the marker moves as the clock advances.

| Samples | Best   | Worst  |
| ------- | ------ | ------ |
| 197     | 1.2 ms | 1.7 ms |
| 1,755   | 1.7 ms | 2.7 ms |

Under 3 ms in every case, so it is not a factor in any user-visible delay.

## What is not measured

Honest scope, so the gaps are visible:

- **Memory.** No heap measurement. The app holds one plan and one porkchop grid at a time; the
  largest plan is 4,001 points, which is a few hundred kilobytes of `Float32Array`.
- **First load.** The bundle is 860.96 kB (235.42 kB gzip), which is dominated by Three.js. No
  time-to-interactive measurement has been taken, and no code splitting is done.
- **GPU-backed frame rate.** Only software GL was measured, because that is what the headless test
  environment provides. A real GPU is expected to be far better, but that is an expectation, not a
  measurement.
- **Mobile and low-end devices.** Nothing was measured on a phone or a tablet.
- **Warm-up and GC pauses.** The per-frame figures exclude the first frames after a switch, which
  include the plan build. A garbage collection during flight would show as one long frame; none
  appeared in the 180-frame samples, but 180 frames is three seconds and not a soak test.
