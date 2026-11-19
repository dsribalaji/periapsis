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

### 10.2 Trajectories are drawn body-relative, against each sample's own time

A propagated trajectory is heliocentric. It is drawn as offsets against the central body's
position **at each sample's own time** - the body-relative path - with the resulting group
anchored to that body's live scene position.

**Why not heliocentrically:** Earth travels about 25 of its own radii during one LEO
revolution. Drawn inertially, a 550 km orbit would be smeared off the planet into a spiral - a
picture of the Sun-centred path, which is not the thing anyone is looking at. Anchoring to the
body is what makes "the orbit" look like an orbit.

**Why not the epoch position** (which is what this module did until M5.5, and what this section
described as correct): subtracting the body's position at the **epoch** while the group transform
adds the body's position at the **current** time does not freeze the frame - it double-counts the
body's own displacement into the craft's. Measured on the bundled 550 km orbit:

| Quantity                                      | Epoch-anchored (wrong) | Body-relative (correct) |
| --------------------------------------------- | ---------------------- | ----------------------- |
| Drawn extent over a 3.22 h horizon            | 64.68 units            | 1.35 units              |
| That extent in real distance                  | 343,390 km             | 7,152 km                |
| Craft sitting at Earth's centre, after 30 min | 10.21 units away       | origin, exactly         |
| Altitude readout at the horizon               | 337,018.8 km           | 780.1 km                |

The last row is the one that made this a defect rather than a cosmetic issue: the live radius is
derived from the drawn frame, so the panel read "Radius now 343,389.8 km" directly above
"Apoapsis 7,151.9 km". The e2e test that guarded the altitude accepted it, because its tolerance
was ±1000 km; it now asserts the live radius against the plan's own apoapsis.

The fix costs one `bodyPosition` call per sample - measured 4-8 ms for 4,000 samples, against a
propagation that already does two per sample for velocity.

**What it still costs:** a craft that genuinely leaves its central body (a heliocentric transfer)
is drawn as a curve attached to that body rather than as a path through the solar system.
Chopping the anchor at the SOI boundary would show the curve correctly for a moment and then
jump it; in v1 the honest description is that the drawn line is body-relative, and the mission
panel reports heliocentric-crossing facts (impact, apoapsis) as numbers. Recorded as a limitation
rather than a plan.

### 10.3 Scale: one scale, and a minimum size in pixels

Since D-047 every length in the scene uses **one** scale, `UNITS_PER_M` (100 units per AU):
planet positions, body radii, the Moon's offset from Earth, the Moon's orbit path and every
spacecraft trajectory. That is the only arrangement in which every relation is true at once,
and it is what made each of the earlier bugs in this section impossible rather than fixed.

| Quantity                      | Scene units | Ratio     | Truth     |
| ----------------------------- | ----------- | --------- | --------- |
| Earth radius                  | 0.004259    | 1         | 1         |
| 400 km LEO radius             | 0.004526    | 1.063 R⊕  | 1.063 R⊕  |
| GEO radius                    | 0.02818     | 6.61 R⊕   | 6.61 R⊕   |
| Moon radius                   | 0.001161    | 0.273 R⊕  | 0.273 R⊕  |
| Earth-Moon distance (mean)    | 0.2570      | 60.3 R⊕   | 60.3 R⊕   |
| Earth-Sun distance            | 100         | 23,481 R⊕ | 23,481 R⊕ |
| Moon's offset / Earth's orbit | 0.0026      |           | 0.0026    |

**Why the previous design could not be patched.** Up to v1.0.0 bodies were drawn at a
cube-root-compressed radius (Earth 1.2 units, 282× its true size) while positions stayed linear.
A satellite and a trajectory then had to be drawn at the same 282× to clear the inflated planet,
which put the Moon 72.4 units from Earth - while Earth is only 100 units from the Sun. The Moon
was drawn three quarters of the way to the Sun, sweeping through the orbits of Mercury, Venus
and Mars. Hiding it at system zoom (the uncommitted attempt after v1.0.0) only stopped showing
the wrong position; no framing rule repairs a position.

**Visibility is a screen-space rule.** At true scale Earth is 0.01 px across from the 320-unit
inner-system camera. Each body is therefore drawn at `max(true radius, MIN_PIXEL_RADIUS × size of
a pixel at its distance)`, recomputed every frame (`drawnRadiusUnits`). A body that can be
resolved is exactly its real size; one that cannot is a marker of fixed apparent size. Nothing is
ever drawn smaller than it is, and nothing is moved. The pixel minimums rank like the bodies (Sun
9 px, giants ~5, rocky planets ~3.5, Moon 2.4) so the markers still read in the right order.

**Satellites.** Two markers of a few pixels each overlap long before their true separation is
visible: from the inner-system camera the Moon is 0.8 px from Earth. A satellite is drawn only
when the gap between its disc and its parent's is at least 3 px (`satelliteResolvable`). That is
a statement about the screen, made _after_ the position is already correct. Zoom in and the
Moon appears, on its drawn orbit, exactly where it is.

