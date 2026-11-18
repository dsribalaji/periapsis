# STATE

Snapshot of where the build actually stands. Updated at the end of every iteration.
"Passing" here means the command was run and its output read, not that it seemed fine.

## Environment

| Item     | Value                                                  |
| -------- | ------------------------------------------------------ |
| Node     | v24.22.0                                               |
| npm      | 11.19.1                                                |
| git      | 2.55.0                                                 |
| Platform | Windows / PowerShell                                   |
| Repo     | `D:\balaji\projects\Periapsis` (local only, no remote) |

## Verified status

Last full run: `npm run verify` and `npx playwright test`.

| Check                       | Result                                                   |
| --------------------------- | -------------------------------------------------------- |
| Typecheck (`tsc --noEmit`)  | PASS                                                     |
| Lint (`eslint .`)           | PASS, 0 problems                                         |
| Unit tests (`vitest run`)   | PASS, 302 tests / 15 files                               |
| Build (`vite build`)        | PASS, 796 kB JS (214 kB gzip)                            |
| `npm run verify`            | PASS (typecheck + lint + tests + build)                  |
| E2E (`npx playwright test`) | PASS, 12 tests against the real app in headless Chromium |

All six were run, not inferred. The e2e suite starts its own dev server and drives the real
page: it asserts React mounts, a WebGL canvas is created and sized, the clock advances while
running, pausing freezes it, selecting a body updates the inspector, dragging orbits without
reselecting, the wheel zooms, the radial-mode toggle changes what is on screen, a scenario
switch replaces the epoch and focus, and the console stays free of errors.

Note on the browser: the paired interactive browser extension was not connected, so
verification ran through Playwright's Chromium with software GL
(`--use-gl=swiftshader`). That is a real browser executing the real bundle, but it is not
the same as a check on a GPU-backed desktop browser.

## Test inventory

| File                        | Tests | Covers                                                        |
| --------------------------- | ----- | ------------------------------------------------------------- |
| `tests/vec3.test.ts`        | 18    | vector algebra, rotations, frame conversions                  |
| `tests/time.test.ts`        | 18    | JD/calendar, leap seconds, GMST, ERA                          |
| `tests/kepler.test.ts`      | 13    | elliptic + hyperbolic solvers, high-eccentricity cases        |
| `tests/elements.test.ts`    | 13    | state <-> elements round trips, apsides                       |
| `tests/twoBody.test.ts`     | 15    | closed-form propagation, energy/angular-momentum conservation |
| `tests/integrators.test.ts` | 16    | RK4 + Dormand-Prince RK45, convergence order, drift           |
| `tests/ephemeris.test.ts`   | 28    | body positions, velocities, mean motion, SOI                  |
| `tests/nbody.test.ts`       | 21    | acceleration, dominant body, patched-conic re-parenting       |
| `tests/lambert.test.ts`     | 35    | Hohmann/bi-elliptic/plane change + Lambert solver             |
| `tests/clock.test.ts`       | 21    | warp, step budget, frame-rate independence, formatting        |
| `tests/simulation.test.ts`  | 15    | epoch/JD handling, body positions, determinism, reset         |
| `tests/scale.test.ts`       | 17    | scene scale, radius compression, radial mapping               |
| `tests/scenario.test.ts`    | 24    | scenario schema, validation errors, bundled catalogue         |
| `tests/maneuver.test.ts`    | 23    | node frames, magnitudes, ordering, Δv totals                  |
| `tests/trajectory.test.ts`  | 25    | propagation modes, burns in-frame, Δv accounting, Hohmann arc |
| `e2e/shell.spec.ts`         | 12    | boot, WebGL, clock, picking, drag, zoom, scale, scenarios     |

## Module inventory

`src/core` — pure TypeScript, zero runtime deps, boundary enforced by ESLint:

| Module                            | Status                                  |
| --------------------------------- | --------------------------------------- |
| `math/vec3.ts`, `math/numeric.ts` | complete, tested                        |
| `constants.ts`                    | complete (GM, AU, radii, day constants) |
| `time/time.ts`                    | complete, tested                        |
| `orbit/kepler.ts`                 | complete, tested                        |
| `orbit/elements.ts`               | complete, tested                        |
| `orbit/twoBody.ts`                | complete, tested                        |
| `integrate/integrators.ts`        | complete, tested                        |
| `ephemeris/solarSystem.ts`        | complete (JPL Table 1 verbatim)         |
| `ephemeris/ephemeris.ts`          | complete, tested                        |
| `ephemeris/nbody.ts`              | complete, tested                        |
| `transfer/transfers.ts`           | complete, tested                        |
| `transfer/lambert.ts`             | complete, tested (single revolution)    |

