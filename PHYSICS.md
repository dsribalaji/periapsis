# PHYSICS

The models Periapsis uses, the equations behind them, and — for every tolerance asserted in
the test suite — why that number and not another. A tolerance without a stated source is a
test that will be weakened later by someone who cannot tell whether a failure is a fix or a
regression.

Units are SI throughout the core: metres, seconds, radians, kilograms where relevant.
Angles in the physics are radians; degrees appear only at UI and document boundaries.

## 1. Time

### 1.1 Scales

| Scale | Definition                            | Offset from UTC     |
| ----- | ------------------------------------- | ------------------- |
| UTC   | civil time, with leap seconds         | 0                   |
| TAI   | atomic time                           | UTC + 37 s (2026)   |
| TT    | dynamical time used by element theory | TAI + 32.184 s      |
| UT1   | Earth rotation angle                  | within 0.9 s of UTC |

TT − UTC = 69.184 s in 2026. The code exposes `TT_MINUS_TAI = 32.184` and the leap-second
table separately, so the sum is checkable rather than a magic constant.

### 1.2 Julian date

JD is days since −4712-01-01 12:00 TT, with the Gregorian calendar applied from
1582-10-15 and the Julian calendar before it. J2000.0 = JD 2451545.0 = 2000-01-01 12:00 TT.

**Tolerances.**

- `jdFromIsoUtc(...)` to 9 decimal places (`toBeCloseTo(..., 9)`): 1e-9 d ≈ 86 µs. JD values
  near 2.46e6 carry an absolute double resolution of about 4.7e-10 d, so 1e-9 is within one
  or two ulp of what the representation can hold. Asking for more would test the float
  format, not the conversion.
- Round-trip calendar → JD → calendar to 1e-6 s: a full day is 86400 s, so this is a
  relative error near 1e-11, comfortably above JD ulp and well below any physical effect.
- `centuriesFromJd(J2000_JD + 36525) == 1` to 12 dp: exact by construction, included to
  catch a factor-of-365.25 style slip.

### 1.3 Earth rotation

GMST is computed from the IAU-1982 polynomial in UT1, and the Earth rotation angle (ERA)
from the IAU-2000 linear form. Both are used for ground-track work.

**Tolerances.**

- GMST at J2000 to 6 dp of a degree: the polynomial's own published precision is ~1e-6 deg.
- GMST rate over one sidereal day to 6 dp against `360.98564736629 % 360`: the constant is
  what is being checked.
- GMST/ERA agreement to 0.6 deg over the 2000–2050 span: the two formulations are
  independent realisations and diverge slowly by design; 0.6 deg bounds the whole
  interval rather than a single date. This is a consistency check, not an accuracy claim.

## 2. Two-body motion

### 2.1 Elements ↔ state

The classical element set is (a, e, i, Ω, ω, ν) with the standard perifocal-to-inertial
rotation R₃(−Ω)R₁(−i)R₃(−ω).

Inclination is taken as `atan2(hypot(h_x, h_y), h_z)` rather than `acos(h_z/|h|)`. This is
not cosmetic: `acos` loses roughly half its significant digits as its argument approaches
±1, which is exactly where near-equatorial and near-polar orbits live. `atan2` is accurate
over the full range.

**Tolerances.**

- Circular equatorial case: `e < 1e-10`, `i < 1e-12`, `a` to 1 dp in metres. Exact
  geometry should reproduce exactly; the bounds are above double rounding but far below
  anything a bug would hide behind.
- Element round-trip (state → elements → state) element-by-element: `a` to 8 dp relative,
  `e` to 8 dp, `cos i` to 8 dp, Ω / ω / ν to 1e-6 rad.
  - **Why the angles get 1e-6 and not 1e-12:** near an apsis, ν is recovered from
    `atan2(·, e + cos ν)` where the two arguments are both near zero for small e, and the
    derivative of ν with respect to the state blows up. Measured worst case for the
    property-test generator is a relative error of about 1.5e-8, i.e. √ε. 1e-6 rad sits
    two orders of magnitude above that floor, which is enough headroom that the test is not
    flaky and tight enough that a real error (which would be O(1)) cannot pass.
- State round-trip (elements → state → elements) position/velocity: 1e-7 relative. This
  direction is well-conditioned, so the bound is tighter than the element-direction bound
  for the same reason in reverse.
- `apsides()` on a known 8000 km × 12000 km ellipse: 0.5 m. Purely algebraic
  (a(1∓e)), so the only error is representation.

### 2.2 Kepler's equation

Elliptic: M = E − e sin E. Solved by Newton with a bracket guard.

