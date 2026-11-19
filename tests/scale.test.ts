import { describe, expect, it } from 'vitest';
import {
  drawnRadiusUnits,
  localUnitsPerMetre,
  MIN_PIXEL_RADIUS,
  radialUnits,
  satelliteResolvable,
  scaleOffset,
  scalePosition,
  toScene,
  trueRadiusUnits,
  unitsPerPixelAt,
  UNITS_PER_AU,
  UNITS_PER_M,
} from '../src/render/scale.js';
import { AU_M, RADIUS } from '../src/core/constants.js';
import { BODY_IDS } from '../src/core/ephemeris/solarSystem.js';

describe('scene scale', () => {
  it('puts one AU at the chosen unit distance', () => {
    expect(AU_M * UNITS_PER_M).toBeCloseTo(UNITS_PER_AU, 9);
  });

  it('maps an AU-scale position to a camera-visible range', () => {
    const [x, y, z] = toScene(AU_M, 0, 0);
    expect(x).toBeCloseTo(100, 9);
    expect(y).toBeCloseTo(0, 9);
    expect(z).toBeCloseTo(0, 9);
  });

  it('rotates physics z to scene y and physics y to scene -z', () => {
    // Physics north must be scene up, and handedness must be preserved.
    const [, yUp, zBack] = toScene(0, 0, AU_M);
    expect(yUp).toBeCloseTo(100, 9);
    expect(zBack).toBeCloseTo(0, 9);

    const [, y2, z2] = toScene(0, AU_M, 0);
    expect(y2).toBeCloseTo(0, 9);
    expect(z2).toBeCloseTo(-100, 9);
  });

  it('preserves distances under the frame change', () => {
    const p = [1.2 * AU_M, 0.3 * AU_M, -0.4 * AU_M] as const;
    const [sx, sy, sz] = toScene(p[0], p[1], p[2]);
    const physicsLength = Math.hypot(p[0], p[1], p[2]);
    const sceneLength = Math.hypot(sx, sy, sz);
    expect(sceneLength / physicsLength).toBeCloseTo(UNITS_PER_M, 15);
  });
});

/**
 * One scale for positions and sizes.
 *
 * The regression these guard is the one that shipped in v1.0.0: bodies were drawn 282x too
 * large, satellites were pushed out by the same factor to clear them, and the Moon ended up
 * three quarters of the way from Earth to the Sun. With a single scale, every relation below
 * holds by construction, and the tests say so in the numbers a user would check.
 */
describe('true-scale bodies', () => {
  it('draws Earth at its real radius on the same scale as its orbit', () => {
    const earth = trueRadiusUnits(RADIUS.earth);
    expect(earth).toBeCloseTo(RADIUS.earth * UNITS_PER_M, 15);
    // 1 AU is 23,481 Earth radii, and the scene must say the same.
    expect(UNITS_PER_AU / earth).toBeCloseTo(AU_M / RADIUS.earth, 6);
  });

  it("puts the Moon 60 Earth radii out: well clear of Earth, well inside Earth's orbit", () => {
    const earth = trueRadiusUnits(RADIUS.earth);
    const moon = trueRadiusUnits(RADIUS.moon);
    const separation = 3.844e8 * UNITS_PER_M;
    expect(separation / earth).toBeCloseTo(60.3, 1);
    expect(separation).toBeGreaterThan(earth + moon);
    // The v1.0.0 placement drew the Moon 72 units from Earth, 0.72 of the way to the Sun.
    // The true separation is 0.26% of Earth's orbit radius.
    expect(separation / UNITS_PER_AU).toBeLessThan(0.003);
  });

  it('draws the Moon at its true size ratio to Earth', () => {
    const ratio = trueRadiusUnits(RADIUS.moon) / trueRadiusUnits(RADIUS.earth);
    expect(ratio).toBeCloseTo(0.2727, 3);
  });

  it('puts a 400 km orbit just above the true surface', () => {
    const surface = trueRadiusUnits(RADIUS.earth);
    const orbit = (RADIUS.earth + 400e3) * UNITS_PER_M;
    expect(orbit).toBeGreaterThan(surface);
    expect(orbit / surface).toBeCloseTo(1.0628, 3);
  });

  it('keeps the scene frame convention for offsets', () => {
    const [x, y, z] = scaleOffset(1, 2, 3, 10);
    expect(x).toBeCloseTo(10, 12);
    expect(y).toBeCloseTo(30, 12);
    expect(z).toBeCloseTo(-20, 12);
  });
});

