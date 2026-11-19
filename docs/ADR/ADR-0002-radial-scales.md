# ADR-0002 — Solar system view: two radial modes, both labelled

**Status:** accepted
**Date:** 2026-11-18

## Context

The solar system spans four orders of magnitude in orbital radius and another two in body
size. A single linear view cannot show it:

- At true scale, framing Neptune (30 AU, 3,010 scene units at 100 units/AU) puts Earth at ~3%
  of that radius. Measured on the actual render, the default camera shows **2,846 non-background
  pixels** — only Mercury, Venus and Earth exist at all, and they are specks.
- Framing the inner system instead leaves everything beyond Mars off screen.

Body radii make it worse. The Sun's radius is ~109 Earth radii; drawn to scale next to a
100-unit-Earth orbit, one or the other is a single pixel.

The requirement is a view that is _useful_ and _not deceptive_. Those pull in opposite
directions, so the problem is to choose where to be dishonest and say so.

## Decision

Two user-selectable radial modes, both labelled in the UI:

1. **Linear (true scale).** Positions in scene units are exactly proportional to metres.
   Honest, and sufficient for the inner system, which is where most mission design happens.
   Everything beyond it is drawn (the scene does not clip) but sits outside the frustum, and
   the View panel names exactly which bodies are off screen rather than leaving the user to
   guess.

2. **Compressed.** Scene radius is `75·log10(1 + r_AU/0.05)`, which maps 0.39 AU to 71 units
   and 30 AU to 209 units. Every body fits in a disc the camera can frame, and the measurement
   confirms it: **22,909 non-background pixels** and `Every body is on screen`.

**Body radii are cube-root compressed in both modes** (`1.2·(r/r_earth)^(1/3)`, floor 0.35
units), so ordering and rough relative size survive while a 10⁷ radius ratio becomes ~2×10².

> **Superseded by ADR-0008** (2026-11-20) for body radii: bodies are now drawn at true scale with
> a minimum size in pixels. The two radial modes in this ADR are unchanged.

What the compressed mode preserves exactly, and this is what makes it acceptable rather than
merely convenient:

- It is a **pure function of distance from the Sun**, so relative angles and hence the shape of
  the planetary configuration are exact.
- It is **radial and monotone**, so circular orbits stay circular and no body can cross
  another. Ordering can never invert.

What it does not preserve is distance and size, and that is stated in the UI's accuracy panel
and in the mode's own tooltip.

## Consequences

**Good:**

- The app opens in the honest mode, so the default is not misleading.
- The compressed mode is genuinely usable: every planet visible in one frame, at correct
  angles, for the first time.
- Because the mapping is radial and monotone, no scenario can ever be misread as a collision
  or an overtake — the failure mode that has made other logarithmic solar-system views
  misleading.

**Bad:**

- Two modes means two sets of orbit rings, rebuilt on toggle, and a camera distance that
  depends on the mode.
- A user who does not read the label can still be misled. Mitigated, not solved, by naming the
  off-screen bodies and putting the caveat in the accuracy panel.
- Cube-root radii mean the drawn size ratio between the Sun and Earth is wrong by a large
  factor. It is wrong _consistently_, and it is labelled.

## Alternatives considered

- **Logarithmic distance only.** Rejected: one mode that is never to scale, forever, with no
  honest reference. Keeping linear as the default costs little.
- **Linear with a movable camera only.** Rejected: no camera distance makes both Earth and
  Neptune clickable.
- **Broken-axis / segmented scale.** Rejected: it visually implies continuity where none
  exists, which is worse than an honest compression because it does not look like one.
- **True radii with a separate inset view.** Doesn't fit the single-canvas scope, and the
  inset has the same dynamic-range problem.

## Related

- `DECISIONS.md` D-004 (graticule-only map, a similar honesty trade-off)
- `src/render/scale.ts` — the constants and the derivation of the mapping
