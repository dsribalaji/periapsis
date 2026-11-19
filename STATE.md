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

Last full run: `npm run verify` (2026-11-19) and `npx playwright test`.

| Check                       | Result                                                   |
| --------------------------- | -------------------------------------------------------- |
| Typecheck (`tsc --noEmit`)  | PASS                                                     |
| Lint (`eslint .`)           | PASS, 0 problems                                         |
| Unit tests (`vitest run`)   | PASS, 552 tests / 23 files                               |
| Build (`vite build`)        | PASS, 842 kB JS (230 kB gzip)                            |
| `npm run verify`            | PASS (typecheck + lint + tests + build)                  |
| E2E (`npx playwright test`) | PASS, 32 tests against the real app in headless Chromium |

All six were run, not inferred. The e2e suite starts its own dev server and drives the real
page: it asserts React mounts, a WebGL canvas is created and sized, the clock advances while
running, pausing freezes it, selecting a body updates the inspector, dragging orbits without
reselecting, the wheel zooms, the radial-mode toggle changes what is on screen, a scenario
switch replaces the epoch and focus, and the console stays free of errors. It also covers the
mission layer: the panel appears only for a scenario with a craft, its delta-v readouts match
the plan, the orbit radius stays near the planned altitude while running, a node is marked
applied once the clock passes it, and the trajectory is drawn on the canvas — verified by
counting orange pixels, 0 before the scenario switch and over a thousand after.

The e2e suite also covers the porkchop plot: the panel starts collapsed and expands, the computed
grid paints as a gradient with no holes for the default Earth-Mars window, hovering reports the
cell under the pointer (two well-separated points must give different dates), a hovering readout
survives the pointer resting still, an all-hole grid paints zero opaque pixels and says so,
validation blocks a mismatched body pair and an unparseable date without taking the app down, and
the plot stays usable across a scenario switch. The plot's canvas is 2D, so those tests read it
back with `getImageData` directly — no screenshot decode needed.

The transfer-to-node workflow is covered end to end as well: the departure button is disabled
until a cell is clicked, a clicked cell produces a node with a cost and an instant, a departure
months out extends the plan and says by how much, re-planning the same cell replaces its node
instead of stacking a second, a scenario without a spacecraft disables the action with a reason
instead of failing silently, and a fully converged grid produces a node from an arbitrary cell.

Note on the browser: the paired interactive browser extension was not connected, so
verification ran through Playwright's Chromium with software GL
(`--use-gl=swiftshader`). That is a real browser executing the real bundle, but it is not
the same as a check on a GPU-backed desktop browser.

## Test inventory

| File                            | Tests | Covers                                                            |
| ------------------------------- | ----- | ----------------------------------------------------------------- |
| `tests/vec3.test.ts`            | 18    | vector algebra, rotations, frame conversions                      |
| `tests/time.test.ts`            | 18    | JD/calendar, leap seconds, GMST, ERA                              |
| `tests/kepler.test.ts`          | 13    | elliptic + hyperbolic solvers, high-eccentricity cases            |
| `tests/elements.test.ts`        | 13    | state <-> elements round trips, apsides                           |
| `tests/twoBody.test.ts`         | 15    | closed-form propagation, energy/angular-momentum conservation     |
| `tests/integrators.test.ts`     | 16    | RK4 + Dormand-Prince RK45, convergence order, drift               |
| `tests/ephemeris.test.ts`       | 28    | body positions, velocities, mean motion, SOI                      |
| `tests/nbody.test.ts`           | 21    | acceleration, dominant body, patched-conic re-parenting           |
| `tests/lambert.test.ts`         | 35    | Hohmann/bi-elliptic/plane change + Lambert solver                 |
| `tests/clock.test.ts`           | 21    | warp, step budget, frame-rate independence, formatting            |
| `tests/simulation.test.ts`      | 15    | epoch/JD handling, body positions, determinism, reset             |
| `tests/scale.test.ts`           | 21    | scene scale, radius compression, radial mapping                   |
| `tests/scenario.test.ts`        | 35    | scenario schema, validation errors, bundled catalogue             |
| `tests/maneuver.test.ts`        | 23    | node frames, magnitudes, ordering, Δv totals                      |
| `tests/trajectory.test.ts`      | 25    | propagation modes, burns in-frame, Δv accounting, Hohmann arc     |
| `tests/craft.test.ts`           | 18    | circular orbit states, frames, periods, speeds, clearance         |
| `tests/trajectoryLines.test.ts` | 20    | body-fixed frame, exaggeration, envelope clipping, flown prefix   |
| `tests/missionView.test.ts`     | 20    | plan/progress split, Δv accounting, interpolation, aliasing       |
| `tests/porkchop.test.ts`        | 34    | grid construction, Lambert agreement, cost/geometry, holes        |
| `tests/porkchopView.test.ts`    | 50    | colour ramp, image orientation, pointer mapping, ticks, readout   |
| `tests/departure.test.ts`       | 31    | closed-form departure, Oberth crossover, phase search, plane cost |
| `tests/transferView.test.ts`    | 42    | cell -> node, timing shift, warnings, horizon extension           |
| `tests/groundTrack.test.ts`     | 20    | obliquity, GMST rotation, geocentric lat/lon, antimeridian        |
| `e2e/shell.spec.ts`             | 32    | boot, WebGL, clock, picking, drag, zoom, mission, plot, departure |

