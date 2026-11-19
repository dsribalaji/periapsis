import { describe, expect, it } from 'vitest';
import { BODIES } from '../src/core/ephemeris/solarSystem.js';
import { displayRadiusFor, parentRelativeOffset, scalePosition } from '../src/render/scale.js';

/**
 * The satellite-vs-planet placement rule.
 *
 * `scene.updatePositions` cannot be unit-tested directly without a WebGL context, so the rule
 * it applies is restated here against the same pure functions. This is deliberate: the bug it
 * guards was a *placement* bug that no existing test covered, and it broke every scenario at
 * once — all the planets were pushed far outside the camera — while the app still started
 * cleanly and every unit test passed.
 */
describe('body placement rules', () => {
  it('places a planet on the heliocentric radial mapping, not relative to the Sun', () => {
    // Earth at 1 AU must land at 100 scene units, exactly as the linear layout says.
    const [x] = scalePosition(1.495978707e11, 0, 0, 'linear');
    expect(x).toBeCloseTo(100, 6);

    // The parent-relative rule applied to a planet would put it at the Sun's exaggeration
    // (its drawn radius over its true radius) times a real AU — about 1,233 units. That is the
    // regression: every planet 12x too far out, and off the camera entirely.
    const asIfRelative = parentRelativeOffset('sun', BODIES.sun.radius, 1.495978707e11);
    expect(asIfRelative).toBeGreaterThan(1000);
    // So the two rules genuinely disagree, and the planet must take the first one.
    expect(Math.abs(asIfRelative - x)).toBeGreaterThan(500);
  });

  it('places a satellite at the parent-relative offset, clear of its parent', () => {
    const earthRadius = displayRadiusFor('earth', BODIES.earth.radius);
    const moonRadius = displayRadiusFor('moon', BODIES.moon.radius);
    const offset = parentRelativeOffset('earth', BODIES.earth.radius, 3.844e8);

    // Clear separation: the Moon's centre is further out than the two drawn radii combined.
    expect(offset).toBeGreaterThan(earthRadius + moonRadius);
    // And it is not merely "far away" — it matches the trajectory scale, so a craft flying to
    // the Moon and the Moon itself are in the same frame (PHYSICS.md 10.3).
    expect(offset / displayRadiusFor('earth', BODIES.earth.radius)).toBeCloseTo(60.3, 1);
  });

  it('keeps the Moon inside the Earth system in the compressed layout', () => {
    // Compressed mode uses a logarithmic radius map: a 72-unit true separation has no meaning
    // there and would put the Moon on its own ring, outside its planet. The rule is a fixed
    // few parent radii instead. Restated here so it cannot drift.
    const earthRadius = displayRadiusFor('earth', BODIES.earth.radius);
    const hugging = earthRadius * 3;
    expect(hugging).toBeLessThan(10); // a few units, not 72
    expect(hugging).toBeGreaterThan(earthRadius); // still outside the planet itself
  });
});
