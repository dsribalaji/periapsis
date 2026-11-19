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

## D-014 - A trajectory is drawn body-relative, in the central body's frame

> **Amended in M5.5 (see D-032).** The _reason_ below is unchanged and still correct: the frame
> must be body-relative. The _implementation_ it describes — subtracting the body's position at
> the epoch — was wrong, and drew the 550 km LEO orbit as a 343,390 km streak. The subtraction is
> now per sample. Kept in place rather than superseded because the argument for a body-relative
> frame is the argument D-032 relies on.

**Choice:** `toLocalFrame` subtracts the central body's position **at each sample's own time**
from every heliocentric sample, converts with the body's own exaggeration, and returns one group
that the scene anchors at that body's live position.
**Alternatives:** draw the trajectory heliocentrically in scene units; subtract the body's
position at the epoch (the original, wrong version); recompute vertex offsets in the scene every
frame.
**Why:** Earth moves about 25 of its own radii per LEO revolution, so a heliocentric drawing
smears a 550 km orbit off the planet into a spiral - technically the true Sun-centred path and
useless to look at. The subtraction must be per sample because the group transform then adds the
body's _live_ position back: subtracting the epoch position instead counts the body's own
displacement twice, once as a subtraction that never happens and once as a translation that does.
Recomputing the offsets inside the scene every frame was the alternative that made the epoch
anchor attractive, but it is unnecessary — the offsets are body-relative, so they are fixed once
at plan time and the group transform alone places them. The cost - a genuinely escaping craft is
drawn attached to its body - is recorded in PHYSICS.md §10.2 rather than left to be discovered.

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

## D-020 — The parking-orbit frame is defined once, in `sim/craft.ts`

**Choice:** `circularOrbitFrame(orbit, phase)` returns the radial/prograde/normal triad and is the
only definition of that geometry. `circularOrbitState` builds the epoch state from it and
`ui/transferView.ts` builds the departure burn from it.
**Alternatives:** a local helper in the transfer module; passing the three vectors in from the
caller.
**Why:** the hand-written normal used in the first transfer implementation was `(0, sin i, cos i)`
and its **sign was wrong**. For the basis `p = x̂`, `q = (0, cos i, sin i)` that
`circularOrbitState` uses, `r × v` is `(0, −sin i, cos i)`. The consequence was not cosmetic: the
normal component of the burn was mirrored, so the node list and the propagator disagreed about
what the node meant, and every inclined departure was silently planned against the wrong plane.
Two derivations of one geometry is how that happens; one function is how it stops.

## D-021 — `TransferContext` takes the whole `CircularOrbitSpec`, phase included

**Choice:** the context carries `orbit: CircularOrbitSpec`, not a separate `orbitPhaseRad`.
**Alternatives:** altitude + inclination + a phase argument.
**Why:** the phase is the same number `craftFromSpec` uses. Splitting it out lets a caller build a
node for a craft sitting somewhere its own description does not put it, and the resulting burn
would be at the right radius and the wrong place - the failure mode is invisible in a number and
obvious in a picture nobody is looking at during a test.

## D-022 — Node timing uses the craft's own accumulated phase

**Choice:** `phaseAtRequest = orbit.phaseRad + n·(t_departure − t_epoch)`, then
`shiftSeconds = wrapTo2Pi(plan.phaseRad − phaseAtRequest)/n`.
**Alternatives:** use `plan.timeToBurnSeconds` directly (the phase from the epoch).
**Why:** the solve's phase is measured from the epoch radial, but the craft is not there when the
departure date arrives. Measured on a 314-day Earth-Mars cell at 300 km, the orbit has advanced
3.1e4 rad, so the naive answer places the node at a phase unrelated to the one that was costed,
and the flown trajectory is not the one the plot drew. The correct answer is a forward difference
around a circle, which is why it is a `wrapTo2Pi` and not a subtraction.

