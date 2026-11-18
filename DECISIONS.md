# DECISIONS

Running log of judgment calls made without asking the user. Significant architectural
decisions also get an ADR in `ADR/`; this file records the trail of smaller calls.

Format: `## D-NNN — title` with **Choice**, **Alternatives**, **Why**.

## D-001 — TypeScript 5.9 rather than 7.x

**Choice:** pin `typescript@5.9.3`.
**Alternatives:** TS 7.0.2 (current `latest`).
**Why:** `typescript-eslint@8.73` declares a peer range of `>=4.8.4 <6.1.0`. Type-aware
linting with the core-purity boundary rules is worth more than a newer compiler. Revisit
when typescript-eslint supports TS 7.

## D-002 — Build the ESLint purity boundary

**Choice:** `no-restricted-imports` / `no-restricted-globals` / `no-restricted-properties`
rules on `src/core/**` and `src/sim/**` forbid React, Three.js, `Date.now`, `Math.random`,
`fetch`, `localStorage`.
**Why:** the spec calls the pure core a hard architectural rule. A review-only rule decays;
a lint rule fails the build.

## D-003 — React 19 + Three.js 0.187 pinned exactly

**Choice:** exact versions, no carets.
**Why:** reproducibility for the clean-clone acceptance check.

## D-004 — Graticule-only ground-track map for v1.0.0

**Choice:** 2D equirectangular graticule, no coastlines.
**Why:** the spec explicitly allows it; embedding a coastline dataset adds a licensing and
accuracy question with no physics value. Recorded in GLOSSARY/USER_GUIDE as a documented
limitation.

## D-005 — Integrator default is Dormand-Prince RK45 (adaptive)

**Choice:** RK45 adaptive is the default for restricted N-body propagation; RK4 fixed-step
is available and used for deterministic tests.
**Why:** measured accuracy per unit of work is far better near periapsis, where a
fixed-step scheme must either use a tiny global step or lose accuracy. See ADR-0004.

## D-006 — Lambert: universal variables with bisection on time of flight

**Choice:** universal-variable (Stumpff) formulation, single revolution, root found by
bisection on the time of flight rather than on the auxiliary `y` or by Newton on `z`.
**Alternatives:** Battin / Gooding (faster, much more code); plain Newton on `z`;
bracketing the sign change of `y`.
**Why:** the time of flight is strictly monotone in `z` over the valid domain and runs
from 0 to +infinity, so one bisection converges for every geometry with no initial guess
and no divergence cases. Newton on `z` needs a good guess and can step into regions where
`y < 0` (no real arc). Bracketing on `y` is not merely slower, it is wrong for long-way
arcs (`A < 0`), where `y` is positive for all `z` and the bracket search never terminates
— this was measured, not theorised. Speed is irrelevant here: the porkchop plot runs
hundreds of solves, not millions.

## D-007 — Lambert: the exactly-antipodal case is solved in closed form

**Choice:** when `1 + cos Δν < 1e-8`, bypass the universal-variable path and return the
unique elliptic answer directly: `a = (r1 + r2)/2`, speeds from vis-viva, `v2` reversed.
Report non-convergence if the requested time of flight is not within 0.1% of that
half-period.
**Alternatives:** perturb the angle by a small epsilon and continue; clamp `A` to a small
floor.
**Why:** at Δν = π the coefficient `A = sin Δν · sqrt(r1 r2 / (1 - cos Δν))` is exactly 0,
so `g = 0` and `v1 = (r2 - f r1)/g` is a 0/0 limit. Perturbing the angle does not fix it:
`sin Δν` sets the entire magnitude of `A`, so at eps = 1e-6 rad `A` collapses by ~1e-6
while `sqrt(r1 r2)` does not (measured ratio 7e-7), which produces garbage rather than a
small correction. The geometry is also genuinely over-determined: with r1 and r2
antipodal about the focus, both lie on the apse line, so they _are_ the apsides and only
one elliptic arc connects them. Verified against the independent Hohmann closed form:
2334.0 / 1434.0 m/s for 7000 km -> 42000 km about Earth, matched to 0.1 m/s.

## D-008 — Lambert: reject solutions above 0.1c

**Choice:** treat a solution as non-convergent when either speed exceeds `MAX_SPEED = 3e7`
m/s (0.1c).
**Alternatives:** return whatever the root find produces; cap the speed silently.
**Why:** the bound is about model validity, not numerics. A one-revolution arc can be made
arbitrarily fast by collapsing toward a rectilinear plunge (`h -> 0`); "1 AU in 10 seconds"
has a finite, computable answer at about 70c, and nothing diverges numerically along the way.
Without this bound the solver reports a physically meaningless answer as `converged: true`.
The threshold sits far above any real heliocentric transfer (New Horizons departed at
~16 km/s) and far below the regime where a Newtonian two-body model means anything.

