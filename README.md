# Periapsis

An offline orbital mechanics sandbox and mission designer. Runs entirely in the browser,
needs no account, no server and no network at runtime.

**Status: in development.** The physics core is complete and tested (449 unit tests); the 3D
application shell runs with scenario loading, mouse camera control, time controls and a working
mission layer — a spacecraft flies a planned path drawn in the view, with maneuver nodes and a
delta-v budget. A porkchop plot finds interplanetary launch windows by solving Lambert's problem
over a grid of departure dates and flight times. The node _editor_ (add/edit/delete), the
transfer-to-node workflow and the ground track are not built yet. See `STATE.md` for what
actually runs today and `PLAN.md` for the milestone backlog.

## What works today

The app: a 3D solar-system view with a draggable, zoomable camera, four bundled scenarios, a
warp clock from 1× to 10⁷×, an inspector, a mission panel showing a craft's trajectory, altitude
and delta-v budget as the clock advances, and a porkchop plot with a hover readout.

The pure physics core, as a library under `src/core`:

- Vector algebra, time systems (JD, leap seconds, GMST, ERA)
- Classical orbital elements ↔ state vectors, elliptic and hyperbolic
- Kepler's equation, both cases
- Closed-form two-body propagation
- RK4 and Dormand-Prince RK45 integrators
- Solar system ephemerides (JPL approximate elements, Table 1)
- Restricted N-body acceleration with patched-conic sphere-of-influence selection
- Hohmann, bi-elliptic and plane-change transfers
- Lambert's problem, single revolution
- Porkchop grids: Lambert cost over departure date × time of flight, with transfer angle and
  plane tilt per cell

The `src/sim` layer on top of it: the warp clock, the simulation state, impulsive maneuvers in
the local orbital frame, and trajectory propagation with per-burn segments and delta-v
accounting.

To try it:

```
npm ci
npm run dev        # http://localhost:5183
```

To check it:

```
npm run verify     # typecheck + lint + 449 unit tests + build
npm run test:e2e   # 26 Playwright tests against the real app
```

## Stack

TypeScript 5.9.3, Vite 8.3.8, React 19.3.1, Three.js 0.187.0, Vitest 5.1.1,
Playwright 1.65.1 — all pinned exactly, no carets, for reproducible clean clones.

The physics core has **zero runtime dependencies** and does not touch the DOM, the clock or
randomness. That is enforced by ESLint rules on `src/core/**` and `src/sim/**`, not by
convention, so the boundary cannot quietly erode (ADR-0001).

## Commands

| Command             | What it does                               |
| ------------------- | ------------------------------------------ |
| `npm run dev`       | Vite dev server on http://localhost:5183   |
| `npm test`          | unit tests (367)                           |
| `npm run test:e2e`  | Playwright end-to-end tests (17)           |
| `npm run typecheck` | `tsc` with strict settings                 |
| `npm run lint`      | ESLint, including the core-purity boundary |
| `npm run build`     | typecheck + production build               |
| `npm run verify`    | typecheck + lint + tests + build           |

All of the above pass. See `STATE.md` for the numbers from the last real run.

## Documentation

- `SETUP.md` — clean checkout to running app
- `PLAN.md` — milestones and iteration backlog
- `STATE.md` — verified current status, test inventory, known limitations
- `ARCHITECTURE.md` — layers, boundaries, and why they are where they are
- `PHYSICS.md` — every model, and the justification for every test tolerance
- `TESTING.md` — what is tested at which level, and the rules a test must follow
- `GLOSSARY.md` — orbital mechanics terms as this project uses them
- `ADR/` — the seven decisions that shaped the codebase
- `DECISIONS.md` — smaller judgment calls made without asking
- `BLOCKERS.md` — anything currently stuck

## Accuracy, honestly

Ephemerides come from JPL's approximate Keplerian elements, not a full DE ephemeris. Mars'
position carries roughly 25,000 km of error, which makes Earth–Mars transfer delta-v
indicative to a few tens of m/s rather than operational. Gravity is Newtonian point-mass:
no relativity, no J₂, no drag, no solar radiation pressure. These are documented limits,
not bugs, and they are stated in the UI wherever a number depends on them.

The porkchop plot reports the sum of the two v-infinity speeds, which is the standard
first-cut comparison and is **not** the delta-v a mission spends: it omits the Oberth effect
of departing from and capturing into a gravity well. Measured, that omission shifts the
absolute number by a few percent for Mars and Venus and by 26% for Mercury, while leaving the
ranking of windows intact (Spearman ρ ≥ 0.9997). PHYSICS.md §11.2 has the table.

## Licence

Not yet chosen.
