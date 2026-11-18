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

**Choice:** treat a solution as non-convergent when either speed exceeds 3e7 m/s.
**Why:** the bound is about model validity, not numerics. A one-revolution arc can be made
arbitrarily fast by collapsing toward a rectilinear plunge (`h -> 0`); "1 AU in 10
seconds" has a finite, computable answer at ~70c. Nothing diverges numerically, so without
this bound the solver reports a physically meaningless result as `converged: true`. The
threshold sits far above any real heliocentric transfer (New Horizons departed at
~16 km/s) and far below the regime where a Newtonian two-body model has any meaning.