## D-009 — Scenarios are data, and are validated on load

**Choice:** a scenario is a versioned object holding only an epoch, start warp, focus body
and camera framing. It stores no orbital state. Bundled entries run through
`assertScenario` at module load; external ones run through `validateScenario` and get a list
of `{path, message}` issues.
**Alternatives:** let a scenario carry explicit position vectors (more general, allows
arbitrary non-ephemeris states); validate lazily with a type guard only.
**Why:** position is a pure function of the epoch, so a scenario carrying its own vectors
could contradict the ephemeris and there would be no single source of truth to adjudicate.
Validating structure only means an invalid file can never produce a wrong orbit — the worst
case is a refusal to load. Returning field paths rather than throwing is what M7.2's import
error report needs, and it means the same function serves the bundled data, an imported file
and a test.

## D-010 — Switching scenarios resets in place rather than rebuilding

**Choice:** `Simulation.reset(epoch, warp)` mutates the existing instance; the React shell
keeps one `Simulation` for the lifetime of the app.
**Alternatives:** construct a new `Simulation` per scenario, keyed by scenario id, letting
React remount.
**Why:** the renderer and the animation-frame loop hold a reference to the simulation, and
remounting would tear down and rebuild the WebGL context to change a date. `reset` is
tested to produce state identical to a fresh construction, so the optimisation cannot drift
from the simple behaviour.

## D-011 — Scenario camera framing is stored, not inherited

**Choice:** a scenario carries `azimuthRad`, `elevationRad`, `distanceUnits` and
`centeredOn`. Loading applies all four.
**Alternatives:** only store the radial mode and let `frameAll()` pick the distance.
**Why:** "the inner system from 30 degrees above the ecliptic" is part of what makes a
scenario reproducible. Inheriting the previous camera would mean the same scenario looks
different depending on what was loaded before it. `centeredOn` exists because the two
`frameAll` distances are wrong for a pair like Earth-Moon: a 60-unit camera aimed at the Sun
shows neither body.

## D-012 — A local burn is applied in the central-body frame

**Choice:** `applyBurn` converts the heliocentric state to the spacecraft's central-body frame,
builds the local orbital frame there, applies the burn, and converts back. Only an `inertial`
node acts on the heliocentric state directly.
**Alternatives:** apply every node to the single stored heliocentric state (simplest, and what
the first implementation did); store the spacecraft state in the central-body frame permanently.
**Why:** the first implementation was wrong in a way that reads as an answer. With the burn
applied heliocentrically, "prograde" meant "along Earth's orbit about the Sun", about 90 degrees
off for a LEO satellite; a 2006 m/s Hohmann departure burn left the craft at 7,326 km instead
of reaching 26,371 km. Measured, fixed, then pinned by a regression test that asserts geocentric
speed rises by exactly the node magnitude. Storing state per central body is the other honest
option, but it forces every consumer to know which frame a point is in; converting at the single
site where a burn happens keeps one storage frame and one conversion point.

## D-013 — Trajectory is split at every burn, not sampled uniformly

**Choice:** `propagateTrajectory` builds segment boundaries from the epoch, every node time
strictly inside the horizon, and the horizon, then samples each segment. A node emits two points
at the same instant, the second flagged `afterBurn`.
**Alternatives:** sample uniformly and apply any burn that falls inside a step (so the velocity
jumps mid-segment); re-integrate from the epoch after each burn.
**Why:** uniform sampling silently rounds a burn to a sample time, which moves the burn and so
changes the answer, and it draws a smooth curve through a velocity discontinuity that genuinely
exists. Splitting puts a vertex exactly at the node and makes `afterBurn` meaningful for a plot.
Re-integrating from the epoch is quadratic in the number of burns and recomputes identical arcs;
the incremental sweep recomputes nothing.

## D-014 — A trajectory is drawn in the body-fixed frame at the scenario epoch