## D-023 — A below-surface periapsis is a warning on the node, not a refusal

**Choice:** `periapsisBelowSurface` becomes a `below-surface` warning in `TransferNode.warnings`
and is shown in the panel; the node is still created.
**Alternatives:** refuse the departure; ignore the condition.
**Why:** the arithmetic says the path is safe - the burn is outbound at radius `r`, the true
anomaly is positive, and the radius only grows afterwards, so the propagated arc never enters the
body (confirmed: the bundled mission reports no impact). But no real departure would be accepted
with a periapsis inside the planet, so the condition is real. Refusing hides the geometry that
produced it; silence lets a reader see "periapsis 5,893 km" beside "burn at 6,671 km" and conclude
the code is broken.

## D-024 — The mission is React state, not derived from the scenario

**Choice:** `useState<CraftSpec | undefined>`, reseeded from the scenario on every switch.
**Alternatives:** derive the mission from the selected scenario each render.
**Why:** a planned departure writes a node into the mission, and a derived value cannot be
written. Keeping the scenario as the seed and the state as the truth also makes the reset
explicit: switching scenarios discards a planned node, which is what a scenario switch means.

## D-025 — A departure past the horizon extends the plan, or is refused with a reason

**Choice:** `applyDepartureNode` extends `horizonSeconds` to `burnTime + DEPARTURE_COAST_SECONDS`
(one day) rather than dropping a node the propagation would not reach. It **refuses** N-body
plans and anything past `MAX_DEPARTURE_HORIZON_DAYS = 1500`.
**Alternatives:** leave the horizon alone and let the node be dropped; extend unconditionally.
**Why:** `propagateTrajectory` drops burns after the horizon, so leaving it alone would list a
burn the trajectory never makes - a panel contradicting its own picture. Extending
unconditionally is worse in two specific ways: months of N-body integration at millisecond
tolerances is far outside an interactive budget, and a 4000-day horizon of a 96-minute orbit is
a wall of aliased dots. 1500 days covers every Earth-Mars window (780 d) and three Venus synodic
periods.

## D-026 — A planned departure replaces a node with the same id

**Choice:** the id is `depart-YYYY-MM-DD`, derived from the cell's departure date; `withManeuver`
filters out any node with that id before appending.
**Alternatives:** append and let the user delete duplicates; generate a unique id per plan.
**Why:** re-planning the same cell after changing a form field must be idempotent, or the user
ends up with two identical burns at the same instant and a delta-v budget that counts both.
Deriving the id from the date rather than from a counter also makes it deterministic across
sessions, which is what a scenario file needs.

## D-027 — The departure action acts on the clicked cell, not the hovered one

**Choice:** clicking the plot selects a cell (`chosen`); the button acts on `chosen`, and the
readout shows `hovered ?? chosen`.
**Alternatives:** act on the hovered cell.
**Why:** a pointer cannot rest on the plot and press a button below it. Moving to the button
raises `pointerleave`, which clears the hover - so a hover-driven button is disabled exactly as
the user reaches for it. Measured in the e2e suite before the fix: the button was disabled on
every attempt. A click is a selection and survives the pointer leaving.

## D-028 — The default departure window starts at the epoch, not at the year start

**Choice:** `defaultPorkchopRequest` starts at `epochDateIso(epochUtc)` and runs to the end of the
epoch year + 2.
**Alternatives:** 1 January of the epoch year (the previous behaviour); a window centred on the
epoch.
**Why:** a departure window that begins in the past is a trap. The plot computes those cells (the
Lambert solve does not know what "now" is) but none can become a manoeuvre node, because a node
at a negative time does not exist. Measured on the 2026-11-18 epoch: a year-start window put 322
of 365 departure columns in the past, **and the cheapest cell of the whole grid was one of them** -
so the headline number of the default plot was unplannable. Starting at the epoch makes every
column a candidate. The end date is unchanged, so the window still contains at least one Mars
window (780 d) and three Venus windows (584 d).

