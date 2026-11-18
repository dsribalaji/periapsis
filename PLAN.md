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
- [ ] M0.6 Docs skeleton (README, SETUP, ARCHITECTURE, PHYSICS, ADR-0001, TESTING, GLOSSARY, ...)
      — partial: README.md, PHYSICS.md, PLAN.md, STATE.md, DECISIONS.md, BLOCKERS.md exist.
      Still missing: SETUP, ARCHITECTURE, TESTING, GLOSSARY, ADR/.
- [x] M0.7 State files: PLAN, STATE, BLOCKERS, DECISIONS
- [ ] M0.8 React shell renders; offline-only (no network at runtime)

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

- [ ] M3.1 Three.js scene bootstrap, body meshes, orbits, labels
- [ ] M3.2 Camera modes: free orbit, follow body, chase
- [ ] M3.3 Selection + readouts
- [ ] M3.4 Fixed-timestep simulation clock decoupled from FPS, time controls, warp
- [ ] M3.5 Bounded compute budget per frame + fast (closed-form coast) mode
- [ ] M3.6 First bundled scenario loads in UI

## M4 — Spacecraft and maneuvers

- [ ] M4.1 Spacecraft model + trajectory history/future lines
- [ ] M4.2 Maneuver nodes (time + prograde/normal/radial), edit/delete
- [ ] M4.3 Predicted post-burn trajectory refresh
- [ ] M4.4 Delta-v budget per spacecraft
- [ ] M4.5 LEO constellation scenario
- [ ] M4.6 Screenshots + review notes

## M5 — Mission planning

- [x] M5.1 Hohmann + bi-elliptic calculators with analytic tests
- [x] M5.2 Lambert solver (documented algorithm), textbook Earth-Mars validation
- [ ] M5.3 Porkchop plot computation + heat-map view with hover readout
- [ ] M5.4 Transfer -> maneuver-node workflow
- [ ] M5.5 GTO and Earth-Mars scenarios

## M6 — Ground track and Moon

- [ ] M6.1 Inertial -> Earth-fixed lat/lon via GMST rotation
- [ ] M6.2 2D equirectangular ground-track panel with graticule
- [ ] M6.3 Free-return scenario

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