**The compressed layout** has no single scale, so a body-centred system (the Moon about Earth, a
craft about its planet) uses the map's local slope at the parent's distance
(`localUnitsPerMetre`): about 31 units per AU at Earth instead of 100. The Earth-Moon system is
therefore internally to scale and consistent with its neighbourhood, rather than being placed at
a fixed "three parent radii" as before.

**Range.** One scale from a 550 km orbit to Neptune is a ratio of about 1e7. The renderer handles
it with a logarithmic depth buffer, a near plane tied to the camera distance, a camera that
follows its target body (at warp 10k Earth moves 0.2 units per second, which would leave a
0.05-unit close-up in a fraction of a second), and a starfield re-centred on the camera every
frame.

**Trajectories** are body-relative, as §10.2 describes, at the same `UNITS_PER_M`. The envelope
beyond which a body-relative drawing stops being meaningful is 1.06e7 km (`DEFAULT_ENVELOPE_M`),
the same physical reach as before.

### 10.4 Inclination datum

Orbit inclinations are measured from the **ecliptic** (the xy plane), not Earth's equator,
which is tilted 23.4° from it. A scenario quoting "550 km at 53°" is describing a 53° ecliptic
inclination; the real ISS flies 51.6° to the equator, which in this model's datum would be a
different number.

This is **not** corrected for the 3D view: the scene draws what the physics stores, and there
no latitude exists to be wrong. It **is** corrected for the ground track (§13), because a
latitude and a longitude are equatorial by definition and cannot be expressed in the ecliptic
frame at all. §13.2 applies the obliquity rotation, so a ground track is equatorial even
though the trajectory it came from is ecliptic. The two statements coexist: the _orbit_ is
ecliptic, the _sub-satellite point_ is equatorial.

### 10.5 Tolerances attached to the display layer

These are geometric identities, not approximations, so they are asserted tightly:

- **A point one body radius out lands exactly on the drawn radius** (1e-6 scene units): the
  frame's scale factor is defined as drawn radius divided by true radius.
- **The ratio of two orbital radii is preserved** to 1e-6 relative, because the mapping is a
  single multiply.
- **Segment times are strictly ascending**, so "already flown" is always a prefix and
  `drawRange` can encode it. A mid-path envelope clip drops segments but does not reorder
  them.
- **One scale** (§10.3): the Moon's separation is 60.3 Earth radii and 0.26% of Earth's orbit
  radius, and a 400 km orbit is 1.0628 radii, each to the precision of the constants
  (`tests/scale.test.ts`). These are equalities, because there is no second scale left to bound.
- **Nothing is drawn smaller than it is**: the pixel minimum is a `max`, checked for every body
  over four orders of magnitude of pixel size.
- **A satellite is shown only with a visible gap** of 3 px between its disc and its parent's;
  the boundary is tested on both sides, and the Earth-Moon pair framing is tested to satisfy it.
- **A body sits on its drawn orbit**, to within 1.5x the chord sagitta of the 360-segment
  polyline (`tests/orbitPaths.test.ts`) — the largest gap a straight segment can leave.

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

Those figures were measured with the machine at full clock. Re-measured for M5.4 on the same
laptop with the CPU at 1.5 GHz against a 2.2 GHz maximum (balanced power scheme, on battery),
the same grid costs 60x60 78 ms, 100x100 211 ms, 140x140 415 ms, 200x200 846 ms - a uniform
2.6x, which is the clock and not a regression in the loop (M5.4 added no work to the grid).
Wall-clock numbers on a laptop are only comparable to themselves at the same clock state, so
both are recorded rather than one being replaced.

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

## 12. Departure burns from a parking orbit

Section 11 ends with a number that is not a burn. A porkchop cell reports the two hyperbolic
excess speeds; a mission spends delta-v getting _out_ of a parking orbit and _into_ a capture
orbit. This section closes the departure half: given the excess speed a cell needs and the
direction it needs to leave on, what single impulsive burn puts the craft on that hyperbola,
and where on the orbit must it happen?

`core/transfer/departure.ts` does the physics; `ui/transferView.ts` turns the answer into a
maneuver node. Both are pure.

### 12.1 The closed form

Burn at radius `r` about a body of parameter `mu`, from a circular orbit at speed
`vc = sqrt(mu/r)`, onto a hyperbola whose excess speed is `v_inf`. Energy conservation fixes the
post-burn speed and, notably, not the geometry:

```text
w = sqrt(2 mu / r + v_inf^2)
```

With `A = mu / v_inf^2` the semi-major axis magnitude and `s^2 = e^2 - 1`, the conic equation at
the burn point plus the asymptote relation `cos nu_inf = -1/e` reduce to a quadratic in `s`:

```text
s^2 - k s sin(d) - k (1 - cos d) = 0,      k = r / A,   d = angle from burn point to asymptote
s = (k sin d + sqrt(k^2 sin^2 d + 4 k (1 - cos d))) / 2
e = sqrt(1 + s^2)
```

The `e` cancels out of the derivation, which is why this is closed form and not a root find:
no iteration appears in the geometry at all. The only search is over _which phase to burn at_.

The flight path angle of the post-burn velocity is