Bare Newton was rejected after measurement: at e = 0.9999 with a tiny M, the derivative
`1 − e cos E` approaches 1 − e ≈ 1e-4 and plain Newton oscillates instead of converging.
The solver therefore maintains a bracket around the root and falls back to bisection
whenever a Newton step would leave it, which makes convergence unconditional. Hyperbolic:
M = e sinh H − H, solved the same way.

**Tolerances.**

- Residual `|M − (E − e sin E)|` below 1e-12 for e ≤ 0.9 and 1e-11 for e up to 0.9999. The
  residual is the honest quantity to test — the iterate itself can be ill-conditioned while
  the residual is exact. The looser bound at extreme e reflects the conditioning of
  reconstructing E, not a weaker solver.
- Hyperbolic residual below 1e-9 × max(1, |M|): relative, because M grows exponentially in
  H and an absolute bound would be meaningless at large H.
- Symmetry `solve(−M) == −solve(M)` to 10 dp; oddness is structural.

### 2.3 Closed-form propagation and conservation

`propagateTwoBody` advances a state by solving Kepler's equation for the elapsed time and
rotating in the perifocal frame. There is no integration, so there is no truncation error.

**Tolerances.**

- Forward-then-backward over a full period: 1e-9 relative in both r and v. Kepler's
  equation is solved to a 1e-12 residual, and the rotation is orthogonal; 1e-9 is a
  realistic accumulated bound and is about four orders above the measured value.
- Specific angular momentum conserved to 1e-10 relative: h is exactly invariant in the
  formulation, so this catches only representation drift.
- Specific energy conserved to `toBeCloseTo(e0, 0)`, i.e. ~0.5 J/kg on values of order
  −4e8 J/kg: relative 1e-9. Deliberately loose in absolute terms because a ~1e9 J/kg
  quantity cannot be compared more tightly without testing float arithmetic.
- Repeated full revolutions returning to the same state: 1e-9 relative. This is the
  drift test that would catch a missing 2π or a wrong sign in the mean-motion term.

## 3. Integrators

Two schemes, both fixed-interface:

- **RK4**, fixed step. Used wherever a deterministic, reproducible trajectory is needed
  (regression tests, before/after comparisons).
- **Dormand-Prince RK5(4)**, adaptive step from an embedded 4th-order error estimate. The
  default for restricted N-body work.

**Why adaptive by default:** near periapsis the local timescale is short and a fixed global
step must be sized for the worst case everywhere, which wastes enormous effort in the outer
part of the orbit. Measured on a GTO-like orbit, RK45 reaches a given accuracy for a small
fraction of the steps RK4 needs at the step size that keeps periapsis accurate. See
DECISIONS D-005 and ADR-0004.

**Tolerances.**

- **Convergence order.** Halving the step must reduce the global error by ≈16 for RK4 and
  ≈32 for DP5(4). The tests assert the observed order is within a window of the theoretical
  value rather than exactly equal to it, because the asymptotic regime is only approached
  as h → 0 and a two-point estimate from finite steps always carries an O(h) bias. The RK4
  window used is 12–20 (measured, over h = 40 → 5 s).
- **Energy drift, RK4 fixed step: below 1e-6 relative over 10 LEO orbits at h = 30 s.**
  Measured 7.8e-8, with the convergence sequence h = 60 → 2.5e-6, h = 30 → 7.8e-8,
  h = 15 → 2.5e-9, h = 5 → 1.0e-11. The bound is a decade above the measurement at the
  tested step so that it fails on a regression rather than on a different machine.
- **Energy drift, RK45 adaptive: below 1e-7 relative over 20 orbits at relTol 1e-12.**
  Measured 7.2e-9. This **saturates**: tightening relTol to 1e-13 still gives 7.1e-9,
  because drift is (local error) × (step count) and the count stops falling once `maxStep`
  binds. Tightening the bound would test the harness, not the integrator.
- **Angular momentum drift, RK4: below 1e-6** over the same 10 orbits (measured 3.9e-8).
- **Accuracy per evaluation** is asserted rather than wall-clock time, so the test is
  machine-independent: on a Molniya orbit (e = 0.74) RK45 at relTol 1e-10 must use fewer
  than half the evaluations of RK4 at h = 30 s. Measured: 7,336 vs 28,720.
- **Determinism:** identical inputs produce bitwise identical outputs. Required by the
  purity rules (no clock, no RNG) and asserted directly.

## 4. Solar system and ephemeris

