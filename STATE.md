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

Last full run: `npm run verify` (2026-11-19) and `npx playwright test`, at tag `v1.0.0`.

A visual pass after v1.0.0 (uncommitted at the time of writing) fixed the reported Moon/Earth
overlap and unreal body sizes. It adds 5 tests (672 / 30 files) and two scripts that measure
rather than assert: `scripts/measure-startup.mjs` (first interaction) and
`scripts/count-mission-pixels.mjs` (whether a trajectory is actually on screen). Details are in
`DECISIONS.md` D-043 to D-046.

| Check                       | Result                                                   |
| --------------------------- | -------------------------------------------------------- |
| Typecheck (`tsc --noEmit`)  | PASS                                                     |
| Lint (`eslint .`)           | PASS, 0 problems                                         |
| Unit tests (`vitest run`)   | PASS, 672 tests / 30 files                               |
| Build (`vite build`)        | PASS, 869.62 kB JS (238.72 kB gzip)                      |
| `npm run verify`            | PASS (typecheck + lint + tests + build)                  |
| E2E (`npx playwright test`) | PASS, 62 tests against the real app in headless Chromium |

All six were run, not inferred. M8.1 also proved the clean-install path: a fresh `git clone` of
this repository into an empty directory, `npm ci` from the lockfile (201 packages, 0
vulnerabilities, 27 s), then `npm run verify` and `npx playwright test` in that clone. The build
produced the same asset hashes as the working tree, so the output is reproducible from the
lockfile alone and nothing in the working tree is load-bearing.

The e2e suite starts its own dev server and drives the real
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

The two departure scenarios have their own end-to-end coverage: the GTO scenario shows both
burns, a planned total of 4,258.4 m/s, and an end state at a circular 42,164 km orbit whose live
radius agrees with the panel's own apoapsis; its T+0 burn is already spent when the scenario
loads; and the Earth–Mars park opens with no node, a pure 300 km coast, and one porkchop click
turns it into a kilometres-per-second departure with the plan extended and flagged as aliased.

The mission panel's live radius is asserted against the panel's own apoapsis rather than against
a wide tolerance. That assertion is the direct consequence of a defect found in M5.5: the drawn
path was anchored at the scenario epoch, which double-counted the central body's displacement and
drew the bundled 550 km orbit as a 343,390 km streak, so the panel read "Radius now
343,389.8 km" above "Apoapsis 7,151.9 km". The old test passed it, because its tolerance was
±1,000 km. Fixed in D-032 / PHYSICS.md §10.2, with regression tests at both the unit and e2e
level that compare one readout against another instead of against a constant.

The ground-track panel is covered by six more e2e tests: it appears for an Earth mission and
reports a sub-satellite point whose altitude matches the mission panel, the map canvas is read back
with `getImageData` and must contain over 500 track-coloured pixels (measured 1,883 for
`leo-raise`), the marker stays inside the map and both it and the lat/lon readouts change as the
clock runs, the antimeridian caveat appears for a track that laps the Earth, the panel is absent
for a scenario with no spacecraft, and the partial-coverage note appears for a 90-minute park whose
337.3° span does not close the map. The panel's projection and its two line-break rules are
asserted at the unit level (34 tests), where they are arithmetic rather than pixels.

The free-return scenario is covered from both directions as well, six e2e tests and eight unit
tests. End to end: it loads with one translunar node and no second, the 3,115.0 m/s of a 3,300 m/s
budget is already spent on load because the burn is at T+0, the plan's apoapsis is 373,475 km and
its periapsis 6,671 km (one propagation answering both questions), it is not flagged as aliased
despite a 9-day horizon, the ground track draws and the altitude climbs when the clock resumes,
and the panel disappears on a scenario with no spacecraft. At the unit level the burn is re-derived
from vis-viva rather than trusted, and the trajectory itself is propagated: 2,694 km of lunar
altitude at T+3.27 d, 686 km over the Earth at T+6.36 d.

One test had to be rewritten and the reason is the heart of the scenario. Removing the Moon does
not stop the craft passing near the Moon's position — the burn is aimed there, so the unperturbed
ellipse closes to 4,672 km of lunar altitude against 2,694 km with the Moon present. Distance
cannot separate the two cases. The return can: without the Moon the burn is a closed ellipse with
a 10.4-day period, and at the end of the 9-day horizon the craft is still 308,380 km out, against
7,045 km at 6.36 days. The test asserts that ratio (43.7x measured, bounded at 20x).

