import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/sim/simulation.js';
import { AU_M, SECONDS_PER_DAY } from '../src/core/constants.js';
import { BODIES } from '../src/core/ephemeris/solarSystem.js';
import { jdFromIsoUtc } from '../src/core/time/time.js';

const EPOCH = '2026-11-18T00:00:00Z';

describe('simulation driver', () => {
  it('starts at the requested epoch', () => {
    const sim = new Simulation(EPOCH);
    expect(sim.jdUtc).toBeCloseTo(jdFromIsoUtc(EPOCH), 9);
    expect(sim.simSeconds).toBe(0);
  });

  it('advances the Julian date with simulation time', () => {
    const sim = new Simulation(EPOCH);
    sim.setJdUtc(sim.jdUtc + 1); // one day forward
    expect(sim.simSeconds).toBeCloseTo(SECONDS_PER_DAY, 3);
  });

  it('reports the JD it was set to', () => {
    const sim = new Simulation(EPOCH);
    const target = jdFromIsoUtc('2027-03-01T12:00:00Z');
    sim.setJdUtc(target);
    expect(sim.jdUtc).toBeCloseTo(target, 6);
    expect(sim.snapshot().isoUtc).toBe('2027-03-01T12:00:00Z');
  });

  it('provides a position for every body', () => {
    const sim = new Simulation(EPOCH);
    const pos = sim.positions();
    for (const id of Object.keys(BODIES)) {
      expect(pos.has(id as never)).toBe(true);
    }
  });

  it('keeps the Sun at the origin and Earth about 1 AU away', () => {
    const sim = new Simulation(EPOCH);
    const pos = sim.positions();
    const sun = pos.get('sun')!;
    expect(Math.hypot(sun.x, sun.y, sun.z)).toBe(0);

    const earth = pos.get('earth')!;
    const r = Math.hypot(earth.x, earth.y, earth.z) / AU_M;
    expect(r).toBeGreaterThan(0.98);
    expect(r).toBeLessThan(1.02);
  });

  it('puts the Moon near the Earth, not the Sun', () => {
    const sim = new Simulation(EPOCH);
    const pos = sim.positions();
    const earth = pos.get('earth')!;
    const moon = pos.get('moon')!;
    const separation = Math.hypot(moon.x - earth.x, moon.y - earth.y, moon.z - earth.z);
    // The Moon's mean distance is 384,400 km.
    expect(separation / 1e9).toBeLessThan(0.5);
    expect(separation / 1e6).toBeGreaterThan(300);
  });

  it('moves bodies as time advances', () => {
    const sim = new Simulation(EPOCH);
    const before = sim.positions().get('earth')!;
    sim.setJdUtc(sim.jdUtc + 30);
    const after = sim.positions().get('earth')!;
    const moved = Math.hypot(after.x - before.x, after.y - before.y, after.z - before.z);
    // Earth travels ~26 km/s, so 30 days is a large displacement.
    expect(moved).toBeGreaterThan(0.1 * AU_M);
  });

  it('honours pause', () => {
    const sim = new Simulation(EPOCH, 0);
    const jd0 = sim.jdUtc;
    for (let i = 0; i < 100; i++) sim.advance(16.667);
    expect(sim.jdUtc).toBe(jd0);
  });

  it('reports steps taken when running', () => {
    const sim = new Simulation(EPOCH, 1e6);
    const result = sim.advance(16.667);
    expect(result.steps).toBeGreaterThan(0);
  });

  it('is deterministic', () => {
    const a = new Simulation(EPOCH, 1000);
    const b = new Simulation(EPOCH, 1000);
    for (let i = 0; i < 50; i++) {
      a.advance(16.667);
      b.advance(16.667);
    }
    expect(a.jdUtc).toBe(b.jdUtc);
    const pa = a.positions().get('mars')!;
    const pb = b.positions().get('mars')!;
    expect(pa).toEqual(pb);
  });

  it('keeps the TT/UTC relationship consistent', () => {
    const sim = new Simulation(EPOCH);
    // TT is about 69.184 s ahead of UTC in 2026.
    expect((sim.jdTt - sim.jdUtc) * SECONDS_PER_DAY).toBeCloseTo(69.184, 3);
  });
});

describe('simulation reset', () => {
  it('restarts at a new epoch and rewind to zero elapsed time', () => {
    const sim = new Simulation(EPOCH, 1e4);
    for (let i = 0; i < 20; i++) sim.advance(16.667);
    expect(sim.simSeconds).toBeGreaterThan(0);

    sim.reset('2027-03-01T12:00:00Z', 1e3);
    expect(sim.simSeconds).toBe(0);
    expect(sim.warp).toBe(1e3);
    expect(sim.jdUtc).toBeCloseTo(jdFromIsoUtc('2027-03-01T12:00:00Z'), 9);
  });

  it('moves the bodies to the new epoch, not the old one', () => {
    const sim = new Simulation(EPOCH);
    const earthBefore = { ...sim.positions().get('earth')! };
    sim.reset('2027-03-01T12:00:00Z', 1);
    const earthAfter = sim.positions().get('earth')!;
    const moved = Math.hypot(
      earthAfter.x - earthBefore.x,
      earthAfter.y - earthBefore.y,
      earthAfter.z - earthBefore.z,
    );
    // Over ~103 days Earth travels most of a quadrant of its orbit.
    expect(moved).toBeGreaterThan(0.1 * AU_M);
  });

  it('survives being reset while paused, and unpauses to the requested warp', () => {
    const sim = new Simulation(EPOCH, 0);
    expect(sim.paused).toBe(true);
    sim.reset(EPOCH, 1e5);
    expect(sim.paused).toBe(false);
    expect(sim.advance(16.667).steps).toBe(120);
  });

  it('produces an identical state to a freshly constructed simulation', () => {
    // The renderer and frame loop hold a reference to this object, so reset must be
    // equivalent to reconstruction or a scenario switch carries stale state.
    const reset = new Simulation(EPOCH, 1e4);
    for (let i = 0; i < 30; i++) reset.advance(16.667);
    reset.reset('2028-01-01T00:00:00Z', 100);

    const fresh = new Simulation('2028-01-01T00:00:00Z', 100);
    expect(reset.jdUtc).toBe(fresh.jdUtc);
    expect(reset.simSeconds).toBe(fresh.simSeconds);
    expect(reset.warp).toBe(fresh.warp);

    reset.advance(16.667);
    fresh.advance(16.667);
    expect(reset.jdUtc).toBe(fresh.jdUtc);
    expect(reset.positions().get('jupiter')).toEqual(fresh.positions().get('jupiter'));
  });
});
