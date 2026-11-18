# STATE

Snapshot of where the build actually stands. Updated at the end of every iteration.
"Passing" here means the command was run and its output read, not that it seemed fine.

## Environment

| Item     | Value                                                  |
| -------- | ------------------------------------------------------ |
| Node     | v24.22.0                                               |
| npm      | 11.19.1                                                |
| git      | 2.55.0                                                 |
| Platform | Windows / PowerShell                                   |
| Repo     | `D:\balaji\projects\Periapsis` (local only, no remote) |

## Verified status

Last run: `npx tsc --noEmit`, `npx eslint .`, `npx vitest run`.

| Check                      | Result                                            |
| -------------------------- | ------------------------------------------------- |
| Typecheck (`tsc --noEmit`) | PASS                                              |
| Lint (`eslint .`)          | PASS, 0 problems                                  |
| Unit tests (`vitest run`)  | PASS, 177 tests / 9 files                         |
| Build (`vite build`)       | FAIL — no `index.html` yet (M3 shell not written) |
| `npm run verify`           | FAIL, only because of the build step above        |

The build failure is expected, not a regression: Vite needs an entry HTML file and the 3D
application shell is M3. `verify` will go green when M3.1 lands. Nothing is being hidden
by leaving this red — the four checks are run individually and reported separately.

## Test inventory

| File                        | Tests | Covers                                                        |
| --------------------------- | ----- | ------------------------------------------------------------- |
| `tests/vec3.test.ts`        | 18    | vector algebra, rotations, frame conversions                  |
| `tests/time.test.ts`        | 18    | JD/calendar, leap seconds, GMST, ERA                          |
| `tests/kepler.test.ts`      | 13    | elliptic + hyperbolic solvers, high-eccentricity cases        |
| `tests/elements.test.ts`    | 13    | state <-> elements round trips, apsides                       |
| `tests/twoBody.test.ts`     | 15    | closed-form propagation, energy/angular-momentum conservation |
| `tests/integrators.test.ts` | 16    | RK4 + Dormand-Prince RK45, convergence order, drift           |
| `tests/ephemeris.test.ts`   | 28    | body positions, velocities, mean motion, SOI                  |
| `tests/nbody.test.ts`       | 21    | acceleration, dominant body, patched-conic re-parenting       |
| `tests/lambert.test.ts`     | 35    | Hohmann/bi-elliptic/plane change + Lambert solver             |

## Module inventory (`src/core`)

| Module                            | Status                                  |
| --------------------------------- | --------------------------------------- |
| `math/vec3.ts`, `math/numeric.ts` | complete, tested                        |
| `constants.ts`                    | complete (GM, AU, radii, day constants) |
| `time/time.ts`                    | complete, tested                        |
| `orbit/kepler.ts`                 | complete, tested                        |
| `orbit/elements.ts`               | complete, tested                        |
| `orbit/twoBody.ts`                | complete, tested                        |
| `integrate/integrators.ts`        | complete, tested                        |
| `ephemeris/solarSystem.ts`        | complete (JPL Table 1 verbatim)         |
| `ephemeris/ephemeris.ts`          | complete, tested                        |
| `ephemeris/nbody.ts`              | complete, tested                        |
| `transfer/transfers.ts`           | complete, tested                        |
| `transfer/lambert.ts`             | complete, tested (single revolution)    |

Not yet written: `src/sim/**` (simulation clock, warp, trajectory history), `src/render/**`
(Three.js), `src/ui/**` (React), `src/scenarios/**`, `index.html`, `src/main.tsx`.

## Milestones

| Milestone                 | Status                                                        |
| ------------------------- | ------------------------------------------------------------- |
| M0 scaffold               | done except React shell and state-file cleanup (M0.8)         |
| M1 physics foundation     | done (PHYSICS.md written)                                     |
| M2 N-body + solar system  | done                                                          |
| M3 3D shell               | not started                                                   |
| M4 spacecraft + maneuvers | not started                                                   |
| M5 mission planning       | M5.1 and M5.2 done; porkchop, workflow, scenarios outstanding |
| M6 ground track + Moon    | not started                                                   |
| M7 scenarios + polish     | not started                                                   |
| M8 hardening              | not started                                                   |

## Known limitations carried forward

- Lambert is single-revolution only; multi-revolution arcs report `converged: false`.
- Delta-v from solar-system ephemerides is indicative, not operational: JPL Table 1's Mars
  range carries ~25,000 km (~1.7e-4 AU) of error, which moves Earth-Mars delta-v by a few
  tens of m/s.
- Element round-trip near apsides is capped at ~1.5e-8 relative by true-anomaly
  ill-conditioning; tests are bounded accordingly and say so in comments.
