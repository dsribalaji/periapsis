# ADR-0005 — Lambert's problem: universal variables, bisection on time of flight

**Status:** accepted
**Date:** 2026-11-18

## Context

Lambert's problem — given r₁, r₂ and a time of flight, find the connecting conic — is the core
of interplanetary targeting and the engine behind the porkchop plot. It has to be right for
every geometry the app will meet: short way and long way, near-180° and near-0°, elliptic and
hyperbolic, Earth-centred and heliocentric.

This is the classic problem where nearly-right implementations look right. The failure is not
usually a crash: it is an answer that silently matches the wrong branch.

Three decisions were needed: formulation, root-finding strategy, and handling of the two
degenerate geometries (exactly antipodal, impossibly fast).

## Decision

1. **Universal-variable (Stumpff) formulation**, single revolution.
2. **Root found by bisection on the time of flight** over the auxiliary variable `z`, not by
   Newton and not by bracketing the sign of `y`.
3. **The exactly-antipodal case is solved in closed form**, bypassing the universal-variable
   path entirely.
4. **Solutions above 0.1c are reported as non-convergent.**

## Why

### Formulation

Universal variables handle elliptic and hyperbolic arcs in one code path with no case analysis
on the conic type, which removes the branch that most implementations get wrong. The Stumpff
functions `c(z)`, `s(z)` make the equations continuous through the parabolic limit.

### Root finding: bisection on time of flight

The time of flight is **strictly monotone increasing in `z`** over the valid domain, running
from 0 to +∞. That single property makes bisection unconditionally convergent: no initial
guess, no divergence, no case where the iteration wanders into `y < 0`.

Two alternatives were implemented or analysed and rejected on measurement, not on taste:

- **Newton on `z`.** Needs a good initial guess, and can step into the region where `y < 0`
  (no real arc exists), from which it does not recover.
- **Bracketing the sign change of `y`.** This is not merely slower — it is **wrong for
  long-way arcs** (`A < 0`), where `y` is positive for all `z`. The bracket search never
  terminates. Measured, not theorised.

The cost of bisection is iteration count, which is irrelevant: a porkchop plot runs hundreds of
solves per pixel grid, not millions per second.

### The 180° case

At Δν = π the coefficient `A = sin Δν · √(r₁r₂ / (1−cos Δν))` is exactly zero, so `g = 0` and
`v₁ = (r₂ − f r₁)/g` is a 0/0 limit.

**Perturbing the angle does not fix this.** `sin Δν` sets the entire magnitude of `A`: at
ε = 1e-6 rad, `A` collapses by ~1e-6 while `√(r₁r₂)` does not (measured ratio 7e-7). The
result is garbage, not a small correction.

The geometry is also genuinely over-determined: with r₁ and r₂ antipodal about the focus, both
lie on the apse line, so they _are_ the apsides and exactly one elliptic arc connects them.
The implication is not "handle a singularity", it is "solve the closed form":

```
a = (r₁ + r₂)/2        speeds from vis-viva        v₂ = −v₁ direction
```

with non-convergence reported unless the requested time of flight is within 0.1% of that
transfer's half-period.

Verified against the independent Hohmann closed form: 2334.0 / 1434.0 m/s for
7000 → 42000 km about Earth, matched to 0.1 m/s. This is the decisive test, because a 180°
Lambert arc _is_ a Hohmann transfer, so two independent implementations must agree.

### The 0.1c bound

A one-revolution arc can be made arbitrarily fast by collapsing toward a rectilinear plunge
(`h → 0`). "1 AU in 10 seconds" has a finite, computable answer at about 70c, and nothing
diverges numerically on the way. Without the bound, the solver reports a physically meaningless
result with `converged: true`.

The threshold is a **model-validity** bound, not a numerical one: far above any real
heliocentric transfer (New Horizons departed at ~16 km/s) and far below the regime where a
Newtonian two-body model means anything.

## Consequences

**Good:** no divergence cases; the same code path serves both conic families; the two degenerate
geometries produce honest answers with measured justification; the solver is validated by an
independent formula _and_ by propagation, which share no code path with it.

**Bad:** single revolution only. Multi-revolution arcs report `converged: false` rather than an
approximate answer, which is visible as a gap rather than a wrong number — a stated limitation,
not a hidden one.

**Also:** near `z → 4π²`, `c(z) → 0` and the time of flight → ∞, so the upper bracket must back
off geometrically. Handled explicitly and covered by a test.

## Related

- `DECISIONS.md` D-006, D-007, D-008
- `PHYSICS.md` §8, including the tolerance table
- `src/core/transfer/lambert.ts`
- `tests/lambert.test.ts`