Positions come from JPL's "Keplerian Elements for Approximate Positions of the Major
Planets" (Table 1), transcribed verbatim including the rates. Elements are in the J2000
ecliptic frame; the evaluator advances them linearly in T (Julian centuries past J2000) and
solves Kepler's equation for each body. The Moon is handled separately with its own
element set.

Velocity is a **central difference of the shipped position function** with a 600 s step,
not an analytic derivative of the fixed-element model.

**Why:** the analytic derivative of a linearly-advancing element set is not the derivative of
the position the code actually returns — the two differ wherever the element rates are
inconsistent with the two-body dynamics, which for this data set they are (the rates are a
fit, not a solution). A central difference differentiates the real thing. 600 s gives
truncation error of order (600)²·|r⃛|/6, which for planetary motion is far below the model's
own error, at negligible cost.

**Tolerances.**

- Earth–Sun distance: 0.983–1.017 AU across a year, asserted as `< 1.02 AU`. The real range
  is 0.9833–1.0167 AU; the bound is set to catch a frame error, not to resolve the orbit.
- Planetary latitudes `|β| < 6°` (and `< 8°` for Mercury): all planets lie within ~7° of the
  ecliptic. A frame mix-up (ecliptic vs equatorial) would show up as tens of degrees.
- Circular orbital speeds: Earth < 30.5 km/s, Mercury < 60 km/s, the Moon < 1.3 km/s. These
  are order-of-magnitude guards against a wrong GM or a wrong unit.
- **Analytic vs central-difference velocity: 1e-4 relative.** This is the honest accuracy
  of the velocity model, and it is dominated by the discretisation of the fitted element
  rates, not by the difference step.
- **Mean motion from element rates: 2e-4 relative for the planets, 5% for the Moon.** The
  rate is `L̇ − ϖ̇` (both tabulated). An earlier version used the solar GM for every body,
  which is correct for the planets and wrong for the Moon by a large factor; the 5% bound is
  what a correct hierarchical treatment achieves, and the asymmetry between the two numbers
  is the point of the test.
- Frame sanity: every planet stays inside its known perihelion/aphelion band at a fixed
  epoch, and all planetary latitudes stay within ~6–8° of the ecliptic. A frame mix-up
  (ecliptic vs equatorial) would show up as tens of degrees, not degrees.
- Ephemeris drift over one century below 0.01 AU from the secular trend: a guard against
  sign errors in the rates, deliberately loose because the linear model itself degrades
  over centuries.

**Documented limitation.** Table 1's Mars range carries about 25,000 km (~1.7e-4 AU) of
error against a real ephemeris. Consequence: Earth–Mars transfer delta-v computed from these
positions is indicative to a few tens of m/s, not operational. Recorded here, in the UI
caveat, and in STATE.md rather than left for someone to rediscover.

## 5. Sphere of influence

The Laplace SOI radius is `r_SOI = a (m/M)^(2/5)`.

Choosing which body governs a spacecraft is done by **hierarchical descent from the Sun**,
not by a flat scan over all bodies. A flat `r < r_SOI` scan is wrong in a specific,
reproducible way: the Sun's SOI is formally infinite, so any point qualifies for the Sun and
a naive loop that keeps the last match awards deep space to whichever body happens to be
last in the list. Descending the hierarchy (Sun → planet → moon) makes the answer
independent of ordering.

**Tolerances.**

- Earth's SOI between 850,000 and 1000,000 km: the textbook value is 924,600 km, so the
  window brackets it with room for the choice of GM and semi-major axis.
- The Moon's SOI between 55,000 and 80,000 km: textbook 66,100 km.
- The Sun's SOI is exactly `Infinity`, by construction.
- SOI ordering (Jupiter > Earth > Moon) is asserted, which catches a body whose mass or
  semi-major axis was mistyped.
- `altitudeAbove(...)` at a 400 km circular orbit returns 400 km to 0.5 m; at a point inside
  the body it returns negative (used to detect surface impact).

## 6. Restricted N-body

Acceleration on a massless spacecraft from prescribed bodies:

**a = Σ μᵢ [ (rᵢ − r)/|rᵢ − r|³ − rᵢ/|rᵢ|³ ]**

The second term is the indirect term that keeps the formulation in the central-body frame. It is
included because omitting it is a common and silent error: the resulting trajectory looks
plausible but drifts relative to the true one, and the error grows with distance from the
primary.

**Tolerances.**

- Earth-surface gravity with only Earth enabled: below 9.9 m/s². g at the surface is
  9.82 m/s²; the bound catches a wrong radius or a missing r² factor.
- Inverse-square ratio at r and 2r: exactly 4 to 6 dp — the structural property of the
  model.
