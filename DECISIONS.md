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