describe('minimum on-screen size', () => {
  const fov = (45 * Math.PI) / 180;

  it('measures a pixel from the camera distance and field of view', () => {
    // At distance d a 45-degree view is 2 d tan(22.5 deg) = 0.828 d tall.
    expect(unitsPerPixelAt(100, fov, 828.4)).toBeCloseTo(0.1, 4);
    expect(unitsPerPixelAt(0, fov, 800)).toBe(0);
    expect(unitsPerPixelAt(100, fov, 0)).toBe(0);
  });

  it('draws a body at its true size once it is resolvable', () => {
    // Earth from 0.05 units on an 850 px viewport is about 44 px in radius: no floor applies.
    const earth = trueRadiusUnits(RADIUS.earth);
    const upp = unitsPerPixelAt(0.05, fov, 850);
    expect(drawnRadiusUnits(earth, upp, MIN_PIXEL_RADIUS.earth)).toBe(earth);
  });

  it('holds a distant body at the minimum pixel radius instead of letting it vanish', () => {
    // Earth from the 320-unit inner-system camera is 0.01 px across at true size.
    const earth = trueRadiusUnits(RADIUS.earth);
    const upp = unitsPerPixelAt(320, fov, 850);
    const drawn = drawnRadiusUnits(earth, upp, MIN_PIXEL_RADIUS.earth);
    expect(drawn / upp).toBeCloseTo(MIN_PIXEL_RADIUS.earth, 9);
    expect(drawn).toBeGreaterThan(earth);
  });

  it('never draws a body smaller than it really is', () => {
    for (const id of BODY_IDS) {
      for (const upp of [0, 1e-6, 1e-3, 1]) {
        const t = trueRadiusUnits(RADIUS[id]);
        expect(drawnRadiusUnits(t, upp, MIN_PIXEL_RADIUS[id])).toBeGreaterThanOrEqual(t);
      }
    }
  });

  it('ranks the markers like the bodies: Sun, giants, then rocky planets, then the Moon', () => {
    const px = MIN_PIXEL_RADIUS;
    expect(px.sun).toBeGreaterThan(px.jupiter);
    expect(px.jupiter).toBeGreaterThan(px.earth);
    expect(px.earth).toBeGreaterThan(px.mercury);
    expect(px.mercury).toBeGreaterThan(px.moon);
  });
});

describe('satellite resolvability', () => {
  it('hides a satellite whose marker would overlap its parent', () => {
    // Inner-system view: the Moon is a fraction of a pixel from Earth.
    expect(satelliteResolvable(0.8, 3.8, 2.4)).toBe(false);
  });

  it('shows it once there is a visible gap between the two discs', () => {
    expect(satelliteResolvable(9.2, 3.8, 2.4)).toBe(true);
    expect(satelliteResolvable(9.1, 3.8, 2.4)).toBe(false);
  });

  it('shows the Moon in the Earth-Moon pair view', () => {
    // The pair camera stands 1.7x the separation away, so the separation spans about 70% of
    // the viewport height: hundreds of pixels against discs of a few.
    const separation = 3.844e8 * UNITS_PER_M;
    const upp = unitsPerPixelAt(separation * 1.7, (45 * Math.PI) / 180, 850);
    const earthPx = trueRadiusUnits(RADIUS.earth) / upp;
    const moonPx = Math.max(MIN_PIXEL_RADIUS.moon, trueRadiusUnits(RADIUS.moon) / upp);
    expect(satelliteResolvable(separation / upp, earthPx, moonPx)).toBe(true);
  });
});