- Adding the Sun to an Earth-only field near Earth changes the total by < 1%: this is the
  test that the indirect term is present and correct. Without it, the Sun's contribution at
  1 AU from Earth is O(1) and the assertion fails immediately.
- Energy conservation under integration in a pure two-body field: 1e-9 relative (see §3).

## 7. Impulsive transfers

### 7.1 Hohmann

Two tangential burns between circular orbits r₁ < r₂, transfer semimajor axis
a = (r₁ + r₂)/2, duration = half the transfer period.

**Tolerances.**

- LEO (6678 km) → GEO (42164 km) total Δv in 3.8–4.0 km/s: the textbook figure is ~3.94
  km/s. A window, not a point, because published values differ by which Earth radius and GM
  are used.
- Duration equals `π√(a³/μ)` to 3 dp of a second: closed form on both sides.
- Angular momentum equal at both apsides (`r₁v_p = r₂v_a`) to 3 dp relative: structural.
- Descending Δv equals ascending Δv to 6 dp relative: the problem is symmetric.
- Identical radii give exactly 0 Δv and 0 duration.

### 7.2 Bi-elliptic

Three burns via an intermediate radius r_b > r₂. Beats Hohmann above a radius ratio of about
11.94.

**Tolerances.**

- Cheaper than Hohmann at ratio ~40, more expensive at ratio ~6: the crossover is a known
  constant, so this pins the model at both sides of it.
- As r_b → r₂⁺ the total Δv approaches Hohmann to `toBeCloseTo(..., 0)`: a limit test, loose
  because the approach is first-order in the perturbation.
- Duration is the sum of two half-periods to 1 s: closed form.

### 7.3 Plane change

Δv = 2v sin(θ/2). Checked at θ = 0 (0), θ = π/2 (v√2), θ = π (2v), all to 6 dp.

### 7.4 Spacecraft trajectory with impulsive nodes

A maneuver node is a pure velocity jump at one instant:

**r⁺ = r⁻, v⁺ = v⁻ + Δv**

Δv is expressed either in the local orbital frame (prograde, orbit normal, outward radial) or
in the inertial frame. A local node is resolved against the state it is applied to, so the same
"200 m/s prograde" produces a different inertial Δv at a different point on the orbit — which
is the whole reason to express it locally.

**The burn is applied in the central-body frame, not the heliocentric one.** This is the one
place the model is easy to get wrong in a way that still looks like an answer. A spacecraft
started from a geocentric state is stored heliocentrically after the body's ephemeris position
is added, and applying a local burn to that heliocentric velocity makes "prograde" mean "along
Earth's orbit about the Sun" — about 90° wrong for a LEO satellite. Measured before the fix:
a 2006 m/s "Hohmann departure" burn moved the craft from a 6,363 km radius to 7,326 km instead
of reaching 26,371 km. `applyBurn` therefore subtracts the central body's position and velocity,
builds the frame from the geocentric state, applies the burn, and adds the body velocity back.
An `inertial` node skips the subtraction, because inertial means heliocentric here by
definition.

**Tolerances.**

- **Geocentric speed after a prograde burn rises by exactly the node's magnitude**: asserted to
  1e-6 m/s. This is the assertion the frame bug failed.
- **Heliocentric speed is asserted against the exact expected value**, not against the
  first-order projection. `|v + Δv| − |v|` carries a second-order term `|Δv⊥|² / (2|v|)` that is
  0.074 m/s for a 100 m/s burn nearly perpendicular to a 29.8 km/s heliocentric velocity, so
  comparing to `Δv·cos θ` with a 1e-6 tolerance fails for a correct implementation. The test
  instead computes `|v_helio + Δv|` directly and separately asserts that the first-order
  projection is off by more than 0.01 m/s, so the second-order term is stated rather than
  absorbed into a loose bound.
- **Hohmann departure from a 400 km LEO reproduces the analytic apogee** at 20,000 km altitude:
  arrival radius within 1 km, radial speed below 20 m/s (apogee, not a radial crossing),
  tangential speed within ~5 m/s of vis-viva with a = (r₁+r₂)/2. Deliberately loose in the last
  two because the two-body arc is sampled at finite resolution and the departure burn is applied
  to an ephemeris-derived state.
- **Δv accounting:** `usedDeltaV` equals the sum of node magnitudes to 1e-9, and
  `remainingDeltaV` equals budget minus that sum, including when it goes negative.

**Documented limitations.**

- **Local burns are order-dependent.** The frame is re-derived after each burn, so two nodes at
  the same instant do not commute. Measured difference: 0.15 m/s swapping a prograde and a
  normal node. Correct behaviour for an impulsive model; `sortedManeuvers` breaks ties by id so
  a saved mission always replays the same way.
