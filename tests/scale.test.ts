import { describe, expect, it } from 'vitest';
import {
  displayRadius,
  displayRadiusFor,
  toScene,
  radialUnits,
  scalePosition,
  UNITS_PER_AU,
  UNITS_PER_M,
  MIN_DISPLAY_RADIUS,
} from '../src/render/scale.js';
import { AU_M, RADIUS } from '../src/core/constants.js';

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

  it('compresses radii by a cube root while preserving order', () => {
    const rEarth = displayRadius(RADIUS.earth);
    const rJupiter = displayRadius(RADIUS.jupiter);
    const rMoon = displayRadius(RADIUS.moon);
    const rSun = displayRadius(RADIUS.sun);

    expect(rSun).toBeGreaterThan(rJupiter);
    expect(rJupiter).toBeGreaterThan(rEarth);
    expect(rEarth).toBeGreaterThan(rMoon);
    // Earth is the reference radius.
    expect(rEarth).toBeCloseTo(1.2, 9);
  });

  it('turns a 1e3 radius ratio into roughly a 1e1 display ratio', () => {
    const ratio = displayRadius(RADIUS.jupiter) / displayRadius(RADIUS.earth);
    const trueRatio = RADIUS.jupiter / RADIUS.earth;
    // Cube root of the true ratio: 10.97^(1/3) ~ 2.2
    expect(ratio).toBeCloseTo(Math.cbrt(trueRatio), 9);
    expect(ratio).toBeLessThan(trueRatio);
  });

  it('keeps every body visible above the minimum size', () => {
    for (const [, r] of Object.entries(RADIUS)) {
      expect(displayRadius(r)).toBeGreaterThan(0);
    }
    expect(displayRadiusFor('moon', RADIUS.moon)).toBeGreaterThanOrEqual(MIN_DISPLAY_RADIUS);
  });

  it('draws the Moon large enough to see beside Earth', () => {
    const moon = displayRadiusFor('moon', RADIUS.moon);
    const plain = displayRadius(RADIUS.moon);
    // The deliberate 1.6x exaggeration for visibility.
    expect(moon).toBeCloseTo(Math.max(MIN_DISPLAY_RADIUS, plain * 1.6), 9);
  });

  it('applies the minimum radius to tiny bodies', () => {
    expect(displayRadiusFor('mercury', 1)).toBe(MIN_DISPLAY_RADIUS);
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
