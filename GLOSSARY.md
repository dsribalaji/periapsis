# GLOSSARY

Terms used in the code, the UI and the docs. Where a term has a specific meaning in this
project that differs from the general one, that is stated.

## Orbital mechanics

**Anomaly** — a position angle along an orbit. Three flavours: _true_ (ν, from the focus,
measured from periapsis), _eccentric_ (E, the auxillary angle used to solve Kepler's
equation), _mean_ (M, the time-proportional angle). They agree at periapsis and apoapsis and
nowhere else.

**Apoapsis / periapsis** — the farthest and nearest points of an orbit from its focus.
"Apsis" alone means either. The project is named for the latter.

**Argument of periapsis (ω)** — the angle from the ascending node to periapsis, measured in
the orbital plane.

**Ascending node** — where an orbit crosses the reference plane going north. Its longitude,
Ω, is one of the six classical elements.

**Bi-elliptic transfer** — a two-burn-and-a-coast-plus-two-burn transfer through a very high
apsis. Beats Hohmann for large radius ratios (above ~11.94) despite being slower.

**Classical orbital elements** — the six parameters `(a, e, i, Ω, ω, ν)` or `(a, e, i, Ω, ω, M)`
that define a conic orbit and a position on it.

**Conic** — the curve a two-body orbit follows: ellipse (e < 1, bound), parabola (e = 1,
marginal), hyperbola (e > 1, unbound).

**Delta-v (Δv)** — the scalar sum of velocity changes a mission needs. The currency of mission
design: an impulsive burn of Δv is free in this model, but the budget is not.

**Free return** — a trajectory that loops around a body and comes back to the origin without a
further burn, e.g. Apollo's figure-eight around the Moon.

**GTO (geostationary transfer orbit)** — an elliptical Earth orbit whose apogee is at
geostationary altitude; a standard staging point for comsats.

**Hohmann transfer** — the minimum-delta-v two-impulse transfer between two circular coplanar
orbits. Optimal exactly when the radius ratio is below ~11.94.

**Impulsive burn** — a velocity change applied instantaneously at one point. The model this
app uses. Finite burns are out of scope for v1.0.0.

**Inclination (i)** — the angle between an orbit's plane and the reference plane.

**Kepler's equation** — `M = E − e·sin E`, the transcendental relation between mean and
eccentric anomaly. Solving it is the innermost loop of every propagator; see `PHYSICS.md` §2.2.

**Lambert's problem** — given two position vectors and a time of flight, find the orbit that
connects them. The core of interplanetary targeting; see `PHYSICS.md` §8.

**LEO (low Earth orbit)** — an Earth orbit below ~2,000 km altitude.

**Mean motion (n)** — the average angular rate, `sqrt(μ/a³)`. This project derives it from the
tabulated rate `L̇ − ϖ̇` rather than from the semi-major axis, so it stays consistent with the
source elements.

**Osculating** — the instantaneous two-body orbit that matches a state vector at one instant.
"Osculating elements" are those of that tangent orbit, and they wobble as perturbations act.

**Patch point** — where a trajectory is re-parented from one body's sphere of influence to
another's. Patched conics assume the transition is instantaneous and the gravity of only one
body matters at a time.

**Porkchop plot** — a contour map of launch Δv (or C3) against departure and arrival date.
Named for the shape of the contour lines.

**Prograde / retrograde / normal / radial** — the local burn directions: along velocity, against
velocity, along the orbit normal, and along the radius vector.

**Semi-major axis (a)** — half the long axis of the orbit; with μ it fixes the period.

**Sphere of influence (SOI)** — the region around a body where its gravity dominates the
Sun's (or its parent's) for trajectory purposes. Laplace's approximation, `r_SOI = a·(m/M)^(2/5)`.

**State vector** — position and velocity at an instant, `(r, v)`. Interchangeable with classical
elements; this project converts both ways and tests the round trip.

**Stumpff functions** — `c(z)`, `s(z)`, the series that make Kepler's equation work for all
conic types including the parabolic limit. Lambert's universal-variable formulation needs them.

**Transfer time** — the coast duration of a transfer arc. For Lambert, the input; for Hohmann,
half the transfer ellipse's period.

**True anomaly (ν)** — the angle from periapsis, measured at the focus.

**Universal variables** — a formulation of the two-body problem using a universal anomaly that
stays valid across elliptic and hyperbolic arcs, so one code path solves both.

## Time and frames

**Ecliptic** — the plane of Earth's orbit, the reference plane for the solar-system view.
Physics +z points toward its north pole.

**Epoch** — the instant at which simulated time is zero. A scenario's starting date.

**ERA (Earth rotation angle)** — the angle of Greenwich from the celestial intermediate origin,
the modern replacement for GMST in the rotation chain.

**GMST (Greenwich mean sidereal time)** — the angle of Greenwich from the mean equinox. Used
for the inertial → Earth-fixed rotation in ground tracks.

**JD (Julian date)** — days since noon UTC on 1 January 4713 BC. `JD_UTC` is the civil scale;
`JD_TT` is what the ephemerides are evaluated at.

**J2000** — the reference epoch 2000-01-01 12:00 TT, JD 2451545.0.

**Leap second** — an occasional inserted second keeping UTC within 0.9 s of UT1. This project
tabulates them and converts UTC → TAI → TT rather than assuming a constant offset.

**TAI** — International Atomic Time, the continuous scale.

**TT (Terrestrial Time)** — TAI + 32.184 s. The scale the ephemerides want; the timescale
astronomers use for barycentric dynamics.

**UT1** — the Earth-rotation timescale. This project approximates UT1 ≈ UTC, which is within
0.9 s by definition of the leap-second system.

**Warp** — this project's term for the simulation rate: **simulation seconds per real second**.
Warp 1000 means one second of wall time is 1000 simulated seconds. It is not a frame-rate
multiplier.

## This project's own terms

**Compressed radial mode** — the logarithmic mapping of heliocentric distance to scene units.
Ordering and angles are exact; distances and sizes are not. Labelled in the UI.

**Display radius** — a body's drawn size, a cube-root-compressed function of its true radius, so
that a satellite and a star are both visible in the same scene.

**Linear radial mode** — the honest mapping: scene units proportional to metres. Only the inner
solar system fits on screen this way.

**Pure core** — `src/core` and `src/sim`: zero runtime dependencies, no DOM, no wall clock, no
randomness. Enforced by lint, not convention.

**Readout** — a text value published from the frame loop at ~10 Hz rather than every frame.

**Scenario** — a validated starting point (epoch, warp, focus, camera). It contains no orbital
state by design; see `DECISIONS.md` D-009.

**Step coarsening** — when a frame cannot afford enough integration steps at the accuracy floor,
the step size grows to fit the budget and the UI shows `coarse steps`. Time is never dropped.
