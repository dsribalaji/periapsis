# ADR-0007 — Scenarios are validated data, not code

**Status:** accepted
**Date:** 2026-11-18

## Context

The app opens into a starting point: a date, a view, a body in focus. Those need to be
bundled, and M7.2 adds save, export and import. The question is what a "scenario" _is_ and
what guarantees loading one provides.

The tempting design is a scenario that carries the full state — body positions, spacecraft
state, camera — so it is a snapshot. The tempting validation is a TypeScript type and a cast.

## Decision

1. A scenario holds **only**: `schemaVersion`, `id`, `name`, `description`, `epochUtc`,
   `startWarp`, `focus`, and a `view` (radial mode, azimuth, elevation, distance, centred-on).
   It carries **no orbital state**.
2. Position is derived from the epoch at load time, always.
3. Validation is a **function returning a list of issues**, not a type guard, not a throw.
   Each issue names the field path.
4. The returned object is **rebuilt** from validated fields. Unknown properties are dropped.
5. Bundled scenarios are validated **at module load** with `assertScenario`, so a malformed
   built-in fails immediately and loudly.

## Why no orbital state

Position is a pure function of epoch. A scenario carrying position vectors could then
_contradict_ the ephemeris — and there would be no principled way to decide which is right.
Either the file wins (and the ephemeris is decorative) or the ephemeris wins (and the file's
numbers are a lie shown to the user). Both are worse than not having the field.

Storing the epoch means an imported scenario cannot produce a wrong orbit. The worst case is a
refusal to load.

## Why issues, not exceptions, not a type guard

- **A throw** gives the caller one message and no structure. An import screen needs to say
  "`view.distanceUnits`: must be positive", pointing at a field.
- **A type guard** returns a boolean, which is worse: the caller knows something is wrong and
  nothing about what.
- **A cast** (`as Scenario`) is the failure mode this design exists to prevent. It makes the
  compiler complicit in a lie.

Returning `{ok: false, issues: [{path, message}]}` means the same function serves the bundled
data, an imported file, and a test.

## Why rebuild the object

`validateScenario` returns a **new object** built field by field from validated values, not the
input with a cast. This means nothing unvalidated can ride along behind a passing check — an
extra property, an inherited value, a getter. The test asserts this directly
(`drops unknown properties instead of carrying them through`).

## Why validate bundled data

A bundled scenario is a build artefact, so an invalid one is a programming error. Failing at
module load means the app never half-starts. `assertScenario` produces a message naming the
scenario and the field, so the failure is a one-line fix rather than a debugging session.

## Consequences

**Good:** an invalid scenario can never produce a wrong trajectory; the error surface is
structured and reusable for the import UI; the same validation runs in tests, in the bundled
catalogue and later on imported files; the schema is versioned from the first release, which
is the change that is impossible to make cleanly later.

**Bad:** validation must be kept in step with the type by hand — TypeScript cannot prove
`validateScenario` covers every field. Mitigated by tests for every field path and by the
"validated twice is identical" idempotence test.

**Also:** a scenario cannot describe a state the ephemeris cannot produce. If a future feature
needs an arbitrary initial orbit, that is spacecraft state (M4), a separate concern — not a
scenario.

## Related

- `DECISIONS.md` D-009, D-010, D-011
- `ARCHITECTURE.md`, "`src/scenarios` — data, validated"
- `src/scenarios/validate.ts`, `tests/scenario.test.ts`
