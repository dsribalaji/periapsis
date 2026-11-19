# ADR-0008 — Bodies at true scale, visible by a minimum size in pixels

**Status:** accepted (supersedes the body-radius clause of ADR-0002)
**Date:** 2026-11-20

## Context

ADR-0002 drew body radii with a cube-root compression (Earth at 1.2 scene units, 282x its true
0.00426) while positions stayed linear. That was enough while the scene only had planets. It
broke the moment it had to show anything _around_ a planet:

- A 400 km orbit at true scale is inside a 282x Earth, so trajectories were drawn at Earth's
  exaggeration too.
- The Moon then had to be drawn at the same exaggeration so the free-return flyby met it. That put
  the Moon 72.4 units from Earth, with Earth 100 units from the Sun: three quarters of the way to
  the Sun, sweeping through the orbits of Mercury, Venus and Mars. The README's own Earth-Moon
  screenshot showed the Moon beside the Sun.
- The next attempt (uncommitted) hid the Moon whenever the camera was far away. That stopped
  showing the wrong position without correcting it, and the "Earth and Moon" scenario, the one
  built to show both, opened with the Moon hidden.

Every patch kept the exaggeration and moved something else to compensate for it. Each was a
second scale, and two scales cannot both be true about the same picture.

## Decision

One scale for every length: positions, body radii, satellite offsets, orbit paths and
trajectories all use `UNITS_PER_M` (100 units per AU).

Visibility becomes a screen-space rule. Each frame, every body is drawn at
`max(true radius, MIN_PIXEL_RADIUS[body] × size of a pixel at its distance)`. A satellite is drawn
only once its disc is at least 3 px clear of its parent's on screen.

The compressed whole-system layout keeps its logarithmic positions; body-centred geometry there
uses the map's local slope at the parent's distance.

## Why

- **It cannot be wrong in the way the old design was.** With one scale, the Moon is 60.3 Earth
  radii from an Earth of the right size, by construction. No test has to restate a placement
  rule, because there is no rule left to get wrong.
- **It is how planetarium software works**, including the reference the user pointed at
  (theskylive.com's 3D solar system): bodies are real-sized up close and fixed-size markers far
  away, and nothing moves between the two.
- **Zoom becomes meaningful.** Zooming in on Earth shows the Moon separate from it and then the
  Moon's real orbit; zooming in further shows Earth at its real size with a 550 km orbit hugging
  it. Under the old design, zoom only magnified a fixed distortion.

Rejected:

- **Keep the exaggeration, hide satellites at system zoom.** Rejected on the evidence above: it
  hides the position instead of fixing it, and it hid the Moon in the scenario built to show it.
- **Exaggerate satellite orbits by a zoom-dependent factor.** Rejected: the Moon would move
  relative to Earth as you zoom, so its drawn position would depend on the camera. That is a
  second scale that changes over time, which is worse than a fixed one.
- **Per-body exaggeration with insets.** The same dynamic-range problem as ADR-0002's rejected
  inset, and two pictures of one system.

## Consequences

**Good:**

- The Earth-Moon scenario shows both bodies, at true size and separation.
- Trajectories, the Moon, and the Moon's orbit path agree to the metre, in both layouts.
- Picking improved: the minimum-pixel marker is the click target, so distant planets are easier
  to hit than the old 0.35-unit floor allowed.

**Bad:**

- The renderer needs a logarithmic depth buffer and a camera that follows its target. Both are
  real machinery: the follow camera in particular is a behaviour change (the view no longer
  stays put while a framed body moves away).
- Camera distances in scenario files changed meaning for body-centred views. That is a schema
  change (version 2) with a migration that divides by the old exaggeration, so a v1 file opens
  framed the way it was saved.
- Heliocentric orbit lines are meaningless at Earth-Moon scale and are faded out below about 1.5
  scene units, so a close-up no longer shows them.
- Per-frame cost: one projection per body and per label. Negligible at ten bodies; it would need
  revisiting for thousands of small bodies.

## Related

- `src/render/scale.ts` — `drawnRadiusUnits`, `satelliteResolvable`, `localUnitsPerMetre`
- `src/render/scene.ts` — per-frame sizing, label declutter, follow camera
- `src/scenarios/migrate.ts` — `migrate1to2`, `legacyExaggeration`
- `PHYSICS.md` §10.3, `DECISIONS.md` D-047
