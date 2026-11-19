# ARCHITECTURE

How the code is organised, and why the boundaries are where they are.

## The one rule everything else follows

**Physics does not know that a screen exists, and the screen does not know any physics.**

`src/core` and `src/sim` are pure TypeScript with zero runtime dependencies. They never import
React or Three.js, never read the wall clock, never touch `Math.random`, never `fetch`. That
is not a style preference: it is what makes the physics replicable, unit-testable in Node with
no DOM, and impossible to silently corrupt by a rendering refactor.

The rule is enforced by ESLint (`no-restricted-imports`, `no-restricted-globals`,
`no-restricted-properties` on `src/core/**` and `src/sim/**`), so a violation fails
`npm run verify` rather than surviving review. See D-002.

## Layers

```
index.html
  └── src/main.tsx            React root
        └── src/ui/           React components, all DOM and event handling
              └── src/render/ Three.js scene, camera, picking, drawing
                    └── src/sim/    clock, simulation driver, scenarios
                          └── src/core/  physics: no I/O, no side effects
```

Dependencies point downward only. `src/core` imports nothing from the layers above it; a
violation is a lint error.

### `src/core` — physics

| Module                       | Responsibility                                                           |
| ---------------------------- | ------------------------------------------------------------------------ |
| `math/vec3.ts`               | Vector algebra, rotations, the physics↔scene frame convention            |
| `math/numeric.ts`            | Bracketing, clamping, tolerance helpers                                  |
| `constants.ts`               | GM values, radii, AU, day constants. One source of truth                 |
| `time/time.ts`               | Julian date ↔ calendar, leap seconds, TT/UT1, GMST, Earth rotation angle |
| `orbit/kepler.ts`            | Kepler's equation, elliptic and hyperbolic, safeguarded Newton           |
| `orbit/elements.ts`          | Classical elements ↔ state vector, both conic families                   |
| `orbit/twoBody.ts`           | Closed-form two-body propagation                                         |
| `integrate/integrators.ts`   | RK4 fixed step, Dormand-Prince RK45 adaptive                             |
| `ephemeris/solarSystem.ts`   | JPL Table 1 elements, verbatim, with a citation                          |
| `ephemeris/ephemeris.ts`     | Body position/velocity from those elements                               |
| `ephemeris/nbody.ts`         | Restricted N-body acceleration, dominant-body selection                  |
| `transfer/transfers.ts`      | Hohmann, bi-elliptic, plane change                                       |
| `transfer/lambert.ts`        | Lambert's problem, single revolution, universal variables                |
| `transfer/porkchop.ts`       | Grid of Lambert costs over departure date × flight time, cell asymptotes |
| `transfer/departure.ts`      | Closed-form burn from a parking orbit onto a given hyperbola             |
| `groundTrack/groundTrack.ts` | Ecliptic→equatorial→Earth-fixed lat/lon, antimeridian breaks             |

Everything here is a pure function unless it is documented otherwise. Orbits are parameterised
by time, not by "now".

### `src/sim` — state and time

`clock.ts` maps real elapsed milliseconds to simulation seconds at a warp factor, with a fixed
step size and a per-frame step budget. It is a value object: the caller passes the frame time
in, so results are reproducible and the module is testable without a timer.

`simulation.ts` owns the epoch, exposes the current Julian date (UTC and TT), and derives body
positions from the ephemeris. It is the only mutable stateful object in the lower layers, and
it is mutated only through its own methods.

The clock's three invariants — warp means sim-seconds-per-real-second, step size does not
depend on frame rate, and the step budget costs accuracy rather than dropping time — are
stated in the module header and each is covered by a test.

### `src/scenarios` — data, validated

A scenario is a starting point: epoch, start warp, focus body, camera framing, and optionally a
mission. It carries no orbital state, so it can never contradict the ephemeris. `validate.ts`
checks structure and returns a list of `{path, message}` issues rather than throwing, which is
what an import error report needs. `catalogue.ts` holds the seven bundled scenarios and validates
them at module load, so a malformed built-in fails immediately instead of half-loading the app.

The mission field follows the same principle one level down: a spacecraft is an orbit
_parameterisation_ (central body, altitude, inclination, phase) resolved by `craftFromSpec`, not a
position/velocity pair. "550 km at 53°" is a claim a reader can check; `r = (6771000, 0, 0)` is
not, and it can silently contradict the scenario that contains it.

The same rule governs the maneuvers. `lunar-free-return` writes its translunar burn as `a: 3115`
in the `local` frame, so the prograde direction comes from `circularOrbitFrame` like every other
node; hand-computing inertial components would be a second definition of the parking triad, which
is what D-020 exists to prevent. Its non-obvious numbers - the 5° inclination, the 255° phase, the
epoch - are all measured, and the measurements are in PHYSICS.md §14 next to the reasoning that
produced them rather than in the scenario file as a comment nobody re-checks.

### `src/render` — Three.js

`scale.ts` solves two separate problems: units (metres → scene units) and dynamic range. Body
positions use a linear or logarithmic radial mapping; body _radii_ use cube-root compression so
a satellite and a star are both visible. Both are documented in the module header and in the
UI, because a compressed layout that is not labelled is a lie.