**Choice:** `toLocalFrame` subtracts the central body's position at the epoch from every
heliocentric sample, converts with the body's own exaggeration, and returns one group that the
scene anchors at that body's live position.
**Alternatives:** draw the trajectory heliocentrically in scene units; recompute body-relative
offsets against the body's position at each sample's own time.
**Why:** Earth moves about 25 of its own radii per LEO revolution, so a heliocentric drawing
smears a 550 km orbit off the planet into a spiral — technically the true Sun-centred path and
useless to look at. Offsets against the per-sample body position would need a vertex-by-vertex
offset every frame once the body moves, and would still render a curved line that is not an
orbit in any single frame. One epoch reference plus a group transform is a single
`position.set` per frame. The cost — a genuinely escaping craft is drawn attached to its body —
is recorded in PHYSICS.md §10.2 rather than left to be discovered.

## D-015 — Trajectory geometry is disjoint vertex pairs, not a polyline

**Choice:** `toLocalFrame` emits `LineSegments` data (six floats per segment) plus the end time
of each segment; the scene draws it twice from one geometry, splitting with `drawRange`.
**Alternatives:** a `Line`/`LineStrip` polyline plus a second geometry for the flown part; a
per-vertex colour attribute.
**Why:** duplicate vertices cost 2x the memory of a strip (a few hundred kB at the 4000-sample
cap) and buy three things: a burn can split the line without a degenerate `NaN` vertex trick, an
envelope clip can drop a point without joining the two sides, and the flown part is exactly a
prefix of the segment list so highlighting it is one integer on the shared geometry rather than
a rebuild. A per-vertex colour would also encode the split, but it moves the answer into the
shader where it cannot be asserted by a unit test; `drawRange` counts are testable facts.

## D-016 — Mission view-model is split by cost, not by concern

**Choice:** `buildMissionPlan` (one propagation + geometry conversion) runs on a scenario or node
change; `missionProgress` (a lookup against the finished plan) runs on every UI tick and every
frame.
**Alternatives:** one function that recomputes the plan whenever asked, memoised in React.
**Why:** the difference is three orders of magnitude — milliseconds against microseconds — and
the frame loop needs the cheap one at 60 Hz. The split also states the invariant explicitly:
progress is derived from the plan and can never disagree with the drawn geometry, because both
read the same `LocalFrameResult`. Memoising a single function would leave "which half is
expensive" as folklore.

## D-017 — Porkchop axes are departure date against time of flight

**Choice:** the grid is `departureJdTt × timeOfFlightDays`; arrival is derived as
`departure + TOF` and reported in the readout but is not an axis.
**Alternatives:** departure date against arrival date (the other textbook layout); time of
flight against arrival date.
**Why:** half of a rectangular date/date grid is unphysical — "arrive before you left" — so the
valid region is a triangle and either the axis ranges must be narrowed until it fills the box,
or half the plot is wasted pixels. The departure/TOF layout makes every cell a valid transfer
by construction. It also puts the _shape_ choice on an axis: a time of flight selects which arc
you fly, while a departure date is a calendar fact, so the vertical structure of the plot is
meaningful rather than an artefact of how the grid was cut. The cost is that a user thinking in
arrival dates has to read one off the hover panel; that is a lookup, not a lost capability.

## D-018 — The porkchop cost is v-infinity sum, and the panel says so

**Choice:** report `v_inf_dep + v_inf_arr` as the cell cost, and state in the panel and in
PHYSICS.md 11.2 that this is not parking-orbit delta-v and omits the Oberth effect.
**Alternatives:** convert each cell to a parking-orbit delta-v assuming a fixed departure and
capture orbit; report C3 alone; report the heliocentric delta-v.
**Why:** the conversion needs a departure orbit and a capture orbit that the grid does not
have, and inventing defaults (200 km Earth, 300 km target) would put a made-up assumption
inside a number the user reads as a budget. The measured consequence of the omission is stated
rather than hidden: the plot ranks windows to Spearman rho >= 0.9997 but overstates Mercury by
26% and understates Mars by 1%. Heliocentric delta-v would be worse still — it is off by the
whole planetary velocity, which is the thing that makes a Hohmann window exist at all.

## D-019 — The porkchop panel is collapsed by default and computes on a button

**Choice:** the tool starts collapsed, expands on a toggle, and computes only when "Compute
plot" is pressed.
**Alternatives:** always expanded; recompute on every field edit.
**Why:** expanded, the panel adds about a thousand pixels to a sidebar that is already
scrollable, which pushed the body list — a thing every user needs — off the bottom of the
screen. And a 100x100 grid is 10,000 Lambert solves (~82 ms) which, keyed to a form that
changes on every keystroke, would run on each character typed. Measuring the sidebar height
(2083 px open against a 860 px viewport) is what turned this from a hunch into a fix. The last
successful plot is also kept while the form is edited, so comparing two windows does not blank
the picture.
