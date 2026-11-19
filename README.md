# Periapsis

An offline orbital mechanics sandbox and mission designer. Runs entirely in the browser,
needs no account, no server and no network at runtime.

**Status: in development.** The physics core is complete and tested (664 unit tests); the 3D
application shell runs with scenario loading, mouse camera control, time controls and a working
mission layer - a spacecraft flies a planned path drawn in the view, with maneuver nodes and a
delta-v budget. A porkchop plot finds interplanetary launch windows by solving Lambert's problem
over a grid of departure dates and flight times, and a chosen cell can be turned into a real
departure burn on the spacecraft's parking orbit. A ground-track panel projects the sub-satellite
path onto a 2D world map, and a scenario can be saved in the browser or written to a JSON file and
opened again. The node _editor_ (edit/delete) and the arrival half of a transfer are not built yet.
See `STATE.md` for what actually runs today and `PLAN.md` for the milestone backlog.

## What works today

The app: a 3D solar-system view with a draggable, zoomable camera, seven bundled scenarios, a
warp clock from 1× to 10⁷×, an inspector, a mission panel showing a craft's trajectory, altitude
and delta-v budget as the clock advances, a porkchop plot with a hover readout, and a 2D
ground-track map with a live sub-satellite marker. Click a cell
and press "Plan departure" and the cell becomes a maneuver node on the craft — the real impulsive
burn out of its parking orbit, with the Oberth effect, the plane-change penalty the geometry
forces, and the timing shift onto the cheapest point of the orbit all reported rather than
assumed.

The scenario in use is remembered in the browser, so a reload returns to it instead of the
default, and it can be downloaded as a JSON file and opened again - by hand-editing the file you
can fork a bundled scenario, and a bad file is refused with the field that failed rather than with
"invalid". Nothing leaves the machine: storage is `localStorage` on the page's own origin, and the
file is written by a `Blob` download.

The seven scenarios are two system views, a 550 km orbit with a raise node, a full GTO-to-GEO
transfer whose apogee burn combines its plane change with its circularisation (4,258 m/s, saving
1,151 m/s against doing the two separately), a 300 km, 51.6-degree park with the 2028 Mars window
one porkchop click away, and a lunar free return: one 3,115 m/s burn from a 300 km park that goes
around the far side of the Moon at 2,694 km altitude and comes back to Earth at 686 km with no
second burn.

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
- Departure burns from a parking orbit: closed-form hyperbola solve, phase search, Oberth
  crossover, plane-change penalty
- Ground track: heliocentric → Earth-relative → equatorial (obliquity) → Earth-fixed (GMST), with
  geocentric latitude and an antimeridian break per segment
- Restricted N-body propagation to the Moon and back: the free-return trajectory is integrated
  through the lunar flyby rather than patched together from conics

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
npm run verify     # typecheck + lint + 664 unit tests + build
npm run test:e2e   # 62 Playwright tests against the real app
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
| `npm test`          | unit tests (664)                           |
| `npm run test:e2e`  | Playwright end-to-end tests (62)           |
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

The departure half of that gap is closed in the app: a planned departure costs the real burn
from the parking orbit, so it is a different number from the cell's. On the default Earth-Mars
window the cheapest cell needs 3.03 km/s of departure v-infinity; the burn from a 300 km
equatorial park costs 6.58 km/s, of which 3.62 is the in-plane floor and the rest is the plane
change the geometry forces (PHYSICS.md §12.4). Note the direction: at 3.03 km/s the excess speed
is _below_ the Oberth crossover of 3.86 km/s, so the floor is already above the cell's number and
the Oberth effect is working against the mission, not for it. The arrival half is **not** closed:
capture is still just the cell's arrival v-infinity, because a craft in this model has one
central body and patched conics are not in v1.0.0.

## Licence

Not yet chosen.