```text
gamma = atan2(s cos d + sin d, (1 - cos d) + s sin d)
```

and it is not zero in general. A burn along `+prograde` matches this only when the asymptote
lies in the parking plane and 90 degrees around it from the burn point. Everywhere else the burn
carries radial and normal components. That is not an artifact: it is the burn that has to be
flown, and reporting it in prograde/normal/radial is the whole point, because those are the
components a maneuver node stores.

### 12.2 The Oberth crossover is `v_inf = vc/2`

The textbook statement is "leaving from a deep well is cheaper than the excess speed suggests".
That is true only above a threshold, and the threshold is exact:

```text
sqrt(vc^2 + v^2) - vc < v      <=>      v > vc / 2
```

At 300 km above Earth `vc = 7.73 km/s`, so the crossover is 3.86 km/s - squarely inside the
interplanetary range. Below it the ideal burn costs _more_ than the excess speed, because most
of the fuel goes into cancelling the speed the craft already has. `oberthHelps` encodes the
inequality rather than the folklore, and both regimes are tested.

Measured on the default Earth-Mars window's cheapest cell (2028-11-21, `v_inf = 3.03 km/s`,
300 km park): the in-plane, at-periapsis floor is 3,615 m/s. Since 3.03 < 3.86, `oberthHelps`
is **false** for that cell - the burn costs more than the excess speed.

### 12.3 The burn is at `delta = nu_inf`, not 90 degrees from the aim

A first guess is "aim 90 degrees around the orbit from where I want to go", which is wrong and
expensive. The burn point that puts the craft at periapsis is the one where the angle to the
outbound asymptote equals the hyperbola's own `nu_inf = acos(-1/e)`, and that is neither 90 nor
a constant: measured 149.8 degrees at `v_inf = 3.06 km/s` from 300 km (e = 1.157), and 118.9
degrees at 8 km/s (e = 2.071), because a faster escape is a flatter hyperbola. It is the shape
of the hyperbola that decides where the burn goes, not the direction of the aim.

Measured at 300 km and `v_inf = 3.06 km/s`: burning with `delta = 90` costs 6,568 m/s against
the 3,622 m/s floor. `delta` near zero is a radial escape (infinite speed from a circular orbit)
and `delta` near pi sends the asymptote back through the body; both are rejected rather than
returned as a large number.

One consequence deserves its own sentence, because it is the module's least intuitive result:
at `delta = 90` degrees the solver still finds a valid hyperbola with `nu = 64.3` degrees, not
periapsis. The cost of that geometry is 6,568 m/s, which is 81% above the floor. "Aim at the
point 90 degrees ahead and burn" is not merely suboptimal; it is nearly twice the price.

### 12.4 The plane-change penalty is real and is reported, not hidden

The transfer plane is fixed by the burn point and the asymptote, so it contains the asymptote
but generally **not** the parking orbit's plane. When the two differ the burn must rotate the
velocity out of the parking plane, and that costs a plane change on top of the escape.

Measured on the cheapest default Earth-Mars cell (`v_inf = 3.03 km/s`, 300 km park, aim 25.9
degrees above the ecliptic):

| Parking inclination | Burn, m/s | Over the 3,615 floor | Aim elevation above park plane | Periapsis | Below surface |
| ------------------- | --------- | -------------------- | ------------------------------ | --------- | ------------- |
| 0°                  | 6,581     | +2,966               | +25.9°                         | 6,109 km  | yes           |
| 28.5°               | 5,560     | +1,945               | +18.2°                         | 6,354 km  | yes           |
| 51.6°               | 4,338     | +724                 | +8.8°                          | 6,592 km  | no            |
| 90°                 | 4,326     | +712                 | −8.7°                          | 6,594 km  | no            |

Two things in that table are worth stating plainly.

- **The cost falls as the parking inclination rises**, because the aim is 25.9 degrees above the
  ecliptic and a 51.6-degree park is closer to it than an equatorial one. A reader who expects
  "higher inclination is always worse" will read the table backwards; the elevation column is
  the explanation, and it is in the panel for exactly that reason.
- **The penalty is not small.** 2,966 m/s of plane change on a 3,615 m/s escape is 82% on top.
  For comparison, a full 28.5-degree rotation of the post-burn velocity (11.34 km/s) costs
  5,585 m/s on its own, so the forced penalty is the same order as the thing it replaces.

### 12.5 A below-surface periapsis is a warning, not a refusal

Four of the table's entries have a periapsis inside the Earth. That is not a contradiction and
not an error: the burn happens on the **outbound** leg at radius `r`, the true anomaly is
positive by construction, and the radius only grows afterwards, so the propagated path never
enters the body. The mission panel's own impact check agrees (no impact, minimum radius 6,921
km on the bundled 550 km mission).

It is still not flyable as a real mission: no departure would be accepted with its periapsis
inside the planet. So it is carried as a `below-surface` warning on the node and shown in the
panel, together with the fix (a parking plane nearer the target asymptote). Refusing outright
would hide the geometry that produced it; saying nothing would let a reader see "periapsis
5,893 km" beside "burn at 6,671 km" and reasonably conclude the code is broken.