describe('local scale', () => {
  it('is the true scale under the linear layout, at any distance', () => {
    expect(localUnitsPerMetre(AU_M, 'linear')).toBe(UNITS_PER_M);
    expect(localUnitsPerMetre(30 * AU_M, 'linear')).toBe(UNITS_PER_M);
  });

  it('is the slope of the compressed map at that distance', () => {
    const r = AU_M;
    const h = 1e-4 * AU_M;
    const slope = (radialUnits(r + h, 'compressed') - radialUnits(r - h, 'compressed')) / (2 * h);
    expect(localUnitsPerMetre(r, 'compressed') / slope).toBeCloseTo(1, 6);
  });

  it('shrinks with distance under compression, so the outer planets are drawn smaller', () => {
    expect(localUnitsPerMetre(30 * AU_M, 'compressed')).toBeLessThan(
      localUnitsPerMetre(AU_M, 'compressed'),
    );
  });
});
describe('radial mapping', () => {
  it('is identity-equivalent to linear at the linear conversion factor', () => {
    const r = 2.5 * AU_M;
    expect(radialUnits(r, 'linear')).toBeCloseTo(250, 9);
  });

  it('compresses the outer system into a viewable range', () => {
    const neptune = radialUnits(30.1 * AU_M, 'compressed');
    const mercury = radialUnits(0.39 * AU_M, 'compressed');
    // Linear would put these at 3010 and 39 units; compressed must fit them both on screen.
    expect(neptune).toBeLessThan(300);
    expect(mercury).toBeGreaterThan(20);
    // And the ratio is far gentler than the physical 77x.
    expect(neptune / mercury).toBeLessThan(5);
  });

  it('preserves ordering exactly', () => {
    const radiiAu = [0.39, 0.72, 1, 1.52, 5.2, 9.5, 19.2, 30.1];
    const mapped = radiiAu.map((au) => radialUnits(au * AU_M, 'compressed'));
    for (let i = 1; i < mapped.length; i++) {
      expect(mapped[i]!).toBeGreaterThan(mapped[i - 1]!);
    }
  });

  it('is strictly monotone, so orbits can never cross', () => {
    let prev = -Infinity;
    for (let au = 0.05; au < 40; au *= 1.07) {
      const v = radialUnits(au * AU_M, 'compressed');
      expect(v).toBeGreaterThan(prev);
      prev = v;
    }
  });

  it('preserves direction while changing only magnitude', () => {
    const x = 0.6 * AU_M;
    const y = -0.8 * AU_M; // exactly 1 AU from the Sun
    const [sx, sy, sz] = scalePosition(x, y, 0, 'compressed');
    const mapped = radialUnits(AU_M, 'compressed');
    // The frame maps physics (x, y) into the scene's (x, -z) plane, so the in-plane angle
    // must be unchanged once that mapping is accounted for.
    expect(Math.atan2(sz, sx)).toBeCloseTo(Math.atan2(-y, x), 12);
    expect(sy).toBeCloseTo(0, 12);
    expect(Math.hypot(sx, sy, sz)).toBeCloseTo(mapped, 9);
  });

  it('leaves linear mode identical to the plain conversion', () => {
    const p = scalePosition(1.2 * AU_M, 0.3 * AU_M, -0.4 * AU_M, 'linear');
    expect(p).toEqual(toScene(1.2 * AU_M, 0.3 * AU_M, -0.4 * AU_M));
  });

  it('handles the origin without dividing by zero', () => {
    const [x, y, z] = scalePosition(0, 0, 0, 'compressed');
    expect(x).toBeCloseTo(0, 12);
    expect(y).toBeCloseTo(0, 12);
    expect(z).toBeCloseTo(0, 12);
  });

  it('keeps a circular orbit circular under compression', () => {
    // Six points on a 5.2 AU circle must all map to the same scene radius.
    const radii: number[] = [];
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * 2 * Math.PI;
      const [x, y, z] = scalePosition(
        5.2 * AU_M * Math.cos(a),
        5.2 * AU_M * Math.sin(a),
        0,
        'compressed',
      );
      radii.push(Math.hypot(x, y, z));
    }
    const first = radii[0]!;
    for (const r of radii) expect(r).toBeCloseTo(first, 9);
  });
});