- **A craft placed exactly at a body's centre is singular.** The restricted N-body field
  diverges there and `rk45Step` throws `step-size control failed to converge` rather than
  reporting a non-finite state. Unhandled; tests place the craft 90° away in heliocentric
  longitude. A realistic initial state is never at the centre, so v1 does not guard it.
- **Impacts are detected, not resolved.** `impacts` is set when any sample falls inside the
  central body's mean radius; the trajectory is not terminated or bounced there.

## 8. Lambert's problem

Single-revolution solution by universal variables (Stumpff functions C(z), S(z)), as in
Bate–Mueller–White / Vallado.

### 8.1 Formulation

With A = sin Δν · √(r₁r₂ / (1 − cos Δν)):

- y(z) = r₁ + r₂ + A(z·S(z) − 1)/√C(z)
- x = √(y/C), t(z) = [x³S(z) + A√y] / √μ
- f = 1 − y/r₁, g = A√(y/μ), ġ = 1 − y/r₂
- **v₁ = (r₂ − f r₁)/g**, **v₂ = (ġ r₂ − r₁)/g**

The last line matters. Both velocities follow from the same Lagrange relations
(`r₂ = f r₁ + g v₁`, `v₂ = ḟ r₁ + ġ v₁`, with `f ġ − ḟ g = 1`), and the tempting
`v₂ = ġ r₁ + f v₁` is wrong while producing a plausible-looking number of the right
magnitude. It was measured wrong by up to ~100% before the test suite caught it.

Note that **y uses S, not C**: y = r₁ + r₂ + A(z·S − 1)/√C. Getting this wrong is silent —
near z = 0 the two are nearly interchangeable and short arcs still solve — but the time of
flight loses monotonicity (measured: a turn at z = 20.55 for a Sun-centred 1.8 AU geometry)
and y goes negative before the 4π² asymptote, so long arcs simply have no bracketed root.

### 8.2 Root finding

Bisection on the time of flight over z ∈ [z_lo, 4π²). The time of flight is strictly
increasing in z over the valid domain and runs from 0 to +∞, which makes a plain bisection
unconditionally convergent with no initial guess.

Bracketing on the sign of y was tried and rejected: for long-way arcs (A < 0) y is positive
for every z, so the bracket search never terminates. Bisection on z with Newton
safeguarding was also rejected — Newton needs a good initial guess and can step into y < 0.

### 8.3 The 180° case

When `1 + cos Δν < 1e-8`, the problem is solved analytically instead: a = (r₁ + r₂)/2,
speeds from vis-viva, arrival velocity reversed. See DECISIONS D-007 for the full argument.
In short: A → 0 there, so g → 0 and the universal form is a 0/0 limit that angle
perturbation cannot repair (measured: at eps = 1e-6 rad, A collapses by ~1e-6 while
√(r₁r₂) does not, a mismatch of 7e-7). The geometry is also over-determined — r₁ and r₂ are
the apsides — so only the half-period elliptic arc exists.

The case is ignored for `longWay`, since both arcs are 180° and indistinguishable.

### 8.4 Model-validity bound

Solutions with either speed above 3e7 m/s (0.1c) are reported as non-convergent. A
rectilinear collapse admits arbitrarily large speeds at arbitrary short times of flight, so
"1 AU in 10 s" has a real finite answer at ~70c and would otherwise be returned as a
success. See DECISIONS D-008.

### 8.5 Tolerances

- **The decisive test:** a 180° Lambert arc _is_ a Hohmann transfer, so the two independent
  implementations must agree. Measured: 2334.0 and 1434.0 m/s against the Hohmann closed
  form for 7000 → 42000 km about Earth, matching to 0.1 m/s. Asserted with
  `toBeCloseTo(hohmannΔv, -1)`, i.e. ±5 m/s: the universal-variable path and the analytic
  path use different algebra, so agreement to 5 m/s out of 2334 m/s (0.2%) is the right
  statement that they solve the same problem.
- **Propagation check, 1e-6 relative:** depart with v₁, propagate for the time of flight with
  the independent closed-form Kepler propagator, and require arrival within 1e-6 of r₂.
  This is stronger than any formula comparison, because it does not share code paths.
  Measured error is ~1e-12 relative, so 1e-6 leaves six orders of headroom while still
  failing on any real error.
- **Arrival-velocity consistency, 1e-6 relative:** the propagated velocity must equal the
  Lambert v₂. This is the test that catches the `ġ r₁ + f v₁` mistake.