## D-029 — Sampling adequacy is a number in the panel, not a caveat in the docs

**Choice:** `MissionPlan` carries `periodFractionPerSample` (fraction of an initial period per
drawn sample) and `coastAliased`, with `ALIASED_PERIOD_FRACTION = 0.125`; `MissionPanel` shows a
caveat when it trips.
**Alternatives:** raise `MAX_TRAJECTORY_POINTS` so a long horizon stays dense; say nothing.
**Why:** a planned departure extends a mission's horizon to hundreds of days while the parking
orbit laps every 96 minutes, so a 735-day plan draws one sample per 2.77 orbits. The propagated
states are exact; the **picture** is a star polygon. Raising the point cap is not available
(4000 points over 735 days is still 0.44 of a period per sample, and the cap exists for the
renderer's sake). Making it a number that appears only when it matters is the honest option:
measured 0.010 for the bundled LEO raise (dense) and 2.772 for the planned departure (aliased).

## D-030 — Ground-track latitude is geocentric, and the obliquity is applied

**Choice:** `buildGroundTrack` reports **geocentric** latitude (the spherical latitude of the
radius vector) and applies the full ecliptic→equatorial rotation by `OBLIQUITY_J2000` before
the GMST rotation.
**Alternatives:** report geodetic (ellipsoid) latitude; skip the obliquity and treat the
ecliptic frame as equatorial; report latitude relative to the ecliptic.
**Why:** the two errors are not comparable in size, which is what makes the mixed choice
correct rather than arbitrary. **Skipping the obliquity is a 23.44° error** — it would report a
satellite in an ecliptic-plane orbit as permanently over the equator, and the ecliptic pole as
66.56° latitude. **Geodetic latitude is a 0.19° error** (≈21 km at the equator). PHYSICS.md
§10.4 deferred the obliquity correction to M6 explicitly, so applying it here closes that
deferral rather than adding a new caveat. Geodetic is _not_ corrected because the v1 map is a
graticule with no coastlines (D-004): 21 km is under a coarse pixel, so an ellipsoid would be
code without truth. Both are stated in PHYSICS.md §13.2 instead of being left to be discovered.

## D-031 — The antimeridian break is computed next to the wrap, not by the renderer

**Choice:** `GroundTrackSample.crossesAntimeridian` is set by `buildGroundTrack` on the sample
that ends a segment whose longitude wraps from +π to −π, and an undefined sample (craft at the
Earth's centre) clears the previous longitude so no crossing is claimed across the gap.
**Alternatives:** let the 2D renderer compare consecutive longitudes and split there; normalise
longitudes to be continuous ("unwrapped") and let the map clip.
**Why:** an unbroken polyline through a wrap draws a line the full width of the map, which is
the standard ground-track rendering bug and reads as the satellite teleporting. Putting the
decision in the renderer means it lives in a canvas that cannot be unit-tested (TESTING.md);
putting it here makes it a value a test asserts — the suite requires exactly one crossing in a
chosen full-day sweep, with the two straddling longitudes more than π apart, so a flag that is
simply always false fails. Unwrapping the longitudes instead would push the problem into every
downstream consumer that wants a real longitude for a readout.

## D-032 — A trajectory is drawn body-relative per sample, not epoch-relative

**Choice:** `toLocalFrame` subtracts `bodyPosition(centralBody, epoch + t)` for **each sample's own
time**, then the scene anchors the whole group at the body's live position.
**Alternatives:** subtract the body's position at the epoch (the behaviour until M5.5); draw
heliocentrically; recompute vertex offsets in the scene every frame.
**Why:** the epoch-relative version is not an approximation of the right thing, it is a different
quantity. The group transform adds the body's _live_ position back, so the body's own displacement
over the horizon was counted twice — once as a subtraction that did not happen, once as a
translation that did. This was recorded as intentional in DECISIONS D-014 and PHYSICS §10.2, and
it survived four milestones because it produces a _plausible_ picture at LEO: a streak through the
orbit that reads as a trail. Measured on the bundled 550 km orbit, the drawn extent was 64.68 units
for a 1.35-unit orbit — 343,390 km of path for a 7,152 km orbit. What made it a defect rather than
a cosmetic issue is that the live radius readout is derived from the drawn frame, so the panel
showed "Radius now 343,389.8 km" directly above "Apoapsis 7,151.9 km". The fix costs one
`bodyPosition` call per sample (4-8 ms at 4,000 samples) against a propagation that already does
two per sample. D-014's stated _reason_ still holds and is unchanged: the frame must be
body-relative. Only its _implementation_ was wrong, so D-014 is amended in place rather than
superseded.

## D-033 — The two departure scenarios carry measured burns, and the tests re-derive them

**Choice:** `gto-transfer` and `earth-mars-departure` hard-code their nodes' components, and
`tests/scenario.test.ts` recomputes each one from `hohmannTransfer` and the circularisation
geometry rather than asserting the file's own numbers.
**Alternatives:** build the scenarios from the solver at module load; assert only that the
scenario validates.
**Why:** a scenario is data, and data cannot call a solver — so the numbers have to be literals.
But a literal that nothing re-derives is a measurement that goes stale silently the moment the
physics changes, and the failure is a scenario that still loads and still draws, just with a burn
that no longer reaches where it says. The GTO numbers are checkable against a closed form
(`2 v sin(i/2)` for the plane change, vis-viva for the apogee speed), so the test recomputes both
the prograde and normal components and also asserts the _saving_ - 1,151 m/s, bounded to
1,000-1,300 - because that saving is the entire point of the scenario. A scenario whose lesson
has quietly evaporated is worse than no scenario.

## D-034 - The ground-track core records where a gap is, and the renderer is told

**Choice:** `GroundTrackSample` carries `startsAfterGap`, set by `buildGroundTrack` on the first
sample after one or more dropped undefined samples. `trackPolylines` and `groundPointAt` break on
it.
**Alternatives:** have the renderer infer a gap from an unusually large time step; join across the
gap and draw a dashed line; drop the whole segment.
**Why:** the renderer cannot know where a gap is. It sees a list of samples; the information that
one of them was dropped lives only in the code that dropped it. The obvious workaround — compare
consecutive time spans against the median and call anything over 1.5x a gap — is a heuristic that
fails exactly when it matters: a two-sample track has no median at all, and a legitimately sparse
track (a high-altitude coast sampled every few hours) looks identical to a hole. This was found by
a test, not by inspection: the synthetic two-point gap case could not be detected by spacing and
passed through `trackPolylines` as one continuous line. Computing the flag next to the `continue`
that drops the sample is the same principle as D-031 (compute the antimeridian break next to the
wrap): the module that creates the discontinuity is the module that labels it.

## D-035 - The map altitude and the panel altitude differ by one chord sagitta

**Choice:** the ground-track panel's live altitude (from the nearest propagated sample) and the
mission panel's live altitude (from the drawn, linearly interpolated geometry) are allowed to
differ by up to one chord sagitta, and the test asserts that bound rather than equality.
**Alternatives:** derive both from the same source so they agree exactly; loosen the test to a
round number.
**Why:** they genuinely measure different things. The map reports the true radius at a sample
instant; the mission panel's radius comes from the drawn frame, whose vertices are connected by
straight lines, so between samples it reports the chord radius, which is systematically inside the
arc. The gap is `s = r(1 - cos(θ/2))` with `θ = arc/r`. Measured on the bundled LEO plan: 59.18 s
per sample, 449 km of arc, θ = 0.0628 rad, predicted 3,526 m, observed worst case 3,642 m at
550 km — 0.05%. Making them equal would mean either degrading the map to chord geometry or
drawing the 3D path as a dense arc, and both are worse than a stated 3.6 km. The reason it is
worth a decision rather than a comment is that the difference _looks_ like the D-032 class of
frame bug, and the test has to be able to tell them apart: D-032 was 343,390 km, this is 3,642 m,
and it shrinks with sample spacing rather than with a code change.

## D-036 - The free-return scenario is measured, epoch-locked, and RNG-free

**Choice:** `lunar-free-return` is one prograde 3,115 m/s node at T+0 on a 300 km, 5° park with
phase 255°, propagated N-body over a 9-day horizon at the Earth-Moon epoch
`2027-04-07T12:00:00Z`. It produces a lunar flyby at 2,694 km of altitude at T+3.27 d and a
return to 337 km at T+6.36 d.
**Alternatives:** solve the free return at runtime from a target lunar periapsis (a real shooting
method, and the honest general answer); ship it as a two-body Earth ellipse that merely reaches
lunar distance (it would load, draw, and be wrong); let the user aim it from the porkchop.
**Why:** the numbers are _measured_, every one of them, and re-derived where they can be. The burn
is checked against vis-viva (the resulting apogee must clear the Moon), the flyby and return are
propagated from the scenario's own spec, and the sensitivity is asserted rather than described.
Three properties make this scenario unusual enough to be worth a decision:

- **The epoch is load-bearing.** The Moon's phase at the epoch is what makes a single prograde
  burn return the craft. Moving the epoch a day moves the encounter entirely. That is not a defect
  to be fixed with a search — it is the physics of a free return, and it is why the scenario is
  pinned to the same epoch as `earth-moon` rather than a round number.
- **The inclination is tuned, not merely small.** 5° works; 0° misses by 26,319 km of altitude,
  10° by 24,938 km, 28.6° by 133,803 km and 51.6° by 240,580 km. A perfectly ecliptic park never
  leaves the plane the Moon has already drifted out of, so "near the ecliptic" is not the rule —
  the number is. Recorded because the first draft of the comment claimed "near the ecliptic" and
  a measurement said otherwise.
- **No random search, no seed.** The scenario is a constant, so it needs no RNG and the physics
  core stays free of `Math.random`. The alternative (a runtime free-return solver) is real work
  and belongs in a later milestone, not smuggled into a scenario.

The sample convergence is what makes the measured numbers trustworthy rather than an artefact of
where the integrator happened to look: 600, 1,000, 1,400, 2,000, 3,000 and 4,000 samples give a
lunar periapsis of 4,423-4,454 km from the Moon's centre and a final geocentric distance identical
to five significant figures (344,670-344,675 km at 9 days). A chaotic flyby would wander; this one
does not. PHYSICS.md §14.

The test that proves the Moon is the mechanism had to be rewritten once, and the reason is worth
recording because it is the trap this scenario sets. Removing the Moon does **not** stop the craft
passing near the Moon's position — the burn is aimed there, so the unperturbed ellipse closes to
4,672 km of lunar altitude against 2,694 km with the Moon present. Distance cannot separate the two
cases. What separates them is the return: without the Moon the burn is a closed 201,300 km ellipse
with a 10.4-day period, so at the end of the 9-day horizon the craft is still 308,380 km out,
against 7,057 km at 6.36 days. The test asserts that ratio (43.7× measured, bounded at 20×), not
the approach distance.

## D-037 - Persistence is an envelope, and a refused restore never destroys what it could not read

**Choice:** the last scenario is stored under `periapsis.scenario.v1` as
`{ storeVersion, savedAt, scenario }`, and `loadScenario` returns a discriminated result whose
`reason` distinguishes `empty` (first run), `corrupt` (discarded) and `newer` (left in place).
Import is a separate path: plain JSON, migrated, validated, reported as a summary plus field paths.
**Alternatives:** store the bare `Scenario` (then the scenario's own `schemaVersion` has to answer
two different questions); use IndexedDB (correct for many scenarios, oversized for one); let
`validateScenario` throw on import and catch it (loses the field paths, which are the whole point).
**Why:** the envelope version and the scenario version measure different things. `storeVersion`
says how to read the box, `scenario.schemaVersion` says how to read what is in it; a change to the
storage shape (several scenarios, a slot name) must not look like a schema break. Keeping them
apart costs one integer and avoids a fake schema bump.

The interesting decision is what happens when a restore _fails_, because the three failures want
three different responses and collapsing them into one boolean gets each of them wrong:

| Reason    | Cause                             | Response                             |
| --------- | --------------------------------- | ------------------------------------ |
| `empty`   | first visit                       | open the default, say nothing        |
| `corrupt` | bad JSON, or no longer validates  | discard it, open the default, say so |
| `newer`   | `storeVersion` above this build's | leave it untouched, say so           |

`corrupt` is discarded rather than retried because otherwise a single bad write makes every future
load fail identically and the app never self-heals - the user would have to clear storage by hand
to recover, and nothing in the UI would tell them that. `newer` is deliberately _not_ discarded:
it may be a perfectly good scenario from a later build, and deleting the user's only copy in order
to save a default is worse than any inconvenience of not restoring. `bootScenario` propagates that
as `preserveStored`, and the save effect honours it for the whole session, not just the first
render - a session-long flag, because the user may switch scenarios several times before the next
save and every one of those writes would destroy the newer entry.

`bootScenario` is in `src/ui/boot.ts` rather than in `App.tsx` so all three outcomes are unit
testable against a fake store. `browserStore()` probes with a real write-and-delete rather than
trusting `typeof localStorage`, because Safari's private mode, a sandboxed iframe and a blocked
cookie jar all present a storage object that exists and refuses writes; `persist.ts` then treats a
refusing store as "no store" and the app degrades to not remembering rather than throwing.

Import is not the same path as restore, and the difference is intentional. A restore reads a file
this app wrote; an import reads a file a person may have edited, which is why it has to name the
field that is wrong (`mission.orbit.altitudeM: must be positive`) and why the export fixes field
order by construction so two exports of one scenario are byte-identical - a scenario kept in git
should not churn on whitespace and key order. Neither path throws: `importScenario` and
`loadScenario` both return results, because the one thing a file-open control must never do is take
the app down.

## D-038 - The migration walker takes its chain, and its target, as parameters

**Choice:** `migrateWith(chain, input, target = SCENARIO_SCHEMA_VERSION)` walks a supplied chain
from the file's declared version to `target`, then validates. `migrateScenario()` is the app entry
point and passes the real, currently empty `MIGRATIONS`.
**Alternatives:** test only against the real chain (proves nothing while the chain is empty);
auto-detect the target from the newest known version (the same thing, but implicit); validate
before migrating (wrong - an old file is invalid by definition until the step has run).
**Why:** there is exactly one schema version today, so a migration mechanism with no migrations in
it is untestable by construction unless something can be injected. The `target` parameter exists
for the same reason, and only that reason: it lets a test exercise a _two-step_ upgrade and a
_missing-step_ gap at versions this build does not have, which is the actual behaviour of the
walker. Without it, the only reachable path is "version 1 file, version 1 build", and the code that
walks a chain would be shipped unexercised.

Two properties are deliberately absent. There is **no step-count guard**: the walker advances its
own version counter by one per iteration and a step never declares which version it produced, so
the walk cannot repeat a gap or fail to terminate, and a guard would be unreachable code - which is
only a place for a future bug to hide. And a **newer file is refused, not best-effort parsed**:
forward compatibility would mean guessing at fields this build has never seen, and a scenario that
half-loads is worse than one that refuses with both version numbers in the message. The refusal
message names both, because "your file is from a newer build" without saying which build is not
something a user can act on.
