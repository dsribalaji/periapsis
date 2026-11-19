# ADR-0004 — Dormand-Prince RK45 is the default integrator

**Status:** accepted
**Date:** 2026-11-18

## Context

Two propagators are needed: one for production trajectories, one for tests that must be
reproducible. Candidates were RK4 fixed-step, Dormand-Prince RK5(4) adaptive, and a symplectic
scheme.

The governing fact is eccentricity. A Molniya orbit (e = 0.74) spends minutes near periapsis
and days near apogee. Its local timescale varies by more than an order of magnitude over one
revolution. A fixed-step method must size its step for the periapsis passage, which sets the
step everywhere.

## Decision

- **Dormand-Prince RK5(4) with adaptive step** is the default for restricted N-body
  propagation.
- **RK4 with a fixed step** is retained and used where bitwise-reproducible trajectories
  matter: regression tests, before/after comparisons, and any place where the step sequence
  must not depend on a tolerance.
- Symplectic integrators are **not** used.

## Why

Measured on a Molniya-like orbit (e = 0.74), to a matched accuracy:

| Method               | Force evaluations |
| -------------------- | ----------------- |
| RK4, h = 30 s        | 28,720            |
| DP5(4), relTol 1e-10 | 7,336             |

A factor of 3.9 for the same accuracy. The gap widens with eccentricity, and it is entirely
concentrated where it should be: RK4 burns evaluations at apogee where nothing is happening.

This is asserted as **accuracy per evaluation**, not as wall-clock time, so the test is
machine-independent and cannot start passing for the wrong reason on a faster CPU.

**Why not symplectic:** symplectic schemes (leapfrog, Störmer-Verlet) conserve a shadow
Hamiltonian and avoid long-term energy drift, which sounds ideal for orbits. Two reasons it is
the wrong tool here:

1. Energy drift is not the error that matters in this app. The dominant error is the ephemeris
   model's own ~25,000 km for Mars, three orders of magnitude larger than any integrator drift
   over the app's useful span. Optimising drift is optimising the wrong term.
2. The restricted N-body field is time-dependent (the planets move), which is exactly the case
   where symplectic integrators lose their advantage: they are second-order at best for
   non-autonomous systems, and the shadow-Hamiltonian argument no longer applies.

**Why keep RK4 at all:** the adaptive integrator's step sequence is a function of a tolerance,
which is fine in production and wrong in a regression test. RK4 at a fixed step produces
bitwise-identical output for identical input, and it is the reference against which the
adaptive scheme is measured.

## Consequences

**Good:** production trajectories are cheap and accurate where it counts; the fixed-step path
gives reproducible tests; the choice is justified by measurement rather than by preference.

**Bad:** two code paths, and the adaptive one has a tolerance parameter that a user can get
wrong. Mitigated by defaulting it to a value the tests cover (relTol 1e-12 for the energy-drift
test, 1e-10 for typical transfers) and by the fact that the drift is documented to saturate:
tightening relTol past 1e-12 stops helping because `maxStep` binds, so the API cannot be
pushed into a regime where "more precision" becomes a lie.

**Also:** adaptive steps mean a trajectory is not stored on a uniform time grid. Any consumer
that assumes uniform samples must interpolate, and the dense-output interpolant is part of the
DP5(4) formulation precisely so this is available.

## Related

- `DECISIONS.md` D-005
- `PHYSICS.md` §3, including the measured drift figures and the saturation note
- `src/core/integrate/integrators.ts`