- **Hohmann arc duration:** the solver is given exactly the analytic half-period, so
  `converged` is asserted directly.
- **Impossible request:** 1 AU in 10 s must report `converged: false` (see §8.4).
- **Long-way vs short-way** departure velocities must differ by more than 100 m/s: guarding
  against a sign convention that silently collapses both arcs to the same solution.

## 9. Scope and known limits

- **Single revolution only.** Multi-revolution Lambert arcs are not implemented; the solver
  returns `converged: false` rather than an approximate answer. See ADR-0005.
- **Impulsive burns only.** No finite-thrust arcs.
- **Trajectory sampling is bounded.** `MAX_TRAJECTORY_POINTS = 4000` across a horizon and
  `MIN_POINT_SPACING_SECONDS = 60`, so a long horizon is coarsely sampled rather than returning
  millions of points. A burn always lands exactly on a sample: the propagation is split at every
  node time, so the plotted line has a real vertex at each burn.
- **Prescribed ephemerides.** The massive bodies follow their tabulated elements and are not
  themselves integrated (ADR-0003). This is the restricted problem.
- **Newtonian gravity only.** No relativity, no oblateness (J₂), no drag, no solar
  radiation pressure. For LEO over long spans these omissions dominate; the UI says so.
- **Element precision near apsides** is capped at ~1.5e-8 relative by the conditioning of
  the true anomaly, as described in §2.1.
- **A porkchop cost is v-infinity, not mission delta-v.** The Oberth effect is omitted (§11.2);
  the plot ranks windows correctly but its absolute numbers are not a budget.
- **A porkchop is heliocentric.** Only Sun-centred transfers between planets are plotted. A
  lunar transfer is a geocentric problem, so the Moon is excluded from the body list rather
  than solved with the Sun's mu and returned as a confident wrong answer (§11.1).

## 10. Display conventions and what they cost

Physics is in metres and an inertial frame. The view is neither, and every difference is
deliberate. This section records the three conversions so a number on screen can be traced
back to the model that produced it.

### 10.1 Frame: physics to scene

`(x, y, z)_physics → (x, z, −y)_scene`. Physics has +z out of the ecliptic; the scene uses
+y up because that is what a camera expects. This is a rotation, not a reflection: it
preserves handedness, so an orbit that is prograde in physics still looks prograde. Defined
once in `scale.ts` (`toScene`, `scaleOffset`) and once in `orbit/elements.ts`
(`localOrbitalFrame`) — nowhere else.

### 10.2 Trajectories are drawn body-fixed at the scenario epoch

A propagated trajectory is heliocentric. It is drawn as offsets against the central body's
position **at the scenario epoch**, with the resulting group anchored to that body's live
scene position.

**Why not heliocentrically:** Earth travels about 25 of its own radii during one LEO
revolution. Drawn inertially, a 550 km orbit would be smeared off the planet into a spiral —
a picture of the Sun-centred path, which is not the thing anyone is looking at. Anchoring to
the body is what makes "the orbit" look like an orbit.

**What it costs:** a craft that genuinely leaves its central body (a heliocentric transfer)
is drawn as a curve attached to that body rather than as a path through the solar system.
Chopping the anchor at the SOI boundary would show the curve correctly for a moment and then
jump it; in v1 the honest description is that the drawn line is body-relative, and the
mission panel reports heliocentric-crossing facts (impact, apoapsis) as numbers. Recorded as
a limitation rather than a plan.

### 10.3 Scale: trajectories reuse the body's own exaggeration

Body radii are cube-root compressed while positions are linear (§ ARCHITECTURE, `scale.ts`),
so the two differ by about 282× for Earth. A 400 km orbit at the linear scale is 2.7e-3
scene units — under a pixel, and inside Earth's 1.2-unit drawn mesh.

Trajectory offsets therefore use `bodyRelativeScale(bodyId, radiusM)` = drawn radius / true
radius, in scene units per metre. The consequences, all of which are correct _about that one
body_:

| Feature           | True ratio to Earth's radius | Drawn ratio |
| ----------------- | ---------------------------- | ----------- |
| 400 km LEO        | 1.063                        | 1.063       |
| GEO (35,786 km)   | 6.61                         | 6.61        |
| Moon (384,400 km) | 60.3                         | 60.3        |

So the local geometry is right, but it is **not** to scale against the heliocentric layout:
the Moon is drawn at 60 Earth-drawn-radii = 72 units while its real scene position is about
0.03 units from Earth on the linear layout. A trajectory and the body it orbits therefore
share a scale, and nothing else does. This is the same compromise the body radii already
make, extended to one more object, and it is stated in the UI caveat.