`src/sim` — pure, no DOM, no clock, no RNG:

| Module          | Status                                                    |
| --------------- | --------------------------------------------------------- |
| `clock.ts`      | complete, tested (warp, budget, step coarsening)          |
| `simulation.ts` | complete, tested (epoch, JD, positions, snapshots)        |
| `maneuver.ts`   | complete, tested (frames, ordering, Δv totals)            |
| `trajectory.ts` | complete, tested (two-body + N-body, burns, impact check) |

`src/render`:

| Module     | Status                                                                            |
| ---------- | --------------------------------------------------------------------------------- |
| `scale.ts` | complete, tested (linear + logarithmic radial mapping)                            |
| `scene.ts` | complete: bodies, rings, labels, picking, camera, drag/zoom, off-screen reporting |

`src/ui`:

| Module           | Status                                                   |
| ---------------- | -------------------------------------------------------- |
| `App.tsx`        | complete: viewport, scenario picker, time bar, inspector |
| `bodyDisplay.ts` | complete: names, colours, ordering                       |
| `styles.css`     | complete: dark theme, reduced motion                     |

`src/scenarios` — schema, validation and the bundled catalogue:

| Module         | Status                                                       |
| -------------- | ------------------------------------------------------------ |
| `types.ts`     | complete: versioned `Scenario` / `ScenarioView` types        |
| `validate.ts`  | complete, tested: structural validation with field paths     |
| `catalogue.ts` | complete, tested: three bundled scenarios, validated on load |

Entry points: `index.html`, `src/main.tsx`, `e2e/shell.spec.ts`, `playwright.config.ts`.

Not yet written: trajectory rendering, the maneuver-node UI, porkchop, ground track, scenario
persistence and file import/export. The M4 physics layer (`maneuver.ts`, `trajectory.ts`) exists
and is tested, but nothing in `src/ui` or `src/render` consumes it yet.

## Milestones

| Milestone                 | Status                                                         |
| ------------------------- | -------------------------------------------------------------- |
| M0 scaffold               | done                                                           |
| M1 physics foundation     | done                                                           |
| M2 N-body + solar system  | done                                                           |
| M3 3D shell               | done (M3.1-M3.6)                                               |
| M4 spacecraft + maneuvers | model layer done and tested; rendering and node UI outstanding |
| M5 mission planning       | M5.1, M5.2 done; porkchop, workflow, scenarios outstanding     |
| M6 ground track + Moon    | not started                                                    |
| M7 scenarios + polish     | not started                                                    |
| M8 hardening              | not started                                                    |

## Known limitations carried forward

- Lambert is single-revolution only; multi-revolution arcs report `converged: false`.
- Delta-v from solar-system ephemerides is indicative, not operational: JPL Table 1's Mars
  range carries ~25,000 km (~1.7e-4 AU) of error, which moves Earth-Mars delta-v by a few
  tens of m/s.
- Element round-trip near apsides is capped at ~1.5e-8 relative by true-anomaly
  ill-conditioning; tests are bounded accordingly and say so in comments.
- The 3D view offers two radial layouts because neither alone is sufficient: true scale is
  honest but only fits the inner system (Neptune is 3,010 units out against a ~133-unit
  visible half-height at the default camera), while the compressed mode fits everything but
  is not to scale. Body radii are cube-root compressed in both modes. All three compromises
  are labelled in the UI rather than left implicit, and the View panel names exactly which
  bodies are off screen at the current camera distance.
- Drag-to-orbit and wheel zoom are wired to pointer events on the canvas, with pointer
  capture and drag-versus-click suppression so orbiting never reselects a body. There is no
  touch gesture handler beyond what pointer events give for free: one-finger drag orbits,
  but pinch-to-zoom is not implemented.
- A spacecraft placed exactly at a body's centre makes the restricted N-body field singular:
  `rk45Step` throws `step-size control failed to converge` rather than returning a non-finite
  state. Not guarded in v1; tests offset the craft 90° in heliocentric longitude.
- Local burns at the same instant are order-dependent, because the frame is re-derived after
  each burn (measured: 0.15 m/s swapping a prograde and a normal node). Order is deterministic
  via (time, id), so a saved mission replays identically.