Scenario persistence and file handling are covered at both levels too. At the unit level (62
tests across four files) the migration walker is exercised against a synthetic chain, the export
is round-tripped for all seven bundled scenarios, filenames are checked against a hostile id
(`../../etc/passwd` becomes `etc-passwd.periapsis.json`), every malformed import is checked to
return a message rather than throw, and the store is tested against three fake implementations: a
working one, one that refuses writes (Safari private mode) and one that refuses reads. At the e2e
level (6 tests) a scenario is downloaded and reopened under a new name, a broken file is refused
with the field path on screen, a non-JSON file is named as such, a chosen scenario survives a
reload, and forgetting it returns the app to the default on the next load.

Two behaviours in that block are worth stating because they are choices rather than accidents.
A refused import leaves the current scenario untouched, so a bad file cannot take the app away
from where the user was. And clearing the store does not change the current session - the user
asked to forget what is saved, not to be thrown back to the default mid-task (D-037).

Accessibility is covered by nine e2e tests rather than unit tests, because focus order, roles and
live announcements have no visual or arithmetic signature. They assert that the skip link is the
first tab stop and really moves focus into the sidebar, that the 3D view and both canvases expose
`role="img"` with descriptive labels, that the body list is reachable and activatable with Enter
and Space, that the live region tracks pause and warp, that an import failure is an alert, and that
a reduced-motion context has zero transition duration while the clock still advances. Contrast is
not tested but measured: every text pair is recorded in TESTING.md, including the two that fail and
why they are not used.

That pass found a genuine bug rather than only tidying. The global Space shortcut did not check
what had focus, so pressing Space on a newly-native body button selected the body and paused the
clock at the same time. Two tests now pin the behaviour in both directions: Space on a focused
button presses only that button, and Space with nothing focused still pauses.

Performance is measured rather than asserted, in `scripts/benchmark.mjs` and
`scripts/benchmark-frames.mjs`, with the figures in PERFORMANCE.md. The first loads the real modules
through Vite's `runnerImport`, so it times the code that ships; the second drives the app in
headless Chromium, because frame rate is the one thing a Node script cannot answer. Neither is a
test: both print numbers and exit 0, so a slow machine cannot fail a build. The result worth
recording is that per-frame script cost is under 1% of a 60 Hz frame at every warp step, and the
30 fps at 1280x800 is the software rasteriser rather than the app - the same scenarios hold 60 fps
at 320x200 with no long tasks. The one cost a person feels is switching to the lunar free return,
about a second of blocked main thread for a genuine 4,001-sample propagation.

Note on the browser: the paired interactive browser extension was not connected, so
verification ran through Playwright's Chromium with software GL
(`--use-gl=swiftshader`). That is a real browser executing the real bundle, but it is not
the same as a check on a GPU-backed desktop browser.

## Test inventory

