# ADR-0001 — Pure physics core with a lint-enforced boundary

**Status:** accepted
**Date:** 2026-11-18

## Context

Orbital mechanics code accumulates rendering and UI concerns if nothing prevents it. The
usual failure mode is not a wrong equation: it is a propagator that reads `Date.now()` deep in
its call stack, or a transfer solver that reaches for a React state setter to report progress.
Once that happens the physics can no longer be tested without a browser, its results are no
longer reproducible, and every rendering refactor becomes a physics risk.

A written rule ("the core must stay pure") does not survive contact with a deadline. A rule
checked by a human in review decays the first time someone is in a hurry.

## Decision

`src/core/**` and `src/sim/**` are pure TypeScript with **zero runtime dependencies**. They:

- import nothing from React, React DOM or Three.js, and nothing from `src/ui` or `src/render`
- never read the wall clock (`Date`, `Date.now`, `performance.now`)
- never use `Math.random`
- never call `fetch` or touch `localStorage`

Enforced by ESLint `no-restricted-imports`, `no-restricted-globals` and
`no-restricted-properties`, configured for those two directories only. A violation fails
`npm run lint`, which fails `npm run verify`.

Time and randomness enter as parameters. The clock is a value object the caller advances;
the starfield uses a deterministic lattice hash.

## Consequences

**Good:**

- Physics is testable in Node with no DOM and no browser. 254 tests run in about a second.
- Results are reproducible: same inputs, same numbers, any machine.
- The rendering layer has been rewritten twice during M3 with no physics risk, because the
  dependency arrow only points one way.
- Pure functions are trivially unit-testable, and the test suite is the physics evidence.

**Bad:**

- Some genuinely convenient things are forbidden. A progress callback during a long
  integration has to be passed in, not reached for.
- The scene layer must convert and pass data explicitly rather than reading simulation state.
  That is more plumbing, and it is the plumbing that keeps the boundary real.
- An honest risk: a developer can satisfy the letter of the rule by moving impurity one layer
  up into a module that is not lint-covered. The mitigation is that `src/render` and `src/ui`
  are small and have a single entry point each.

## Alternatives considered

- **Written convention plus code review.** Rejected: decays, and the failure is silent.
- **Separate package in a monorepo.** A stronger boundary, but adds build complexity and a
  publish step for an app that ships as one bundle. The lint rule gets most of the benefit for
  none of the cost.
- **Dependency injection of a clock everywhere.** Rejected as over-engineering: passing
  elapsed milliseconds into `advanceClock` is enough, and `Simulation` already owns the epoch.

## Related

- `DECISIONS.md` D-002
- `ARCHITECTURE.md`, "The one rule everything else follows"
