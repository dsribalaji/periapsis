# PLAN

Milestone plan and iteration backlog for Periapsis. Status vocabulary: `pending`,
`in-progress`, `done`, `deferred` (deferred items stay visible with a reason).

## Ground rules

- One logical change per iteration: build, verify, self-review, fix, document, commit.
- `npm run verify` = typecheck + lint + unit tests + build.
- Physics core is pure TypeScript: zero runtime deps, no DOM, no ambient clock.

## M0 — Scaffold and discipline

- [x] M0.1 git init, package.json, pinned dependency install
- [x] M0.2 TypeScript strict config, Vite + React build, Prettier
- [x] M0.3 ESLint with the core-purity boundary rules
- [x] M0.4 Vitest config + Playwright config + first smoke test
- [x] M0.5 `verify` script runs typecheck, lint, unit tests, build
- [x] M0.6 Docs skeleton (README, SETUP, ARCHITECTURE, PHYSICS, ADR-0001, TESTING, GLOSSARY, ...)
      — README, SETUP, ARCHITECTURE, PHYSICS, TESTING, GLOSSARY, PLAN, STATE, BLOCKERS,
      DECISIONS and ADR/0001-0007 all exist.
- [x] M0.7 State files: PLAN, STATE, BLOCKERS, DECISIONS
- [x] M0.8 React shell renders; offline-only (no network at runtime)

## M1 — Physics foundation

- [x] M1.1 vec3 math + rotations + numerical helpers, unit tested
- [x] M1.2 Time systems: JD <-> calendar, GMST, time-scale ADR
- [x] M1.3 Classical elements <-> state vector (elliptic + hyperbolic), round-trip property tests
- [x] M1.4 Kepler solver (elliptic + hyperbolic), tests
- [x] M1.5 Two-body closed-form propagator, conservation tests
- [x] M1.6 PHYSICS.md sections for all of the above with tolerances

## M2 — Restricted N-body and solar system

- [x] M2.1 Integrators: RK4 fixed step + Dormand-Prince RK45 adaptive, convergence + drift tests
- [x] M2.2 Restricted N-body acceleration core (prescribed ephemerides)
- [x] M2.3 Built-in solar system data (Sun..Neptune + Moon), sourced and dated
- [x] M2.4 SOI model + patched-conics re-parenting, ADR
- [x] M2.5 Determinism and two-body-limit tests

## M3 — 3D application shell

- [x] M3.1 Three.js scene bootstrap, body meshes, orbits, labels
- [x] M3.2 Camera modes: free orbit, follow body, chase
- [x] M3.3 Selection + readouts
- [x] M3.4 Fixed-timestep simulation clock decoupled from FPS, time controls, warp
- [x] M3.5 Bounded compute budget per frame + fast (closed-form coast) mode
- [x] M3.6 First bundled scenario loads in UI

## M4 — Spacecraft and maneuvers

The model and visual layers are built and tested. What is not built is the node _editor_: nodes
are scenario data that the panel lists and marks as applied, but the user cannot yet add, edit or
delete one. Those items stay unticked rather than being checked off on the strength of display.

- [ ] M4.1 Spacecraft model + trajectory history/future lines
  - [x] `Spacecraft` (central body, relative state, budget, nodes) and `propagateTrajectory`
        with `twoBody` and `nbody` modes, split at every burn
  - [x] Rendered future line in the 3D view, body-fixed and drawn over the bodies
  - [x] Flown/future split by `drawRange` as the clock advances
- [ ] M4.2 Maneuver nodes (time + prograde/normal/radial), edit/delete
  - [x] `Maneuver` in the local orbital frame or inertial, `applyManeuver`, deterministic
        ordering by (time, id)
  - [x] Node list UI: label, magnitude, time, frame, and an applied state
  - [ ] Add/edit/delete controls
- [ ] M4.3 Predicted post-burn trajectory refresh
  - [x] Post-burn segments are propagated, `afterBurn` points mark the discontinuity
  - [ ] Refresh on node edit in the UI — depends on the editor in M4.2
- [ ] M4.4 Delta-v budget per spacecraft
  - [x] `totalDeltaV`, `remainingDeltaV`, `usedDeltaV` per propagation (negative when over)
  - [x] Budget/planned/spent/remaining readout, with an over-budget warning
- [ ] M4.5 LEO constellation scenario
  - [x] `leo-raise`: one 550 km satellite with a planned raise node and a live readout
  - [ ] A true multi-satellite constellation (needs more than one craft per scenario)
- [x] M4.6 Screenshots + review notes — `screenshots/m4-leo-raise.png`, measured by
      `scripts/inspect-screenshot.mjs` (1400x860, 4.8% non-background, 3,889 mission-colour
      pixels). The agent cannot view images, so this is a measured check, not a visual one;
      the e2e colour count is the primary evidence that the trajectory is drawn.

## M5 — Mission planning

- [x] M5.1 Hohmann + bi-elliptic calculators with analytic tests
- [x] M5.2 Lambert solver (documented algorithm), textbook Earth-Mars validation
- [x] M5.3 Porkchop plot computation + heat-map view with hover readout
      — `core/transfer/porkchop.ts` (grid) and `ui/porkchopView.ts` (colour ramp, image
      buffer, pointer mapping, axis ticks, readout, summary), `ui/PorkchopPanel.tsx` (canvas
      and form), 82 unit tests, 9 e2e tests. The panel starts collapsed (D-019). Cost is the
      v-infinity sum, not parking-orbit delta-v (D-018, PHYSICS.md §11.2). Screenshot
      `screenshots/m5-porkchop.png`, measured by `scripts/inspect-screenshot.mjs`.