| File                            | Tests | Covers                                                             |
| ------------------------------- | ----- | ------------------------------------------------------------------ |
| `tests/vec3.test.ts`            | 18    | vector algebra, rotations, frame conversions                       |
| `tests/time.test.ts`            | 18    | JD/calendar, leap seconds, GMST, ERA                               |
| `tests/kepler.test.ts`          | 13    | elliptic + hyperbolic solvers, high-eccentricity cases             |
| `tests/elements.test.ts`        | 13    | state <-> elements round trips, apsides                            |
| `tests/twoBody.test.ts`         | 15    | closed-form propagation, energy/angular-momentum conservation      |
| `tests/integrators.test.ts`     | 16    | RK4 + Dormand-Prince RK45, convergence order, drift                |
| `tests/ephemeris.test.ts`       | 28    | body positions, velocities, mean motion, SOI                       |
| `tests/nbody.test.ts`           | 21    | acceleration, dominant body, patched-conic re-parenting            |
| `tests/lambert.test.ts`         | 35    | Hohmann/bi-elliptic/plane change + Lambert solver                  |
| `tests/clock.test.ts`           | 21    | warp, step budget, frame-rate independence, formatting             |
| `tests/simulation.test.ts`      | 15    | epoch/JD handling, body positions, determinism, reset              |
| `tests/scale.test.ts`           | 22    | scene scale, radius compression, satellite ratio, radial mapping   |
| `tests/scenario.test.ts`        | 47    | scenario schema, validation, catalogue, free-return physics        |
| `tests/maneuver.test.ts`        | 23    | node frames, magnitudes, ordering, Δv totals                       |
| `tests/trajectory.test.ts`      | 25    | propagation modes, burns in-frame, Δv accounting, Hohmann arc      |
| `tests/craft.test.ts`           | 18    | circular orbit states, frames, periods, speeds, clearance          |
| `tests/trajectoryLines.test.ts` | 22    | body-relative frame, exaggeration, envelope clipping, flown prefix |
| `tests/missionView.test.ts`     | 23    | plan/progress split, Δv accounting, interpolation, aliasing        |
| `tests/porkchop.test.ts`        | 34    | grid construction, Lambert agreement, cost/geometry, holes         |
| `tests/porkchopView.test.ts`    | 50    | colour ramp, image orientation, pointer mapping, ticks, readout    |
| `tests/departure.test.ts`       | 31    | closed-form departure, Oberth crossover, phase search, plane cost  |
| `tests/transferView.test.ts`    | 42    | cell -> node, timing shift, warnings, horizon extension            |
| `tests/groundTrack.test.ts`     | 20    | obliquity, GMST rotation, geocentric lat/lon, antimeridian         |
| `tests/groundTrackView.test.ts` | 34    | projection, antimeridian split, gaps, marker, image, datum check   |
| `tests/migrate.test.ts`         | 15    | version gate, chain ordering, gaps, validation after migrating     |
| `tests/scenarioIo.test.ts`      | 23    | export round trip, filenames, import errors, hostile ids           |
| `tests/persist.test.ts`         | 17    | envelope, corrupt/newer handling, refusing stores, round trip      |
| `tests/placement.test.ts`       | 3     | planets on the radial mapping, satellites parent-relative, clear    |
| `tests/boot.test.ts`            | 7     | restore, discard, preserve-newer, no store, custom ids             |
| `tests/version.test.ts`         | 3     | version injected from package.json, format, single source          |
| `e2e/shell.spec.ts`             | 62    | boot, WebGL, clock, picking, drag, mission, plot, map, files, a11y |

## Module inventory

`src/core` — pure TypeScript, zero runtime deps, boundary enforced by ESLint:

| Module                            | Status                                                     |
| --------------------------------- | ---------------------------------------------------------- |
| `math/vec3.ts`, `math/numeric.ts` | complete, tested                                           |
| `constants.ts`                    | complete (GM, AU, radii, day constants)                    |
| `time/time.ts`                    | complete, tested                                           |
| `orbit/kepler.ts`                 | complete, tested                                           |
| `orbit/elements.ts`               | complete, tested                                           |
| `orbit/twoBody.ts`                | complete, tested                                           |
| `integrate/integrators.ts`        | complete, tested                                           |
| `ephemeris/solarSystem.ts`        | complete (JPL Table 1 verbatim)                            |
| `ephemeris/ephemeris.ts`          | complete, tested                                           |
| `ephemeris/nbody.ts`              | complete, tested                                           |
| `transfer/transfers.ts`           | complete, tested                                           |
| `transfer/lambert.ts`             | complete, tested (single revolution)                       |
| `transfer/porkchop.ts`            | complete, tested (grid of Lambert costs)                   |
| `transfer/departure.ts`           | complete, tested (closed-form departure)                   |
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
| `trajectoryLines.ts` | complete, tested (body-relative per sample, exaggeration, clipping) |
| `scene.ts`           | complete: bodies, rings, labels, picking, camera, drag/zoom,        |
|                      | trajectories and the craft marker                                   |

`src/ui`:

| Module                 | Status                                                     |
| ---------------------- | ---------------------------------------------------------- |
| `App.tsx`              | complete: viewport, scenario picker, time bar, inspector   |
| `bodyDisplay.ts`       | complete: names, colours, ordering                         |
| `missionView.ts`       | complete, tested: plan/progress split, sampling adequacy   |
| `MissionPanel.tsx`     | complete: readouts, budget, node list, aliasing caveat     |
| `groundTrackView.ts`   | complete, tested: projection, splits, marker, image buffer |
| `GroundTrackPanel.tsx` | complete: map canvas, marker, readouts, caveats            |
| `porkchopView.ts`      | complete, tested: ramp, image, pointer, ticks, readout     |
| `PorkchopPanel.tsx`    | complete: canvas heat-map, hover, click-select, departure  |
| `transferView.ts`      | complete, tested: cell -> node, timing, warnings, horizon  |
| `styles.css`           | complete: dark theme, node list, plot, reduced motion      |

