# Changelog

All notable changes to Periapsis. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-11-19

The first release. An offline orbital mechanics sandbox and mission designer that runs in the
browser with no account, no server and no network at runtime.

### Added

**Physics core** (`src/core`, zero runtime dependencies, enforced by ESLint)

- Vector algebra, angle and time systems: Julian date, leap seconds, GMST, Earth rotation angle.
- Classical orbital elements to and from state vectors, for elliptic and hyperbolic orbits.
- Kepler's equation solved for both eccentricity regimes.
- Closed-form two-body propagation.
- RK4 and Dormand-Prince RK45 integrators, with the RK45 step controller as the default for
  trajectory work (ADR-0004).
- Solar-system ephemerides from JPL's approximate Keplerian elements (Table 1).
- Restricted N-body acceleration with patched-conic sphere-of-influence selection (ADR-0003).
- Hohmann, bi-elliptic and plane-change transfers.
- Lambert's problem, single revolution, with a stated validity envelope (ADR-0005).
- Porkchop grids: Lambert cost over departure date by time of flight, with transfer angle and
  plane tilt per cell.
- Departure burns from a parking orbit: closed-form hyperbola solve, phase search onto the
  cheapest point of the orbit, Oberth crossover detection, and the plane-change penalty the
  geometry forces.
- Ground track: heliocentric to Earth-relative to equatorial to Earth-fixed, with geocentric
  latitude and an antimeridian break per segment.
- Restricted N-body propagation to the Moon and back, integrated through the lunar flyby.

**Simulation layer** (`src/sim`)

- A warp clock from 1x to 10^7x, deterministic and free of `Date.now` and `Math.random`.
- Impulsive maneuvers applied in the local orbital frame.
- Trajectory propagation with per-burn segments and delta-v accounting.
- Mission progress reporting (applied / next / pending) for a craft along its plan.

**Application**

- A 3D solar-system view with a draggable, zoomable camera, drawn at true and at compressed
  radial scale (ADR-0002).
- Seven bundled scenarios: inner system, whole system, Earth-Moon, a 550 km orbit with a raise
  node, a full GTO-to-GEO transfer, a 300 km 51.6-degree park with the 2028 Mars window, and a
  lunar free return.
- An inspector panel for the selected body and a mission panel showing trajectory, live
  altitude and a delta-v budget as the clock advances.
- A porkchop plot with a hover readout, and a "Plan departure" action that turns a chosen cell
  into a real burn out of the craft's parking orbit.
- A 2D ground-track map with a live sub-satellite marker.
- Scenario persistence: the scenario in use is remembered across reloads, can be downloaded as
  JSON and opened again, with old files migrated forward and a bad file refused by naming the
  field that failed rather than saying "invalid" (ADR-0007, D-037, D-038).

**Accessibility**

- Full keyboard operation: a skip link, a focusable sidebar, native buttons in a real list for
  the body selector, and a keyboard guard so Space on a focused control does not also toggle
  the clock (D-039).
- `role="img"` with a descriptive label on the 3D viewport and both 2D canvases, including a
  generated summary of the ground track.
- Polite live-region announcements for pause and warp, deliberately never announcing the
  ticking clock.
- Reduced-motion support that disables transitions and animations while leaving the clock
  running, because stopping the simulation would change the physics rather than the motion.
- Text and accent colours at or above WCAG AA against every background they are used on; the
  contrast table is in `TESTING.md`.

**Documentation**

- `README.md`, `SETUP.md`, `ARCHITECTURE.md`, `PHYSICS.md`, `TESTING.md`, `STATE.md`, `PLAN.md`,
  `PERFORMANCE.md`, `GLOSSARY.md`, `DECISIONS.md`, `BLOCKERS.md`, and seven ADRs in `ADR/`.
- `PHYSICS.md` states a justification for every numerical tolerance a test asserts.

### Measured

Verified on the development machine (i5-10310U, Node 24.22.0, headless Chromium 141 with
SwiftShader); numbers and method are in `PERFORMANCE.md`.

- 667 unit tests across 29 files; 62 Playwright end-to-end tests against the real app.
- Production bundle: 860.96 kB JavaScript (235.42 kB gzip) and 7.38 kB CSS (2.13 kB gzip).
- A clean clone installs from the lockfile in 27 s (201 packages, 0 vulnerabilities) and builds
  byte-identical output.
- Frame work costs 49-150 microseconds per frame, under 1 % of a 60 Hz budget at every warp
  setting. Frame rate is rasteriser-bound, not script-bound: every scenario holds 60 fps at
  320x200 and 30 fps at 1280x800 with zero long tasks.

### Known limitations

Stated here because they are design limits, not defects, and each is documented at the point of
use in the UI.

- Ephemerides use JPL's approximate elements, not a full DE ephemeris. Mars' position carries
  roughly 25,000 km of error, which makes an Earth-Mars transfer delta-v indicative to a few
  tens of m/s rather than operational.
- Gravity is Newtonian point-mass only: no relativity, no J2, no drag, no solar radiation
  pressure, and the massive bodies are not themselves integrated (ADR-0003).
- A craft has one central body. Patched conics are not implemented, so the arrival half of an
  interplanetary transfer is not closed: capture is the cell's arrival v-infinity.
- The porkchop cost is the sum of the two v-infinity speeds, not the delta-v a mission spends.
  The departure half of that gap is closed by the departure-burn model; the arrival half is not.
- The porkchop uses single-revolution Lambert arcs only.
- Burns are impulsive. Finite burns are not implemented.
- The ground-track map is a graticule with no coastlines (D-004).
- Impact detection tests the craft against the central body's radius only, so a lunar impact is
  not flagged.
- The lunar free-return scenario is a measured, epoch-locked trajectory at one burn magnitude
  with no runtime solver; it is tuned, not searched (D-036).
- Touch input is limited to what the browser gives a mouse-only camera: pinch-to-zoom is not
  implemented.
- The node editor (edit and delete an existing node) is not built. A node can be created and
  re-created, but not edited in place.
- No licence has been chosen yet.

### Not included

- Finite (non-impulsive) burns.
- Coastline map data.
- Full N-body integration of the massive bodies.
- Any server, account, telemetry or network access at runtime.