### 10.4 Inclination datum

Orbit inclinations are measured from the **ecliptic** (the xy plane), not Earth's equator,
which is tilted 23.4° from it. A scenario quoting "550 km at 53°" is describing a 53° ecliptic
inclination; the real ISS flies 51.6° to the equator, which in this model's datum would be a
different number. Not corrected in v1: doing it properly means carrying Earth's obliquity and
a body-fixed frame, which arrives with the ground track in M6.

### 10.5 Tolerances attached to the display layer

These are geometric identities, not approximations, so they are asserted tightly:

- **A point one body radius out lands exactly on the drawn radius** (1e-6 scene units): the
  frame's scale factor is defined as drawn radius divided by true radius.
- **The ratio of two orbital radii is preserved** to 1e-6 relative, because the mapping is a
  single multiply.
- **Segment times are strictly ascending**, so "already flown" is always a prefix and
  `drawRange` can encode it. A mid-path envelope clip drops segments but does not reorder
  them.

## 11. Porkchop plots

A porkchop plot answers _when should this transfer leave?_ by solving Lambert's problem on a
grid of departure dates and times of flight and reporting the cost of each cell. It needs no
optimiser: the expensive part is a table, and the answer is a minimum over that table.

### 11.1 What one cell is

For departure `t_dep` and time of flight `T`:

```text
r1 = r_departure(t_dep)          r2 = r_arrival(t_dep + T)
solve Lambert(r1, r2, T, mu_sun) -> v1, v2
v_inf_dep = |v1 - v_body_dep(t_dep)|        v_inf_arr = |v2 - v_body_arr(t_dep + T)|
cost      = v_inf_dep + v_inf_arr           C3 = v_inf_dep^2
```

Two implementation details are load-bearing:

- **Body velocities are central differences of the shipped position function**, with the same
  600 s step used by `sim/trajectory.ts`, not an analytic derivative with constant elements.
  The elements are advanced linearly in time, so the honest velocity is the derivative of the
  function that actually produces positions; an analytic derivative with frozen elements omits
  the rate terms and disagrees with the propagator. The helper is duplicated in
  `core/transfer/porkchop.ts` rather than imported, because the dependency direction is
  sim -> core and never the reverse.
- **Departure positions are computed once per column.** Arrival time is `departure + T`, which
  depends on both axes, so it cannot be hoisted; a 100x100 grid still needs 10,000 arrival
  ephemeris calls, but the departure half costs 100 instead of 10,000.

Measured cost, single-threaded, Node 24: 60x60 in 45 ms, 100x100 in 82 ms, 140x140 in 150 ms,
200x200 in 342 ms. The panel therefore computes on a button press rather than on every
keystroke.

### 11.2 The cost is v-infinity, not delta-v from a parking orbit

`cost = v_inf_dep + v_inf_arr` is the standard "patch" comparison. It is **not** the delta-v a
mission spends, because the real departure burn happens deep in a gravity well and benefits
from the Oberth effect. The correct figure for a departure from a circular orbit of radius `r`
is

```text
dv_dep = sqrt(v_esc^2 + v_inf^2) - v_circ
```

which is _less_ than `v_inf`: leaving a 200 km Earth orbit for Mars with 3.06 km/s of
v-infinity costs about 3.6 km/s, not 3.06.

**The transformation does not preserve differences**, so the plotted number cannot be corrected
by a constant offset, and the error is not small in general. Measured over Earth-departure
grids with a 200 km Earth parking orbit and a 300 km capture orbit at the target:

| Target  | Plot minimum | Parking-orbit dv at the same cell | Gap  | Rank correlation |
| ------- | ------------ | --------------------------------- | ---- | ---------------- |
| Mars    | 5.62 km/s    | 5.69 km/s                         | +1%  | 0.9997           |
| Venus   | 6.95 km/s    | 7.31 km/s                         | +5%  | 0.9999           |
| Mercury | 18.29 km/s   | 13.56 km/s                        | -26% | 0.9998           |

So the plot **ranks windows correctly** - Spearman rho >= 0.9997 on every grid measured, and
the parking-orbit optimum fell in the same cell in all three cases - while the absolute number
can be wrong by a quarter, in the direction that matters most: for Mercury the plot makes a
hard mission look _harder_ than it is, because a fast burn deep in the well is exactly where
the Oberth effect pays best. The maximum per-cell discrepancy on those grids was 9-13 km/s,
i.e. the transform is a large monotone-ish distortion, not a small correction.