`src/scenarios` — schema, validation and the bundled catalogue:

| Module         | Status                                                       |
| -------------- | ------------------------------------------------------------ |
| `types.ts`     | complete: versioned `Scenario` / `ScenarioView` types        |
| `validate.ts`  | complete, tested: structural validation with field paths     |
| `catalogue.ts` | complete, tested: seven bundled scenarios, validated on load |
| `migrate.ts`   | complete, tested: version gate + chain walker, empty chain   |
| `io.ts`        | complete, tested: export, filename, import with field paths  |
| `persist.ts`   | complete, tested: localStorage envelope, corrupt self-heal   |

Entry points: `index.html`, `src/main.tsx`, `e2e/shell.spec.ts`, `playwright.config.ts`,
`scripts/inspect-screenshot.mjs` (decodes a screenshot and reports measurable facts; the agent
cannot view images, so a screenshot is only ever "measured", never "looked at").

Not yet written: the maneuver-node _editor_ (nodes are shown and marked applied, and one can now
be created from a porkchop cell, but there is no edit/delete control yet - `leo-raise` carries its
node as scenario data), arrival/capture burns, and a runtime free-return _solver_ (the scenario
replays a measured trajectory rather than searching for one).

## Milestones

| Milestone                 | Status                                                           |
| ------------------------- | ---------------------------------------------------------------- |
| M0 scaffold               | done                                                             |
| M1 physics foundation     | done                                                             |
| M2 N-body + solar system  | done                                                             |
| M3 3D shell               | done (M3.1-M3.6)                                                 |
| M4 spacecraft + maneuvers | model and visual layers done; node editing UI outstanding (M4.2) |
| M5 mission planning       | done (M5.1–M5.5)                                                 |
| M6 ground track + Moon    | done (M6.1 physics, M6.2 panel, M6.3 free return)                |
| M7 scenarios + polish     | done (M7.1–M7.4)                                                 |
| M8 hardening              | done (M8.1–M8.4), v1.0.0 tagged locally                          |
| Visual pass (post-v1.0.0) | done, uncommitted: satellite scale, textures, wider track lines, pair framing |

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
- Satellite scale is a third rule on top of those two (PHYSICS.md 10.3): the Moon is drawn at
  its true radius ratio to Earth and placed at Earth's own exaggeration, which is the only way
  it can be outside the planet and agree with the trajectories drawn around it. In the
  compressed layout there is no room for a 72-unit satellite offset, so the Moon is drawn at
  three parent radii instead. Surface textures are procedural and plausible rather than real —
  Earth's continents are noise, not coastlines.
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
- A trajectory is drawn body-relative, against each sample's own time (PHYSICS.md §10.2,
  D-032), so a craft that genuinely leaves its central body is drawn attached to it. The mission
  panel reports the physics (impact, apoapsis, periapsis) as numbers; the picture is a local
  view, not a heliocentric path.
- Trajectory geometry reuses the central body's radius exaggeration (PHYSICS.md §10.3), so the
  orbit is correct _about that body_ but not to scale against the heliocentric layout: the Moon
  is drawn at 72 units from Earth-drawn-space while its scene position is ~0.03 units away.
- Inclinations are ecliptic-referenced, not equatorial (PHYSICS.md §10.4), so a quoted 53° is
  53° from the ecliptic. The ground track is where the equatorial answer exists (§13.5), which is
  why a 53° orbit reaches 76.44° of latitude on the map: 53 + 23.44. That is the datum, not a
  defect, but it means the scenario's stated inclination and the map's latitude range will never
  agree and both are correct.
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
- **The ground track is Earth-only.** The projection's obliquity and sidereal rotation are Earth's,
  so a mission about any other body reports no track rather than projecting it onto a world map
  that is not its world (D-004, PHYSICS.md §13.5). There is also no coastline layer: the map is a
  30° graticule, and a dot over Kansas is over Kansas only if the reader knows that.