### 12.6 The search over phase has two minima, so every minimum is refined

Cost as a function of burn phase is smooth but **not unimodal**. Measured over 200 random
geometry pairs, 101 had more than one local minimum (49/100 in the earlier sweep). A ternary
search from one bracket therefore returns a local minimum that is frequently not the global one,
and refining only the cheapest sample is the same mistake wearing a different hat.

The module samples the whole orbit (360 phases by default, one degree of arc), finds every
local minimum on the cyclic sample lattice, refines each with a 140-iteration ternary search,
and keeps the best. Measured against a 100,000-point dense scan over 400 random geometries the
worst disagreement was 5e-6 m/s; refining only the cheapest sample was wrong in 49% of the same
sweep. Raising the sample count to 720 or 1440 changed no answer.

Measured cost: 1.2 ms at 90 samples, 1.3 ms at 360, 1.9 ms at 720, for a full plan including the
search. The phase search is not the expensive part of the workflow - the grid is.

### 12.7 Timing: the burn happens within one parking period of the requested date

The cell's departure date is a calendar fact; the burn cannot happen at an arbitrary point on
the parking orbit. `planDeparture` returns a phase, and the node is placed at the **first
passage of that phase at or after** the requested instant:

```text
phaseAtRequest = orbit.phaseRad + n * (t_departure - t_epoch)
shiftSeconds   = wrapTo2Pi(plan.phaseRad - phaseAtRequest) / n
timeSeconds    = (t_departure - t_epoch) + shiftSeconds
```

Using `plan.timeToBurnSeconds` directly instead - which is the phase from the epoch - is wrong by
an arbitrary angle. Measured on a 314-day Earth-Mars cell at 300 km, the orbit has advanced
3.1e4 rad, so the node would sit at a phase unrelated to the one the solve costed and the burn
would not fly the trajectory the plot drew.

The shift is therefore at most one parking period: 90.4 minutes at 300 km, 95.5 at 550 km,
against a transfer of hundreds of days (0.02% of a 314-day flight). It is reported in the panel
rather than absorbed. The alternative - burning at the calendar instant wherever the craft
happens to be - can cost thousands of m/s, which is not a rounding error.

Measured on the default window's cheapest cell from a 550 km, 51.6° park: the burn lands 45
minutes after the requested date and costs 4.26 km/s (3.20 prograde, 2.53 normal, 1.23 radial)
for 3.03 km/s of excess speed.

### 12.8 Sampling: a planned departure aliases the drawn coast, and the panel says so

A departure node is legitimately months away while the parking orbit it departs from laps every
96 minutes. `propagateTrajectory` caps the whole horizon at `MAX_TRAJECTORY_POINTS`, so a 735-day
horizon draws 339 points - one sample per 2.77 orbits. The propagated states are still exact
closed-form solutions; the **drawn** coast is a star polygon rather than an orbit, and no number
in the panel would otherwise say so.

`periodFractionPerSample` makes that a number, `ALIASED_PERIOD_FRACTION = 0.125` is the
threshold (one sample per eight revolutions), and `MissionPanel` shows the caveat when it trips.
The bundled LEO raise is 0.010 (96 samples per orbit, dense); the planned 735-day departure is
2.772 (aliased). Extending the horizon to reach a far node is what creates the condition, so the
two facts belong together.

### 12.9 Tolerances

- **The requested excess speed is recovered exactly, 4 decimal places in m/s**, by an independent
  route: rebuild the hyperbola from the post-burn state (energy, eccentricity vector, true
  anomaly) and take `v_inf = sqrt(-mu/a)`. Measured agreement is at rounding. This is the
  strongest statement the module makes - the burn reaches the speed the cell asked for, verified
  without trusting the solver's bookkeeping.
- **The asymptote direction is recovered to `dot = 1` at 9 decimal places**, again from the state
  rather than from the solver. A one-degree aim error would show as 0.9998.
- **The coplanar at-periapsis case hits the Oberth floor to 1e-3 m/s.** Where a floor exists the
  solver must find it exactly; anything above it is a search failure, not physics.
- **The burn never costs less than the floor**, over 40 random geometries: `deltaV >=
idealDeltaV - 1e-6`. A negative saving is impossible and would mean a sign error.
- **A 6.9-degree out-of-plane aim at 300 km costs 4,116.8 m/s against a 3,622.0 floor**, pinned to
  0 decimal places. That number is a regression detector for the parking frame: it is the first
  place a wrong orbit normal shows up as a number rather than a picture.
- **The plane-change penalty rises monotonically with inclination** for a fixed ecliptic-ish aim
  (0, 10, 20, 28.5, 40, 51.6 degrees), and a fully coplanar aim hits the floor to 1 m/s.
- **The phase search agrees with a 60x720 brute-force scan within 0.05 m/s** across 12 random
  geometries, and beats a 180,000-point scan outright on a geometry measured to have two minima.
  The 0.05 bound is loose on purpose: it is a search-completeness test, not an arithmetic one.
