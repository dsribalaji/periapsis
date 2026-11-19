# Architecture Decision Records

Each ADR records one decision that shaped the codebase: the context, the choice, what was
rejected and why, and what it costs. ADRs are append-only — a superseded decision keeps its
file and gains a **Status** line saying what replaced it.

`DECISIONS.md` holds the smaller judgment calls that did not need this much space.

| ADR                                     | Decision                                                                         | Status   |
| --------------------------------------- | -------------------------------------------------------------------------------- | -------- |
| [0001](ADR-0001-pure-core.md)           | Pure physics core with a lint-enforced boundary                                  | accepted |
| [0002](ADR-0002-radial-scales.md)       | Solar system view: two radial modes, both labelled                               | accepted |
| [0003](ADR-0003-restricted-nbody.md)    | Restricted N-body: prescribed ephemerides, one integrated spacecraft             | accepted |
| [0004](ADR-0004-integrator-default.md)  | Dormand-Prince RK45 is the default integrator                                    | accepted |
| [0005](ADR-0005-lambert.md)             | Lambert: universal variables, bisection on time of flight                        | accepted |
| [0006](ADR-0006-simulation-clock.md)    | Simulation clock: fixed step, clamped real time, coarsening as the release valve | accepted |
| [0007](ADR-0007-scenario-validation.md) | Scenarios are validated data, not code                                           | accepted |
| [0008](ADR-0008-true-scale-bodies.md)   | Bodies at true scale, visible by a minimum size in pixels                        | accepted |

## Writing a new one

Copy the shape of an existing file:

```
# ADR-NNNN — Title

**Status:** proposed | accepted | superseded by ADR-NNNN
**Date:** YYYY-MM-DD

## Context
What forced a decision. Facts, measurements, constraints.

## Decision
What was chosen, stated plainly enough to be quoted.

## Why
The argument, including alternatives that were rejected and on what evidence.

## Consequences
Good and bad, both honestly. A consequence section with only good news is not finished.

## Related
Files, tests and other decisions this touches.
```

An ADR that records only the option that was taken is a press release. The rejected options
and their measured costs are the part that stops the same debate from reopening.