What is deliberately omitted: the capture orbit at the target is not modelled as a choice, the
departure orbit is not an input, and plane changes are not costed separately - the Lambert
solution absorbs the geometry into v-infinity. The panel states this in one caveat line rather
than leaving the number to be mistaken for a budget.

### 11.3 Axes: departure date against time of flight

Departure-versus-arrival is the other common layout. It is a worse default:

- Half of a rectangular date/date grid is unphysical ("arrive before you left"), so the useful
  region is a triangle: either the axis ranges are narrowed until the triangle fills the box,
  or half the plot is wasted.
- A time of flight is a _shape_ choice - it selects which arc you fly - while a departure date
  is a calendar fact. Putting the shape on an axis makes the vertical structure mean
  something.

Recorded as DECISIONS D-017.

### 11.4 Grid geometry, holes and colour

- **A cell with no single-revolution solution is `NaN` and drawn transparent.** Twenty minutes
  to Mars is beyond the model (8.4 rejects the rectilinear plunge on speed grounds), so the
  panel shows holes and the summary says no arc exists, rather than printing a plausible wrong
  cost. A zero would be indistinguishable from a free transfer.
- **Colour scaling uses the 2nd and 98th percentile of converged cells**, not min and max. A
  grid almost always contains near-grazing cells costing ten times the useful window, and
  scaling to the maximum compresses the whole decision into the first two percent of the ramp.
  Both quantiles are parameters, so the choice is visible at the call site.
- **The image buffer is one pixel per cell with row 0 at the top of the plot**, i.e. the
  longest time of flight. The grid stores rows shortest-first, so `porkchopImage` flips exactly
  once. One flip in one function is testable; a flip per consumer is not.
- **Pointer-to-cell uses `floor`, not `round`.** The drawn image divides the box into `columns`
  equal strips, so the strip containing the pointer is the honest answer; `round` would leave
  the outermost half-strip unselectable.

### 11.5 Plane tilt is reported because it explains a cell

`planeTiltDeg` is the angle between the transfer-plane normal `r1 x r2` and the ecliptic pole.
It is in the readout for one reason: it is the explanation for a neighbouring cell costing ten
times more. A transfer plane must contain the Sun and both endpoints, so when those endpoints
are nearly opposite the plane is nearly undetermined - a tiny change in either position rotates
it by tens of degrees - and the cheap coplanar arc may not exist at that geometry.

The measured relationship, asserted in `tests/porkchop.test.ts`: at comparable transfer angle,
the cheapest cell with tilt under 10 degrees beats the cheapest with tilt over 10 degrees by
more than 1.3x (measured 6.85 vs 11.03 km/s at 160-170 degrees, 7.37 vs 11.21 at 170-175,
7.74 vs 12.47 at 175-179). The tempting claim "near 180 degrees is always expensive" is
**false** and is not asserted: cheap cells do exist near 180 when the geometry happens to give
a nearly coplanar plane.

### 11.6 Tolerances

- **Reproduces its own Lambert solve, 1e-3 m/s.** One cell is recomputed from scratch -
  independent body positions, independent central-difference velocities, independent
  `solveLambert` call - and the reported v-infinity must match. The tolerance is a millimetre
  per second out of kilometres per second: the arithmetic is identical, so anything above
  rounding is a wiring error (wrong body, wrong time, swapped departure and arrival).
- **C3 is exactly `v_inf_dep^2`**, to 3 decimal places in m^2/s^2. An identity, not a
  measurement.
- **Every cell of a 20x20 Earth-Mars grid converges.** That grid is well inside the reachable
  set, so a hole there means the solver rather than the geometry: asserted as exactly 0 holes.
- **The Earth-Mars minimum is 5.4-5.9 km/s**, against the coplanar-circular Hohmann reference
  of 5.594. Real bodies are eccentric and inclined, so a Lambert minimum can only be higher;
  a range is asserted rather than a value to keep this a physics test. Measured 5.62.
- **The minimum departs in Aug-Nov 2026** with a time of flight of 250-360 d (the Hohmann
  half-period is 259 d). Measured: 2026-10-26, 314 d.
- **The optimal cell has plane tilt under 5 degrees** for Earth-Mars: a tens-of-degrees tilt
  would mean the solver chose a physically different, much more expensive arc.
- **The tilt relationship, 1.3x**: see 11.5. The factor is a conservative floor under
  measurements of 1.6-1.8x.
- **The display layer's identities, 1e-9**: the image is `columns x rows` pixels; a
  transparent cell is exactly a `NaN` cell; `cellFromFraction` round-trips `fractionOfCell` for
  every cell in the grid.