- [x] M5.4 Transfer -> maneuver-node workflow
      — `core/transfer/departure.ts` (closed-form departure burn + phase search) and
      `ui/transferView.ts` (cell -> node, timing shift, warnings, horizon extension),
      `departureAsymptote` in `core/transfer/porkchop.ts`, `circularOrbitFrame` in `sim/craft.ts`,
      `periodFractionPerSample` in `ui/missionView.ts`. 73 new unit tests, 6 new e2e tests.
      Clicked-cell selection, epoch-anchored default window (D-028), aliasing caveat (D-029).
      PHYSICS.md §12, DECISIONS D-020—D-029.
- [x] M5.5 GTO and Earth-Mars scenarios
      — `gto-transfer` and `earth-mars-departure` in `src/scenarios/catalogue.ts` (six
      scenarios now), 4 new tests in `tests/scenario.test.ts` (39 total) that re-derive both
      scenarios' burns from `hohmannTransfer` and the circularisation geometry rather than
      asserting the file's own literals (D-033). GTO: 300 km / 28.5-degree park, nodes at
      T+0 (2,427.8 m/s) and T+18,986 s (1,095.0 prograde + 1,467.1 normal), 4,258.4 m/s total
      against a 4,400 budget; ends at 42,164.0 km, i = 0.0000 degrees, e = 1e-6. Earth-Mars:
      300 km / 51.6-degree park with no nodes, so the first action is a porkchop click; the
      2028-11-21 cell costs 4,338.4 m/s against a 4,700 budget. Also fixed a trajectory-frame
      defect found while measuring (D-032, PHYSICS.md §10.2): the drawn path was anchored at
      the epoch, which double-counted the body's own displacement and drew the 550 km LEO
      orbit as a 343,390 km streak. 3 new e2e tests (35 total), 3 new unit tests in
      `tests/missionView.test.ts` (23) and 2 in `tests/trajectoryLines.test.ts` (22).
      PHYSICS.md §12.10.

## M6 — Ground track and Moon

- [x] M6.1 Inertial -> Earth-fixed lat/lon via GMST rotation - `core/groundTrack/groundTrack.ts`, 20 unit tests. Three frames in order:
      heliocentric → Earth-relative **at each sample's own time**, → equatorial (obliquity
      23.44°, closing the PHYSICS.md §10.4 deferral), → Earth-fixed (GMST). Emits geocentric
      latitude, east longitude, altitude, and an `crossesAntimeridian` break per segment so a
      renderer never draws a line across the map. Mutation-tested: removing the obliquity
      rotation fails 8/20, freezing the epoch-relative origin fails 7/20. PHYSICS.md §13.
      The panel that draws it is M6.2, which was the reason this box stayed unticked; both are
      now done.
- [x] M6.2 2D equirectangular ground-track panel with graticule
      — `ui/groundTrackView.ts` (projection, polyline splitting, marker interpolation, summary,
      Bresenham image buffer) and `ui/GroundTrackPanel.tsx` (canvas, marker, readouts, caveats),
      34 unit tests, 6 e2e tests. Measured on the bundled plans: `leo-raise` 197 samples / 3
      polylines / 1,883 track pixels / 670.5° span; `gto-transfer` 1,755 samples / 602 pixels;
      `earth-mars-departure` 92 samples / 948 pixels / 337.3° (one 90-minute orbit minus the
      Earth's 22.5° of rotation). The panel revealed that the GTO's "geostationary" orbit sweeps
      ±23.44° of latitude — exactly `OBLIQUITY_J2000` — because inclinations are ecliptic-
      referenced (PHYSICS.md §13.5); that is the datum made visible, not a defect. Two design
      points came out of the tests: the core module now records `startsAfterGap` (D-034) rather
      than letting the renderer infer gaps from sample spacing, and the map/panel altitude gap is
      bounded by one chord sagitta, 3,642 m measured against 3,526 m predicted (D-035).
      PHYSICS.md §13.5.
- [x] M6.3 Free-return scenario - `lunar-free-return` in `scenarios/catalogue.ts`: one prograde 3,115 m/s node at T+0 from
      a 300 km, 5° park (phase 255°) at the Earth-Moon epoch, propagated N-body over 9 days.
      Measured with all bodies: lunar flyby at 2,694 km of altitude at T+3.27 d, return to 686 km
      at T+6.36 d, plan built in 345 ms. Re-derived and asserted in `tests/scenario.test.ts` (8
      tests) and `e2e/shell.spec.ts` (6 tests). Three findings, all recorded: the epoch is
      load-bearing (the Moon's phase is what makes one burn return), the 5° inclination is tuned
      rather than "near the ecliptic" (0° misses by 26,319 km, 28.6° by 133,803 km), and the
      burn is a knife-edge (±20 m/s costs the flyby entirely, with impacts on either side). The
      no-Moon test had to assert the return ratio rather than the miss distance, because the
      unperturbed ellipse is aimed at the Moon's position anyway (4,672 km of altitude against
      2,694 km). D-036, PHYSICS.md §14.

## M7 — Scenarios and polish

- [ ] M7.1 Versioned scenario schema + validation + migration
- [ ] M7.2 IndexedDB/localStorage persistence, file export/import with error report
- [ ] M7.3 Accessibility pass (focus, contrast, reduced motion, shortcuts)
- [ ] M7.4 Performance measurement with recorded numbers

## M8 — v1.0.0 hardening

- [ ] M8.1 Full verification sweep from a clean install
- [ ] M8.2 Docs completeness audit against the spec
- [ ] M8.3 CHANGELOG v1.0.0, local tag
- [ ] M8.4 Final report

## Deferred / not planned for v1.0.0

- Finite (non-impulsive) burns — stretch only, not implemented.
- Coastline map data — v1 ships a graticule-only map (recorded in DECISIONS.md D-004).
- Full N-body integration of the massive bodies — out of scope by design (ADR-0003).