- **The ground-track map and the mission panel report slightly different altitudes**, by up to one
  chord sagitta of the drawn path: 3,642 m measured against 3,526 m predicted on the bundled LEO
  plan, 0.05% of a 550 km altitude. The map is the true radius at a sample; the panel's is the
  chord radius of the drawn segment. Derived and bounded in D-035 / PHYSICS.md §13.5, not tuned.
- **The ground track is drawn from the plan, not the clock**, so it shows the whole horizon's path
  at once with a marker for the current point. It does not accumulate: switching scenarios replaces
  it, and it never draws where the craft has actually been beyond the flown prefix in the 3D view.
- **The free-return scenario is epoch-locked.** Its single 3,115 m/s burn works from the Moon's
  phase at `2027-04-07T12:00:00Z` and from nowhere else: move the epoch a day and the encounter is
  gone. That is the physics of a free return rather than a defect, but it means the scenario cannot
  be re-timed by the user, and the app has no free-return solver to re-time it (PHYSICS.md §14.5).
- **Impact detection covers the central body only.** `propagateTrajectory` compares the path
  against the central body's radius, so an Earth impact is flagged and a _lunar_ impact is not —
  at 3,110 m/s the free-return craft passes 1,227 km below the Moon's surface and the app shows a
  trajectory through the Moon rather than a warning. Found while writing PHYSICS.md §14.4, recorded
  there and here, not fixed in M6.3.
- **Persistence stores the scenario, not the session.** A reload returns to the scenario's start:
  the clock resets to its epoch and a maneuver node planned from a porkchop cell is not there,
  because the cell is not part of a scenario. The clock and the planned node are derived state,
  and restoring them would mean persisting an input whose epoch assumptions are no longer visible.
- **One saved scenario, in one browser, on one origin.** No profiles, no named slots, no export of
  a history. `localStorage` is per-origin and per-browser-profile, so the same app at a different
  port or in a different browser opens the default. The file export is the way to carry a scenario
  between them.
- **A scenario written by a newer build cannot be opened, only left alone.** The app says so and
  does not overwrite it, but the user's only route to their scenario is a build that reads it. This
  is deliberate (D-037) rather than an oversight: guessing at unknown fields would load something
  that is not the scenario they saved.
- **Storage can be unavailable, and the app does not warn about it beyond not remembering.**
  A browser with cookies blocked or storage full opens the default, the file panel omits the
  "Forget saved scenario" control because there is nothing to forget, and nothing claims a save
  happened. There is no persistent banner for it; a visit in that state is indistinguishable from
  a first visit by design.
- **Keyboard shortcuts are global and only partly scoped.** Space, the arrow keys, `+`/`-` and F work
  anywhere except inside a text field or on a focused button or link, where the element's own
  behaviour wins. There is no shortcut to disable them, no remapping, and no `aria-keyshortcuts`
  attribute, so a screen reader user has to read the hint in the View section to learn they exist.
  A full shortcut registry was out of scope for this milestone.
- **Accessibility is verified by automation, not by a person using assistive technology.** The e2e
  tests check roles, names, focus order and announcements in Chromium; they cannot say whether the
  app is pleasant to use with NVDA or VoiceOver, and no manual screen-reader pass has been done.
  The 3D view is a labelled image, so a non-visual user gets its description and the numbers in
  the panels rather than a rendering of the scene.
- **The 3D view has no keyboard camera control beyond framing.** The global keys frame a body, zoom
  by a step and reset the view; there is no way to orbit with the keyboard, so a user who cannot
  drag cannot change the viewing angle.
- **A scenario switch to the lunar free return blocks the main thread for about a second.** It is a
  genuine 4,001-sample N-body propagation, it happens on a deliberate action rather than during
  flight, and the result is cached for the scenario's lifetime - but the app freezes while it
  runs, and there is no progress indicator or worker. Measured at 1,015-1,184 ms on an i5-10310U;
  see PERFORMANCE.md for the alternatives considered and why each was rejected.
- **The frame rate is software-rasteriser bound, not script bound.** Every scenario holds 60 fps at
  320x200 and most settle at 30 at 1280x800, with zero long tasks, which means the JavaScript is
  idle waiting on the rasteriser. This is a limit of the measured environment (headless Chromium
  with swiftshader), not of the app's code, and it is expected to disappear on a real GPU - but
  that expectation is unmeasured.
