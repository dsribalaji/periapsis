# ADR-0006 — Simulation clock: fixed step, clamped real time, coarsening as the release valve

**Status:** accepted
**Date:** 2026-11-18

## Context

A simulation that runs at warp 10⁷ has to reconcile three things that pull against each other:

1. **Warp must mean what it says.** Warp 1000 should advance 1000 simulated seconds per real
   second. A control that silently delivers less is lying.
2. **Results must be reproducible.** A trajectory that depends on how fast the machine rendered
   is not reproducible, and cannot be tested.
3. **A frame must fit in a frame.** At extreme warp, one frame's worth of simulated time
   divided by an accuracy-preserving step size is more steps than the frame budget allows.

Any two of these are easy. The design problem is choosing which one gives way.

## Decision

The clock is a **pure value object**, advanced by the caller passing in real elapsed
milliseconds. It owns three numbers: `simSeconds`, `warp`, `bankedSeconds`.

Per frame:

1. Clamp **real** elapsed time to `maxFrameMs` (250 ms). Never clamp owed simulation time.
2. Add `clampedMs/1000 × warp` to the bank.
3. If `bank / minStepSeconds` exceeds `maxStepsPerFrame`, **grow the step size** to
   `bank / maxStepsPerFrame` and run exactly `maxStepsPerFrame` steps. Report `throttled`.
4. Otherwise run `floor(bank / minStepSeconds)` steps at the accuracy floor and keep the
   remainder.

## Why clamp real time and not owed time

This is the detail that makes the other invariants hold at once.

At warp 1 with a 1 s accuracy floor and 16.7 ms frames, the clock must **accumulate several
frames before it can afford one step**. If owed time were clamped instead, it could never
reach the threshold and the clock would not move at all at low warp.

Clamping the real frame time gives the right protection — a backgrounded tab that reports a
60-second gap does not try to simulate 60 seconds in one frame — without breaking the bank's
ability to accumulate.

## Why coarsen instead of dropping time

At extreme warp there are three options: drop time (warp becomes a lie), stall (looks like a
hang), or integrate with a larger step (accuracy drops, still honest about time).

Coarsening is the only one where the visible behaviour still matches the control. The cost is
real and it is surfaced: the clock returns `throttled: true` and the UI shows a `coarse steps`
badge. A user at warp 10⁷ is told the integration has coarsened rather than being left to
assume the trajectory is as accurate as at warp 1.

## Consequences

**Good:**

- Warp is exact: over any interval, simulated time advanced equals warp × real time, within one
  step. Tested.
- Frame-rate independence: the same total real time produces the same simulated time and the
  same step sequence, whatever the frame pattern. Tested.
- Determinism: no wall clock, no RNG, so the clock is trivially reproducible and unit-testable.
- Pause discards banked time rather than accumulating it, so resuming does not jump.

**Bad:**

- Step size is a function of warp, not of the physics. A trajectory integrated at warp 10⁷ is
  coarser than the same trajectory at warp 1. That is a real accuracy difference, visible in
  the badge, and it is the correct trade for a real-time viewer — but a user who changes warp
  mid-mission gets a trajectory whose accuracy varies along its length. Noted as a limitation
  in `STATE.md`.
- The clock is not a timer. Anything that wants "advance in the background" has to drive it.

## Alternatives considered

- **Variable step from the integrator's own error control.** Better accuracy per step, but the
  step then depends on the trajectory, and reproducibility across warp changes is lost for the
  viewer path. The integrator still does this where it matters (restricted N-body propagation);
  the _clock_ stays fixed-step so time itself is predictable.
- **Real-time accumulator with no budget (just run all the steps).** Frame time explodes at high
  warp; the app stops responding.
- **Drop frames rather than coarsen.** Makes warp a lie at exactly the moment the user has asked
  for the most time compression.

## Related

- `src/sim/clock.ts` — the module header states the three invariants
- `tests/clock.test.ts`
- `DECISIONS.md` D-005 (integrator choice, a similar accuracy-versus-cost trade)