## Module inventory

`src/core` — pure TypeScript, zero runtime deps, boundary enforced by ESLint:

| Module                            | Status                                   |
| --------------------------------- | ---------------------------------------- |
| `math/vec3.ts`, `math/numeric.ts` | complete, tested                         |
| `constants.ts`                    | complete (GM, AU, radii, day constants)  |
| `time/time.ts`                    | complete, tested                         |
| `orbit/kepler.ts`                 | complete, tested                         |
| `orbit/elements.ts`               | complete, tested                         |
| `orbit/twoBody.ts`                | complete, tested                         |
| `integrate/integrators.ts`        | complete, tested                         |
| `ephemeris/solarSystem.ts`        | complete (JPL Table 1 verbatim)          |
| `ephemeris/ephemeris.ts`          | complete, tested                         |
| `ephemeris/nbody.ts`              | complete, tested                         |
| `transfer/transfers.ts`           | complete, tested                         |
| `transfer/lambert.ts`             | complete, tested (single revolution)     |
| `transfer/porkchop.ts`            | complete, tested (grid of Lambert costs) |
| `transfer/departure.ts`           | complete, tested (closed-form departure) |
| `groundTrack/groundTrack.ts`      | complete, tested (ecliptic→equatorial→Earth-fixed lat/lon) |

`src/sim` — pure, no DOM, no clock, no RNG:

| Module          | Status                                                           |
| --------------- | ---------------------------------------------------------------- |
| `clock.ts`      | complete, tested (warp, budget, step coarsening)                 |
| `simulation.ts` | complete, tested (epoch, JD, positions, snapshots)               |
| `maneuver.ts`   | complete, tested (frames, ordering, Δv totals)                   |
| `trajectory.ts` | complete, tested (two-body + N-body, burns, impact check)        |
| `craft.ts`      | complete, tested (circular orbit parameterisation, shared frame) |

`src/render`:

| Module               | Status                                                              |
| -------------------- | ------------------------------------------------------------------- |
| `scale.ts`           | complete, tested (linear + logarithmic radial mapping, offsets)     |
| `trajectoryLines.ts` | complete, tested (body-fixed frame, exaggeration, clipping, prefix) |
| `scene.ts`           | complete: bodies, rings, labels, picking, camera, drag/zoom,        |
|                      | trajectories and the craft marker                                   |

`src/ui`:

| Module              | Status                                                    |
| ------------------- | --------------------------------------------------------- |
| `App.tsx`           | complete: viewport, scenario picker, time bar, inspector  |
| `bodyDisplay.ts`    | complete: names, colours, ordering                        |
| `missionView.ts`    | complete, tested: plan/progress split, sampling adequacy  |
| `MissionPanel.tsx`  | complete: readouts, budget, node list, aliasing caveat    |
| `porkchopView.ts`   | complete, tested: ramp, image, pointer, ticks, readout    |
| `PorkchopPanel.tsx` | complete: canvas heat-map, hover, click-select, departure |
| `transferView.ts`   | complete, tested: cell -> node, timing, warnings, horizon |
| `styles.css`        | complete: dark theme, node list, plot, reduced motion     |

`src/scenarios` — schema, validation and the bundled catalogue:

| Module         | Status                                                      |
| -------------- | ----------------------------------------------------------- |
| `types.ts`     | complete: versioned `Scenario` / `ScenarioView` types       |
| `validate.ts`  | complete, tested: structural validation with field paths    |
| `catalogue.ts` | complete, tested: four bundled scenarios, validated on load |

Entry points: `index.html`, `src/main.tsx`, `e2e/shell.spec.ts`, `playwright.config.ts`,
`scripts/inspect-screenshot.mjs` (decodes a screenshot and reports measurable facts; the agent
cannot view images, so a screenshot is only ever "measured", never "looked at").

