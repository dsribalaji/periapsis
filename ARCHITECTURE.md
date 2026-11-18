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

| Module                     | Responsibility                                                           |
| -------------------------- | ------------------------------------------------------------------------ |
| `math/vec3.ts`             | Vector algebra, rotations, the physics↔scene frame convention            |
| `math/numeric.ts`          | Bracketing, clamping, tolerance helpers                                  |
| `constants.ts`             | GM values, radii, AU, day constants. One source of truth                 |
| `time/time.ts`             | Julian date ↔ calendar, leap seconds, TT/UT1, GMST, Earth rotation angle |
| `orbit/kepler.ts`          | Kepler's equation, elliptic and hyperbolic, safeguarded Newton           |
| `orbit/elements.ts`        | Classical elements ↔ state vector, both conic families                   |
| `orbit/twoBody.ts`         | Closed-form two-body propagation                                         |
| `integrate/integrators.ts` | RK4 fixed step, Dormand-Prince RK45 adaptive                             |
| `ephemeris/solarSystem.ts` | JPL Table 1 elements, verbatim, with a citation                          |
| `ephemeris/ephemeris.ts`   | Body position/velocity from those elements                               |
| `ephemeris/nbody.ts`       | Restricted N-body acceleration, dominant-body selection                  |
| `transfer/transfers.ts`    | Hohmann, bi-elliptic, plane change                                       |
| `transfer/lambert.ts`      | Lambert's problem, single revolution, universal variables                |

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

A scenario is a starting point: epoch, start warp, focus body, camera framing. It carries no
orbital state, so it can never contradict the ephemeris. `validate.ts` checks structure and
returns a list of `{path, message}` issues rather than throwing, which is what an import error
report needs. `catalogue.ts` holds the three bundled scenarios and validates them at module
load, so a malformed built-in fails immediately instead of half-loading the app.

### `src/render` — Three.js

`scale.ts` solves two separate problems: units (metres → scene units) and dynamic range. Body
positions use a linear or logarithmic radial mapping; body _radii_ use cube-root compression so
a satellite and a star are both visible. Both are documented in the module header and in the
UI, because a compressed layout that is not labelled is a lie.

`scene.ts` owns every Three.js object and is the only place that touches WebGL. `update()`
receives positions and draws them; it never asks the simulation for anything. It also handles
picking, camera orbit/zoom, and reports which bodies are off screen at the current framing.

### `src/ui` — React

`App.tsx` owns React state and the animation-frame loop. Two structural rules:

- The `Simulation` is created once through a lazy state initialiser, not a ref mutated during
  render. It is an external system, mutated only through callbacks.
- Nothing is pushed into React state synchronously from an effect. Readouts are published at
  ~10 Hz from inside the frame callback, where updates from an external system belong.

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
