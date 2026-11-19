import { describe, expect, it } from 'vitest';
import { poleEcliptic, SPIN_SENSE } from '../src/render/poles.js';
import { BODY_IDS } from '../src/core/ephemeris/solarSystem.js';
import { OBLIQUITY_J2000 } from '../src/core/constants.js';

const DEG = 180 / Math.PI;

/** Angle between a pole and ecliptic north, degrees. */
const tiltFromEcliptic = (id: Parameters<typeof poleEcliptic>[0]) =>
  Math.acos(poleEcliptic(id).z) * DEG;

describe('spin axes', () => {
  it('returns unit vectors', () => {
    for (const id of BODY_IDS) {
      const p = poleEcliptic(id);
      expect(Math.hypot(p.x, p.y, p.z), id).toBeCloseTo(1, 12);
    }
  });

  it("tilts Earth's axis by the obliquity, toward the June Sun", () => {
    const p = poleEcliptic('earth');
    expect(tiltFromEcliptic('earth')).toBeCloseTo(OBLIQUITY_J2000 * DEG, 9);
    // In June the Sun is at ecliptic longitude 90 deg (+y as seen from Earth). The northern
    // hemisphere has summer then, so the pole leans toward +y, and has no x component.
    expect(p.x).toBeCloseTo(0, 12);
    expect(p.y).toBeGreaterThan(0);
  });

  it('matches the textbook obliquities, give or take the orbit inclinations', () => {
    // Obliquity is measured from the body's own orbit normal; the ecliptic differs from that by
    // the orbital inclination (at most 3.4 deg for Venus here), so a few degrees of slack.
    expect(tiltFromEcliptic('mars')).toBeCloseTo(25.2, -1);
    expect(tiltFromEcliptic('saturn')).toBeGreaterThan(24);
    expect(tiltFromEcliptic('saturn')).toBeLessThan(30);
    expect(tiltFromEcliptic('jupiter')).toBeLessThan(4);
  });

  it('lays Uranus on its side', () => {
    // The IAU "north" pole is the one on the north side of the invariable plane, which for
    // Uranus is 82 deg from ecliptic north; it spins retrograde about it, so its angular
    // momentum points the other way, at the textbook 98 deg obliquity.
    const tilt = tiltFromEcliptic('uranus');
    expect(tilt).toBeGreaterThan(80);
    expect(tilt).toBeLessThan(85);
    expect(180 - tilt).toBeCloseTo(97.8, -1);
  });

  it('marks Venus and Uranus as retrograde rotators', () => {
    expect(SPIN_SENSE.venus).toBe(-1);
    expect(SPIN_SENSE.uranus).toBe(-1);
    expect(SPIN_SENSE.earth).toBe(1);
  });
});
