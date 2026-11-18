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
- **Prescribed ephemerides.** The massive bodies follow their tabulated elements and are not
  themselves integrated (ADR-0003). This is the restricted problem.
- **Newtonian gravity only.** No relativity, no oblateness (J₂), no drag, no solar
  radiation pressure. For LEO over long spans these omissions dominate; the UI says so.
- **Element precision near apsides** is capped at ~1.5e-8 relative by the conditioning of
  the true anomaly, as described in §2.1.