- **The node's own numbers recover the same excess speed**: `sqrt((vc + prograde)^2 + normal^2 +
radial^2)` fed back through `w^2 = 2mu/r + v_inf^2` returns the cell's `v_inf` to 4 decimals.
  A panel that shows both the burn and the excess speed therefore cannot show two numbers that
  disagree.
- **The node time is at most one parking period after the requested instant**, asserted on a real
  cell: `0 <= shiftSeconds < parkingPeriod`.
- **Re-planning the same cell is idempotent**: `withManeuver` replaces by id, so the node count
  stays at one.

### 12.10 The two departure scenarios, and why their numbers are what they are

The bundled `gto-transfer` and `earth-mars-departure` scenarios carry hard-coded burns. A
hard-coded number in a scenario is a measurement, and a measurement that nobody re-derives goes
stale silently - so both are recomputed from the transfer physics in `tests/scenario.test.ts`
rather than merely asserted to be whatever the file says.

**GTO, 300 km to GEO, 28.5-degree park.** The two nodes are a Hohmann departure and a
circularisation with the plane change folded into it:

| Burn                      | Measured    | What it is                                         |
| ------------------------- | ----------- | -------------------------------------------------- |
| Perigee raise             | 2,427.8     | Hohmann departure, 300 km -> transfer ellipse      |
| Apogee: circularise only  | 1,467.6     | close the apogee-speed gap at 1,607 m/s            |
| Apogee: plane change only | 1,513.7     | 28.5 degrees at the circular speed, 3,075 m/s      |
| Apogee: done separately   | 2,981.2     | the two above, added                               |
| Apogee: combined          | **1,830.7** | one burn, components 1,095 prograde + 1,467 normal |
| Total                     | 4,258.4     | against a real GTO budget of roughly 4,300-4,500   |

The combined burn saves **1,150.6 m/s**, which is why every real GTO mission does it that way. The
reason is in the two speeds: a plane change costs `2 v sin(i/2)`, so it is cheap where `v` is
small - and at apogee the velocity is 1.61 km/s against 3.07 at GEO circular. Doing the plane
change at LEO instead would cost 1,514 m/s for the same 28.5 degrees at 7.73 km/s. That is not a
tuning detail; it is the difference between a flyable mission and an unflyable one.

**Earth to Mars, 300 km at 51.6 degrees.** No nodes: the scenario is a park with the 2028 window
inside the default plot range, and the first user action is a porkchop click. Measured from the
2028-11-01 epoch, the cheapest cell is 2028-11-21 at 3.03 km/s of excess speed, and the burn from
this park is 4,338 m/s over 51.6 degrees against 6,581 from an equatorial one. The budget of
4,700 m/s leaves 362 m/s of margin on that burn.

The 51.6-degree park is the load-bearing choice, and it is worth being explicit that the intuition
runs backwards here: a _higher_ parking inclination is _cheaper_ for this window, because the
asymptote is 25.9 degrees above the ecliptic and the aim only has to leave the parking plane by
8.8 degrees instead of 25.9. A reader who assumes "inclination is always a cost" will read the
table in 12.4 in the wrong direction; the elevation column is what resolves it.

One more consequence, stated because it looks like a bug and is not: at 3.03 km/s the excess speed
is **below** the 3.87 km/s Oberth crossover, so `oberthHelps` is false and the 3,615 m/s in-plane
floor is _above_ the cell's 3.03 km/s number. Departing slowly from a fast orbit costs more than
the excess speed, because most of the fuel cancels speed the craft already has.

## 13. Ground track

Where a satellite is, in latitude and longitude, over the rotating Earth. `M6.1`:
`src/core/groundTrack/groundTrack.ts`, purely computed, no panel yet (`M6.2` draws it).

### 13.1 Three frames, in order

The conversion is `heliocentric → Earth-relative → equatorial → Earth-fixed`. Each step is a
distinct failure mode, so each is a separate exported function and a separate test.

1. **Earth-relative.** The trajectory is stored heliocentrically, so the Earth's position is
   subtracted. It must be the position at **that sample's own time**, not at the scenario
   epoch. This is the same rule the 3D view now follows (§10.2, D-032): the epoch-relative form
   counts the Earth's own displacement twice, and here it is wrong by a wide margin — the Earth
   moves ~30 km/s, so one 96-minute revolution drifts ~170,000 km, or 27 Earth radii. Measured:
   freezing the origin at a fixed JD fails 7 of the 20 ground-track tests. (Until M5.5 §10.2
   documented the epoch anchor as the drawing convention; D-032 corrected it, and this module
   was written against the corrected rule.)

2. **Obliquity.** The physics frame is ecliptic-referenced (§10.4). Lat/lon are equatorial. The
   rotation is about the vernal equinox by `OBLIQUITY_J2000` = 23°26'21.448". Omitting it is
   not a small error: the ecliptic pole reports as 66.56° latitude instead of 90°, and a craft
   in the ecliptic plane reads 0° latitude instead of tracing ±23.44°. Measured: removing this
   rotation fails 8 of the 20 tests.

3. **Sidereal rotation.** Earth-fixed is the equatorial inertial frame turned by −GMST, so
   longitude is right ascension minus GMST. GMST here is the IAU-1982 polynomial in UT1 ≈ UTC
   (§1.3), so this module inherits that section's error bound and adds none.

### 13.2 Geocentric latitude, not geodetic

The latitude reported is **geocentric**: the spherical latitude of the radius vector. On the
WGS-84 ellipsoid the geodetic latitude differs by up to 0.19° (≈21 km at the equator). This is
a stated limit, not an oversight: the v1.0.0 map is a graticule with no coastlines (D-004), so
21 km is below one coarse pixel and an ellipsoid would add code without adding truth. It is
revisited if and when real coastlines arrive.

### 13.3 The antimeridian is a break in the line, not a jump across the map

Longitude wraps from +π to −π. A ground track drawn as an unbroken polyline therefore draws a
line the full width of the map at every wrap, which looks like a satellite teleporting and is
the single most common ground-track rendering bug. `buildGroundTrack` sets
`crossesAntimeridian` on the sample that ends such a segment, next to the wrap itself, so the
renderer never has to infer it from two longitudes it may not have. An undefined sample (craft
at the Earth's centre) also clears the previous longitude, so no crossing is claimed across a
gap — the track genuinely breaks there.

### 13.4 Tolerances

| Assertion                                           | Bound    | Why                                                                                                                                                                    |
| --------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vernal equinox fixed by the obliquity rotation      | 1e-12    | It is an identity: the equinox lies in both planes, so x is unchanged and y, z are exactly 0.                                                                          |
| Ecliptic pole at 90° − ε (≈66.5607°)                | 1e-9 rad | A published astronomical angle; the rotation is one matrix multiply, so only double rounding intervenes.                                                               |
| Length preserved by the obliquity rotation          | 1e-12    | Orthogonal rotation.                                                                                                                                                   |
| Rotation round trip                                 | 1e-12    | Two exact inverses.                                                                                                                                                    |
| Point at RA = GMST reports longitude 0              | 1e-12    | The definition of longitude; this is a definition check, not an accuracy claim.                                                                                        |
| Geostationary craft holds one longitude, 12 samples | 1e-7 rad | Two independently derived rates must agree: GMST (IAU-1982) and 2π/86164.0905 s. 1e-7 rad ≈ 0.6 m at the surface — far above rounding, far below a real rate mismatch. |
| Longitude sweeps a full turn per sidereal day       | 1e-6 rad | Same pair of constants over 86164 s; 1e-6 rad ≈ 6 m.                                                                                                                   |
| Equatorial orbit stays at latitude 0                | 1e-12    | Exact geometry: the offset is built in the equatorial plane.                                                                                                           |
| Altitude = 400 km flat over an hour                 | 3 mm     | Input radius is exact in the equatorial plane; only the GMST rotation and back are involved, both orthogonal to 1e-15.                                                 |

The 1e-7 and 1e-6 bounds above are the only "loose" ones and both exist to let two _different_
formulations of the sidereal rate be compared. They are not tolerances on the module's own
arithmetic; the module's arithmetic is checked at 1e-12 by the identity tests.

### 13.5 Drawing it: the panel, the projection, and what the map costs

`src/ui/groundTrackView.ts` (pure) and `src/ui/GroundTrackPanel.tsx` (canvas) draw the track from
M6.2. The projection is equirectangular, `x = (λ + π)/2π`, `y = (π/2 − φ)/π`, on a 2:1 rectangle,
with a 30° graticule and no coastlines (D-004).

**What the projection costs, stated rather than corrected.**

- No coastlines. A dot over Kansas is over Kansas only if the reader knows it. A coastline
  dataset is a licensing and accuracy question with no physics content, so it is absent and the
  panel says so in place.
- East-west stretch of `1/cos φ`. At 53° that is 1.66, at 76° it is 4.1. This is the projection,
  not an error, and it is why the same 1° of longitude is a different distance at different
  latitudes.
- Geocentric latitude (§13.2): up to 0.19°, about 21 km.

**The ecliptic datum is visible on the map, and it is correct.** The physics frame is
ecliptic-referenced (§10.4), so an orbit named "equatorial" in the scenario data is equatorial to
the _ecliptic_. Measured on the bundled `gto-transfer`: the final circular 35,793 km orbit sweeps
**±23.44° of latitude**, which is exactly `OBLIQUITY_J2000`, rather than sitting on the equator.
Likewise `leo-raise` at a 53° ecliptic inclination reaches **76.44° = 53 + 23.44**. Neither is a
projection bug: the map is right and the orbit's name is the approximation. This is the single
most useful thing the panel reveals, and it is asserted in `tests/groundTrackView.test.ts` at 0.1°
because a wrong obliquity sign or a skipped rotation would fail it loudly.

**The line breaks in two places, both computed in the core module.**

- At the antimeridian (`crossesAntimeridian`, D-031). Without the break the polyline runs from
  `x ≈ 0.99` to `x ≈ 0.01` and draws a line the full width of the map, which reads as the craft
  teleporting.
- After a dropped undefined sample (`startsAfterGap`, D-034). The craft sat at the Earth's centre,
  where no latitude exists, and the samples either side are not adjacent. The renderer is told
  where the hole is rather than inferring it from sample spacing, which fails on a short track.

**Two readouts of one craft differ by a chord sagitta (D-035).** The map's altitude comes from the
nearest propagated sample; the mission panel's live altitude comes from the drawn frame, which
interpolates straight lines between samples, so between samples it reports a chord radius
systematically inside the arc:

    s = r (1 − cos(θ/2)),   θ = arc length / r

| Plan      | Step    | Arc    | θ (rad) | Predicted | Measured worst |
| --------- | ------- | ------ | ------- | --------- | -------------- |
| LEO raise | 59.18 s | 449 km | 0.0628  | 3,526 m   | 3,642 m        |

0.05% of a 550 km altitude, invisible in the panel, and it shrinks with sample spacing rather than
with a code change. It is recorded because it _looks_ like the D-032 frame defect — the same shape
of "two readouts disagree" — and the numbers are what separate them: 3,642 m against 343,390 km.

**Measured map content**, read back from the canvas with `getImageData` (720 × 360). Graticule
counts differ slightly because the track is painted over it:

| Scenario               | Track px | Graticule px | Samples | Lines | Longitude span |
| ---------------------- | -------- | ------------ | ------- | ----- | -------------- |
| `leo-raise`            | 1,883    | 6,741        | 197     | 3     | 670.5°         |
| `gto-transfer`         | 602      | 6,779        | 1,755   | 2     | 129.2°         |
| `earth-mars-departure` | 948      | 6,764        | 92      | 2     | 337.3°         |

Two of those spans are worth reading as physics rather than as numbers:

- `leo-raise` spans 670.5°, more than a full revolution, because a 3.2 h plan at 550 km laps the
  Earth and the track overlaps itself.
- `earth-mars-departure` spans 337.3° in a 90-minute park. That is 360° of inertial travel minus
  the 22.5° the Earth rotates underneath in the same time - the ground track of one orbit is
  always short of a full turn by the rotation rate times the period. It is still flagged as
  partial coverage because the map needs a full 360° to close, and one pass does not.

## 14. The lunar free return

One burn, one loop around the far side of the Moon, home with no second burn. It is the scenario
that needs the Moon, and the first one in the catalogue that needs N-body integration to be a
scenario at all.

### 14.1 The burn, re-derived from vis-viva

A prograde impulse from the 300 km circular park is a two-body problem up to the point the Moon
matters, so the resulting orbit can be predicted, not merely propagated:

    v_circ = sqrt(mu_earth / r1),  r1 = R_earth + 300 km = 6,671 km
    v_after = v_circ + 3,115 m/s
    a = -mu / (2 (v_after²/2 - mu/r1))
    apogee = 2a - r1

| Quantity       | Value        |
| -------------- | ------------ |
| `v_circ`       | 7,729.9 m/s  |
| `v_after`      | 10,844.9 m/s |
| Semi-major `a` | 210,813 km   |
| Apogee         | 414,955 km   |
| Period         | 11.15 d      |

414,955 km from the Earth's centre clears the Moon's mean orbit of 384,400 km. The important
number is the _half_ period, 5.57 days: that is when an unperturbed craft would reach apogee, and
it is nearly twice the 3.27 days the real trajectory takes to reach the Moon. The craft is still
climbing when it meets the Moon, which is what makes the encounter a flyby rather than an arrival.
`tests/scenario.test.ts` asserts the apogee clears 384,400 km, and it is the first check that
would fail if the burn in the catalogue were edited to something that no longer reaches the Moon.

### 14.2 What actually happens, propagated

Measured with the scenario's own spec, 9-day horizon, all bodies (345 ms to build the plan):

| Event            | Time   | From the Moon's centre | Altitude |
| ---------------- | ------ | ---------------------- | -------- |
| Translunar burn  | T+0    | —                      | 300 km   |
| Lunar flyby      | T+3.27 | 4,431 km               | 2,694 km |
| Closest to Earth | T+6.36 | —                      | 686 km   |

The trajectory: outbound for 3.27 days, closest approach on the far side of the Moon, then a
return leg that reaches 686 km over the Earth at 6.36 days, still inside the horizon.

**The Moon is what turns the path around, and the numbers say so.** The unperturbed ellipse from
§14.1 would reach 414,955 km at 5.57 days. The real trajectory peaks at **373,475 km at 3.26
days** — 41,480 km _lower_, and 2.3 days _earlier_. At that instant the Moon's own geocentric
distance is 369,049 km, so the craft is 4,426 km farther from the Earth than the Moon is, and the
offset is almost entirely radial (4,425 km radial, 224 km transverse across 4,431 km of miss
distance). It passes on the outside of the Moon's orbit, which is the geometry of a far-side
flyby. The Moon absorbs the last 41,480 km of the climb and redirects it into the return.

With only `earth` and `sun` enabled, the same burn is the unperturbed ellipse: max geocentric
distance 415,412 km at 5.58 days, matching §14.1's 414,955 km at 5.57 days to 0.1% (the residual
being the Sun). The period is 11.15 days, so the horizon ends at 9 days with the craft 308,380 km
from the Earth and still inbound — no return. **The approach distance barely changes** (4,672 km
of lunar altitude against 2,694 km) because the burn is aimed at the Moon's position; only the
return distinguishes the two cases. This is D-036's trap, and it is why the no-Moon test asserts
the return ratio rather than the miss distance.

### 14.3 Sample convergence

The flyby is the one place in this project where a chaotic encounter could make a measurement
meaningless. It does not:

| Samples | Lunar periapsis (from centre) | Return (from centre) | Return altitude | Final, T+9 d |
| ------- | ----------------------------- | -------------------- | --------------- | ------------ |
| 600     | 4,460 km                      | 7,241 km             | 870 km          | 344,546 km   |
| 1,000   | 4,432 km                      | 7,318 km             | 947 km          | 344,544 km   |
| 1,400   | 4,429 km                      | 7,035 km             | 664 km          | 344,550 km   |
| 2,000   | 4,432 km                      | 7,071 km             | 700 km          | 344,549 km   |
| 3,000   | 4,432 km                      | 7,022 km             | 651 km          | 344,550 km   |
| 4,000   | 4,431 km                      | 7,045 km             | 674 km          | 344,553 km   |

Lunar periapsis varies by 31 km in 4,431 (0.7%) and the end state agrees to five significant
figures (344,544-344,553 km). The _return_ altitude wanders by 296 km, from 651 to 947, because it
is a near-grazing pass sampled once per 86 s at 600 samples and once per 13 s at 4,000 — a
periapsis-shaped quantity is always the worst-sampled thing on a discrete grid, and the return leg
is sampled from the same grid as the whole nine days.

This convergence check exists because an _intermediate_ run during development reported a 7,213 km
return where a 4,000-sample run gave 45,552 km — a real disagreement, caused by comparing runs
with different sample counts. Any change to the burn, the epoch or the inclination must re-run
this table, not just the test.

### 14.4 Sensitivity: this is a knife-edge, and that is the lesson

All rows from a single all-bodies run at the scenario's default sample count:

| Burn      | Lunar altitude | Return altitude         | Outcome                    |
| --------- | -------------- | ----------------------- | -------------------------- |
| 3,075     | 83,024 km      | −1,380 km               | misses, impacts Earth      |
| 3,095     | 23,157 km      | 283,388 km (never home) | misses                     |
| 3,105     | 2,801 km       | 359,995 km (never home) | passes the Moon, no return |
| 3,110     | −1,227 km      | —                       | impacts the Moon           |
| **3,115** | **2,694 km**   | **686 km at T+6.36**    | **free return**            |
| 3,120     | 8,980 km       | −5,746 km               | misses, impacts Earth      |
| 3,125     | 14,792 km      | 87,766 km (never home)  | misses                     |
| 3,135     | 24,459 km      | 375,808 km (never home) | misses                     |
| 3,155     | 37,628 km      | 392,456 km (never home) | misses                     |

±20 m/s — 0.64% of the burn — costs the flyby entirely. There is no gradual failure mode: the
outcomes are "impacts the Moon", "impacts the Earth", or "does not come home", and the free return
sits alone between them. That is exactly why Apollo's free-return trajectory was designed as a
family rather than a line, and why this scenario states its solution rather than inviting the user
to find one.

Two further parameters are equally sharp, and both are measured rather than assumed:

| Parking inclination | Lunar altitude |
| ------------------- | -------------- |
| 0°                  | 26,319 km      |
| **5°**              | **2,694 km**   |
| 10°                 | 24,938 km      |
| 28.6°               | 133,803 km     |
| 51.6°               | 240,580 km     |

The 5° is tuned, not "near the ecliptic": a perfectly ecliptic park misses because the Moon's
orbit is inclined 5.1° to the ecliptic and has drifted out of the plane the craft stays in. And the
epoch is a parameter in the same sense — the Moon's phase at `2027-04-07T12:00:00Z` is what makes
one prograde burn work, so the scenario is pinned to it (D-036).

### 14.5 What the scenario does not do

- It does not solve for a free return. It replays a measured one. A runtime solver (shooting on
  lunar periapsis and Earth-return altitude) is real work and is not in v1.0.0.
- It does not model the Moon's sphere of influence as a patched conic; the flyby is integrated
  through it with the restricted N-body acceleration, which is why the miss distance is 4,431 km
  rather than a conic section.
- **Impact detection only covers the central body.** `propagateTrajectory` sets `impacts` by
  comparing the path against `BODIES[centralBody].radius`, so a lunar impact (3,110 m/s, 1,227 km
  below the Moon's surface) is not flagged — the craft simply passes through the Moon. Earth
  impacts are flagged (3,075 and 3,120 m/s both are). This is a known limitation, asserted in
  §14.4's table as a number rather than shown as a warning in the app.
- It does not include the Earth's oblateness, the Sun's tides beyond point-mass gravity, or
  station-keeping. At 686 km on return the craft would need a burn in reality; the scenario's
  claim is trajectory-shaped, not mission-shaped.