Not yet written: the maneuver-node _editor_ (nodes are shown and marked applied, and one can now
be created from a porkchop cell, but there is no edit/delete control yet — `leo-raise` carries its
node as scenario data), arrival/capture burns, ground track, scenario persistence and file
import/export.

## Milestones

| Milestone                 | Status                                                           |
| ------------------------- | ---------------------------------------------------------------- |
| M0 scaffold               | done                                                             |
| M1 physics foundation     | done                                                             |
| M2 N-body + solar system  | done                                                             |
| M3 3D shell               | done (M3.1-M3.6)                                                 |
| M4 spacecraft + maneuvers | model and visual layers done; node editing UI outstanding (M4.2) |
| M5 mission planning       | M5.1–M5.4 done; Earth-Mars/GTO scenarios outstanding (M5.5)      |
| M6 ground track + Moon    | M6.1 done (physics); M6.2 panel not started                       |
| M7 scenarios + polish     | not started                                                      |
| M8 hardening              | not started                                                      |

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
- A trajectory is drawn body-fixed at the scenario epoch (PHYSICS.md §10.2, D-014), so a craft
  that genuinely leaves its central body is drawn attached to it. The mission panel reports the
  physics (impact, apoapsis, periapsis) as numbers; the picture is a local view, not a
  heliocentric path.
- Trajectory geometry reuses the central body's radius exaggeration (PHYSICS.md §10.3), so the
  orbit is correct _about that body_ but not to scale against the heliocentric layout: the Moon
  is drawn at 72 units from Earth-drawn-space while its scene position is ~0.03 units away.
- Inclinations are ecliptic-referenced, not equatorial (PHYSICS.md §10.4), so a quoted 53° is
  53° from the ecliptic. Corrected properly only when the ground track arrives (M6).
- Maneuver nodes are displayed and marked applied as the clock passes them, and one can now be
  created from a porkchop cell, but there is no edit or delete control yet; other nodes are
  scenario data. M4.2's UI half stays open in PLAN.md.
- **Porkchop cost is the sum of the two v-infinity speeds, not parking-orbit delta-v.** The
  Oberth effect is omitted, so the plot ranks windows correctly (Spearman ρ ≥ 0.9997 on the
  grids measured, and the parking-orbit optimum landed in the same cell every time) while the
  absolute number is off: −1% for Mars, +5% for Venus, and 26% _too high_ for Mercury
  (18.29 plotted against 13.56 km/s of real parking-orbit cost). Stated in the panel and in
  PHYSICS.md §11.2 rather than corrected, because the correction needs a departure orbit and a
  capture orbit the grid does not have, and inventing defaults would put an unstated assumption
  inside a number read as a budget.
- **Porkchop transfers are single-revolution only**, inherited from `solveLambert`. A cell
  outside the reachable set is a hole (drawn transparent, readout dashes) rather than a
  multi-revolution estimate.
- **The porkchop is heliocentric only.** The Moon is excluded because a lunar transfer is a
  geocentric problem; a departure or arrival orbit's own radius is not an input, so no
  departure-escape or capture delta-v is computed.
- **A planned departure is a departure only.** `buildTransferNode` costs the burn out of the
  parking orbit; the arrival is still just the cell's `v_inf` number, because a craft in this
  model has one central body and patched conics are not in v1.0.0. A mission planned this way
  escapes Earth and is drawn escaping it (PHYSICS.md §10.2), which is honest about the model and
  not a flyable Earth-Mars mission.
- **The departure burn can have a periapsis inside the departure body** and still be created. The
  propagated path never enters the body (the burn is outbound), so the simulation is consistent,
  but a real mission would reject the arc. Reported as a `below-surface` warning on the node
  (D-023, PHYSICS.md §12.5) with the fix (a parking inclination nearer the target asymptote).
- **A planned departure extends the mission's horizon, which aliases the drawn coast.** A 735-day
  horizon draws one sample per 2.77 parking orbits, so the picture is a star polygon even though
  the states are exact. Reported as `periodFractionPerSample` and a panel caveat (D-029,
  PHYSICS.md §12.8). Raising the point cap does not fix it: 4000 points over 735 days is still
  0.44 of a period per sample.
- **Extending a plan past the horizon is refused for N-body missions** rather than computed:
  months of integration at millisecond tolerances is not interactive. The panel says so
  (D-025).
- **Porkchop timing is 2.6x slower on this machine than when M5.3 measured it**, uniformly across
  grid sizes, because the CPU runs at 1.5 GHz of a 2.2 GHz maximum on battery. Both measurements
  are in PHYSICS.md §11.1 rather than one replacing the other: a wall-clock figure from a laptop
  is only comparable to itself at the same clock state.