`trajectoryLines.ts` is pure geometry: it converts a heliocentric trajectory into body-centred
scene units using the same exaggeration the body's own radius uses, and emits disjoint vertex
pairs in time order. "Body-centred" means the body's position **at each sample's own time**, which
is the one anchoring that is correct: the group transform then adds the body's live position back,
so subtracting the epoch position instead would count the body's travel twice. That mistake is
what M5.5 fixed (D-032, PHYSICS.md §10.2), and it is why the module's regression tests include a
craft that never moves relative to its body, which must therefore draw as a single point. Being
pure, this module is unit-tested directly rather than through a screenshot. The two
frame-and-scale decisions it makes are recorded in PHYSICS.md §10 and D-014/D-015/D-032.

`scene.ts` owns every Three.js object and is the only place that touches WebGL. `update()`
receives positions and draws them; it never asks the simulation for anything. It also handles
picking, camera orbit/zoom, the drawn trajectories and the craft marker.

### `src/ui` — React

`App.tsx` owns React state and the animation-frame loop. Three structural rules:

- The `Simulation` is created once through a lazy state initialiser, not a ref mutated during
  render. It is an external system, mutated only through callbacks.
- Nothing is pushed into React state synchronously from an effect. Readouts are published at
  ~10 Hz from inside the frame callback, where updates from an external system belong.
- The mission plan is derived with `useMemo` from the scenario, and its expensive half is not
  recomputed per frame. The frame loop reads it through a ref that is synced in an effect —
  writing a ref during render is what makes a ref and the committed tree disagree when React
  discards a render, and the lint rule against it is correct.

`missionView.ts` holds the mission view-model, split by cost: `buildMissionPlan` propagates once
per scenario or node change, and `missionProgress` answers "where is it now, what has it spent"
from the finished plan. `MissionPanel.tsx` is presentational and computes nothing.

`porkchopView.ts` is the same split for the transfer plot: the colour ramp, the RGBA image
buffer, the pointer-to-cell mapping, the axis ticks, the hover readout and the summary sentence
are all pure and unit-tested, and `PorkchopPanel.tsx` owns only the canvas, the form and the
`putImageData` call. A canvas is the one part of the app a unit test cannot reach, so the rule is
that nothing which could be wrong lives inside it. The buffer is one pixel per grid cell and the
browser scales it, which makes the painting a single call and the orientation a testable fact
(see PHYSICS.md §11.4).

`transferView.ts` is the join between the plot and the mission, and it is a view-model for the
same reason: the frame conversion, the cost conversion, the timing shift and the horizon decision
are arithmetic that must be asserted without a browser. It sits above `src/sim` because it needs
`circularOrbitFrame` and the `Maneuver` type, and `core/transfer/departure.ts` sits below both
because it needs nothing but vectors.

`groundTrackView.ts` and `GroundTrackPanel.tsx` follow the same rule one layer down. The
projection, the polyline splitting at the antimeridian and after a gap, the marker interpolation,
the summary and the Bresenham-painted RGBA buffer are all pure and unit-tested; the panel owns the
canvas, one `putImageData`, the DOM marker and the readouts. This is the third instance of the
split, which is the point: a canvas is the one part of the app a unit test cannot reach, so nothing
that could be wrong may live inside it. The map canvas is 2D, so its e2e test reads it back with
`getImageData` directly rather than decoding a screenshot.

The ground track's two line-break rules are computed in the core module, not here: the antimeridian
flag sits next to the longitude wrap (D-031), and `startsAfterGap` sits next to the `continue` that
drops an undefined sample (D-034). The renderer is told where its line breaks; it never infers a
break from spacing, which would confuse a sparse track with a hole.

The split between the two is where the _question_ changes. `departure.ts` answers "what burn
leaves this orbit on that asymptote, and where on the orbit" — a physics question with a
physics answer. `transferView.ts` answers "what node does that make, in this mission, on this
scenario's clock, and does it fit" — a scheduling question that has to know about epochs,
horizons and node ids. Putting the second inside the first would make the physics module depend
on the mission's bookkeeping; putting it inside `App.tsx` would make it untestable.

`core/transfer/porkchop.ts` is the grid itself: it must not import `src/sim` (the dependency
direction is sim → core), so the central-difference body velocity is duplicated rather than
shared. That duplication is deliberate and commented in both places.

The parking-orbit frame is defined once, as `circularOrbitFrame` in `sim/craft.ts`. The transfer
code consumes it rather than deriving the same triad again — a second derivation is how the orbit
normal ended up with the wrong sign (D-020), and the failure was a mirrored burn rather than a
crash.

## Frame convention

Physics uses a right-handed frame with +z toward the ecliptic north pole. Three.js has +y up.
The mapping is `(x, y, z)_physics → (x, z, −y)_scene`, which keeps the ecliptic in the scene's
xz plane and preserves handedness, so orbital motion stays counter-clockwise viewed from above
instead of appearing mirrored. It is defined once, in `scale.ts`.

## Determinism

The same inputs must produce the same numbers on any machine, every run:

- No `Date.now()`, no `Math.random()`, no ambient state in the physics layers.
- The starfield uses a fixed lattice hash rather than random points, so screenshots are
  stable.
- Integrators are fixed-step where tests need reproducibility; the adaptive integrator is
  used where accuracy per unit of work matters more.
- `Simulation.reset()` is tested to produce state identical to a fresh construction.

## Error handling

A failure in the 3D layer must not take the rest of the app with it. If WebGL cannot start,
the scene constructor throws, `App.tsx` catches it, and the error is published through the
frame loop and rendered as a message in the viewport. Time controls, readouts and the body
list keep working — they need no GL.

Scenario validation is the other case: invalid input produces a list of issues, never a
partially applied scenario.
