import { describe, expect, it } from 'vitest';
import {
  altitude,
  bodyVelocity,
  heliocentricDistanceAu,
  heliocentricState,
  propagateTrajectory,
  radiusFromBody,
  remainingDeltaV,
  type Spacecraft,
} from '../src/sim/trajectory.js';
import { totalDeltaV, type Maneuver } from '../src/sim/maneuver.js';
import { BODIES } from '../src/core/ephemeris/solarSystem.js';
import { bodyPosition } from '../src/core/ephemeris/ephemeris.js';
import { jdTtFromJdUtc, jdFromIsoUtc } from '../src/core/time/time.js';
import { hohmannTransfer } from '../src/core/transfer/transfers.js';
import { AU_M, SECONDS_PER_DAY } from '../src/core/constants.js';
import { vec3 } from '../src/core/math/vec3.js';

const EPOCH_ISO = '2026-11-18T12:00:00Z';
const EPOCH_TT = jdTtFromJdUtc(jdFromIsoUtc(EPOCH_ISO));
const EARTH_MU = BODIES.earth.mu;
const EARTH_R = BODIES.earth.radius;

/** A circular Earth orbit at the given altitude, satellite-relative. */
function circularAroundEarth(altitudeM: number) {
  const r = EARTH_R + altitudeM;
  return { position: vec3(r, 0, 0), velocity: vec3(0, Math.sqrt(EARTH_MU / r), 0) };
}

function craft(patch: Partial<Spacecraft> = {}): Spacecraft {
  return {
    id: 'sc',
    name: 'Test craft',
    centralBody: 'earth',
    ...circularAroundEarth(400e3),
    deltaVBudget: 1000,
    maneuvers: [],
    ...patch,
  };
}

function burn(patch: Partial<Maneuver> = {}): Maneuver {
  return { id: 'b1', timeSeconds: 0, a: 0, b: 0, c: 0, frame: 'local', ...patch };
}

describe('spacecraft initial state', () => {
  it('adds the central body position to the relative state', () => {
    const sc = craft();
    const helio = heliocentricState(sc, EPOCH_TT);
    const earth = bodyPosition('earth', EPOCH_TT);
    expect(helio.r.x - earth.x).toBeCloseTo(sc.position.x, 3);
    expect(helio.r.y - earth.y).toBeCloseTo(sc.position.y, 3);
  });

  it('reports altitude above the body surface, not radius', () => {
    const sc = craft();
    const helio = heliocentricState(sc, EPOCH_TT);
    expect(altitude(helio.r, 'earth', EPOCH_TT)).toBeCloseTo(400e3, 0);
  });

  it('gives Earth a heliocentric speed near 29.8 km/s', () => {
    const v = bodyVelocity('earth', EPOCH_TT);
    const speed = Math.hypot(v.x, v.y, v.z);
    expect(speed).toBeGreaterThan(28e3);
    expect(speed).toBeLessThan(31e3);
  });
});

describe('trajectory propagation', () => {
  it('returns points starting at the epoch state', () => {
    const sc = craft();
    const traj = propagateTrajectory(sc, {
      horizonSeconds: 3600,
      mode: 'twoBody',
      epochJdTt: EPOCH_TT,
    });
    expect(traj.points[0]!.timeSeconds).toBe(0);
    const helio = heliocentricState(sc, EPOCH_TT);
    expect(traj.points[0]!.r.x).toBeCloseTo(helio.r.x, 3);
  });

  it('keeps a circular orbit circular over one full period', () => {
    const period = 2 * Math.PI * Math.sqrt((EARTH_R + 400e3) ** 3 / EARTH_MU);
    const sc = craft();
    const traj = propagateTrajectory(sc, {
      horizonSeconds: period,
      mode: 'twoBody',
      epochJdTt: EPOCH_TT,
      samples: 200,
    });

    for (const p of traj.points) {
      const r = radiusFromBody(p.r, 'earth', EPOCH_TT + p.timeSeconds / SECONDS_PER_DAY);
      // Geocentric radius stays at the orbital radius throughout.
      expect(r).toBeGreaterThan(EARTH_R + 399e3);
      expect(r).toBeLessThan(EARTH_R + 401e3);
    }
  });

  it('closes the loop: one period returns to the starting point', () => {
    const period = 2 * Math.PI * Math.sqrt((EARTH_R + 400e3) ** 3 / EARTH_MU);
    const sc = craft();
    const traj = propagateTrajectory(sc, {
      horizonSeconds: period,
      mode: 'twoBody',
      epochJdTt: EPOCH_TT,
      samples: 64,
    });
    // Compare geocentric positions: the craft is Earth-relative, and over one LEO period the
    // Earth itself travels 165,000 km along its heliocentric orbit.
    const earthAt = (t: number) => bodyPosition('earth', EPOCH_TT + t / SECONDS_PER_DAY);
    const first = traj.points[0]!;
    const last = traj.points[traj.points.length - 1]!;
    const e0 = earthAt(first.timeSeconds);
    const e1 = earthAt(last.timeSeconds);
    const d0 = { x: first.r.x - e0.x, y: first.r.y - e0.y, z: first.r.z - e0.z };
    const d1 = { x: last.r.x - e1.x, y: last.r.y - e1.y, z: last.r.z - e1.z };
    const drift = Math.hypot(d1.x - d0.x, d1.y - d0.y, d1.z - d0.z);
    // Within 1 km after a full revolution: the propagator is closed form, so any error here
    // would be a real one.
    expect(drift).toBeLessThan(1e3);
  });

  it('does not report an impact for a circular orbit above the surface', () => {
    const sc = craft();
    const traj = propagateTrajectory(sc, {
      horizonSeconds: 6000,
      mode: 'twoBody',
      epochJdTt: EPOCH_TT,
    });
    expect(traj.impacts).toBe(false);
  });

  it('reports an impact for an orbit that starts below the surface', () => {
    // A deliberately sub-surface "orbit": the check must fire.
    const sc = craft({ position: vec3(EARTH_R * 0.5, 0, 0) });
    const traj = propagateTrajectory(sc, {
      horizonSeconds: 100,
      mode: 'twoBody',
      epochJdTt: EPOCH_TT,
    });
    expect(traj.impacts).toBe(true);
  });

  it('rejects a non-positive horizon', () => {
    const sc = craft();
    for (const horizonSeconds of [0, -1, Number.NaN]) {
      expect(() =>
        propagateTrajectory(sc, { horizonSeconds, mode: 'twoBody', epochJdTt: EPOCH_TT }),
      ).toThrow();
    }
  });

  it('is deterministic for identical inputs', () => {
    const sc = craft();
    const opts = { horizonSeconds: 5000, mode: 'twoBody' as const, epochJdTt: EPOCH_TT };
    const a = propagateTrajectory(sc, opts);
    const b = propagateTrajectory(sc, opts);
    expect(a.points.length).toBe(b.points.length);
    for (let i = 0; i < a.points.length; i++) {
      expect(a.points[i]!.r).toEqual(b.points[i]!.r);
    }
  });
});

describe('burns inside a trajectory', () => {
  it('turns a circular orbit into the Hohmann transfer ellipse', () => {
    // The decisive test: a single prograde burn at the start, propagated to the far side,
    // must reproduce the Hohmann apogee and arrive at rest relative to the primary there.
    const r1 = EARTH_R + 400e3;
    const r2 = EARTH_R + 20_000e3;
    const hohmann = hohmannTransfer(r1, r2, EARTH_MU);
    const departureDeltaV = hohmann.legs[0]!.deltaV;

    const sc = craft({
      ...circularAroundEarth(400e3),
      maneuvers: [burn({ a: departureDeltaV, timeSeconds: 0 })],
    });

    const traj = propagateTrajectory(sc, {
      horizonSeconds: hohmann.duration,
      mode: 'twoBody',
      epochJdTt: EPOCH_TT,
      samples: 200,
    });

    const arrival = traj.points[traj.points.length - 1]!;
    const tArrive = hohmann.duration / SECONDS_PER_DAY;
    const arrivalRadius = radiusFromBody(arrival.r, 'earth', EPOCH_TT + tArrive);

    // Arrives at the target radius, within 1 km of 20,000 km altitude.
    expect(arrivalRadius).toBeCloseTo(r2, -3);

    // And the motion is purely tangential there: it is apogee, not a radial crossing.
    const earthV = bodyVelocity('earth', EPOCH_TT + tArrive);
    const relV = {
      x: arrival.v.x - earthV.x,
      y: arrival.v.y - earthV.y,
      z: arrival.v.z - earthV.z,
    };
    const earthP = bodyPosition('earth', EPOCH_TT + tArrive);
    const relR = {
      x: arrival.r.x - earthP.x,
      y: arrival.r.y - earthP.y,
      z: arrival.r.z - earthP.z,
    };
    const relRSpeed = Math.hypot(relR.x, relR.y, relR.z);
    const radialSpeed = (relR.x * relV.x + relR.y * relV.y + relR.z * relV.z) / relRSpeed;
    expect(Math.abs(radialSpeed)).toBeLessThan(20);

    // The tangential speed must match the Hohmann apogee speed from vis-viva.
    const aTransfer = (r1 + r2) / 2;
    const expectedApoSpeed = Math.sqrt(EARTH_MU * (2 / r2 - 1 / aTransfer));
    const tangentialSpeed = Math.sqrt(
      Math.max(0, Math.hypot(relV.x, relV.y, relV.z) ** 2 - radialSpeed ** 2),
    );
    expect(tangentialSpeed).toBeCloseTo(expectedApoSpeed, -1);
  });

  it('applies a prograde burn in the central-body frame, not the heliocentric one', () => {
    // Regression test for a real bug: applying a local burn to the heliocentric velocity
    // makes "prograde" mean "along Earth's orbit about the Sun", which is ~90 degrees off
    // for a LEO satellite. The symptom is a scatter of orbits instead of a transfer.
    const sc = craft({ maneuvers: [burn({ a: 100, timeSeconds: 0 })] });
    const traj = propagateTrajectory(sc, {
      horizonSeconds: 60,
      mode: 'twoBody',
      epochJdTt: EPOCH_TT,
    });
    const helio = heliocentricState(sc, EPOCH_TT);
    const earthV = bodyVelocity('earth', EPOCH_TT);
    const afterV = traj.points[0]!.v;
    const relV = { x: afterV.x - earthV.x, y: afterV.y - earthV.y, z: afterV.z - earthV.z };

    // The geocentric speed rises by exactly the burn. This is the assertion the bug failed.
    const relSpeedBefore = Math.hypot(sc.velocity.x, sc.velocity.y, sc.velocity.z);
    expect(Math.hypot(relV.x, relV.y, relV.z) - relSpeedBefore).toBeCloseTo(100, 6);

    // The heliocentric speed does NOT rise by 100 m/s: the burn vector is almost
    // perpendicular to the heliocentric velocity, so only its projection contributes,
    // plus a second-order term |dv|^2 / 2|v_helio| that must not be dropped to make the
    // numbers line up. The expected value is therefore computed exactly from the applied
    // delta-v rather than bounded, so the test states the geometry instead of tolerating it.
    const helioSpeed = Math.hypot(helio.v.x, helio.v.y, helio.v.z);
    const dv = {
      x: relV.x - sc.velocity.x,
      y: relV.y - sc.velocity.y,
      z: relV.z - sc.velocity.z,
    };
    const expectedHelioSpeed = Math.hypot(helio.v.x + dv.x, helio.v.y + dv.y, helio.v.z + dv.z);
    const helioSpeedAfter = Math.hypot(afterV.x, afterV.y, afterV.z);
    expect(helioSpeedAfter).toBeCloseTo(expectedHelioSpeed, 6);

    // The first-order projection is a poor predictor here, by the second-order term above.
    const radialProjection = (dv.x * helio.v.x + dv.y * helio.v.y + dv.z * helio.v.z) / helioSpeed;
    expect(Math.abs(helioSpeedAfter - helioSpeed - radialProjection)).toBeGreaterThan(0.01);

    // And the two frames genuinely disagree, which is what makes the distinction matter.
    expect(Math.abs(helioSpeedAfter - helioSpeed)).toBeLessThan(95);
  });

  it('applies an inertial burn in the heliocentric frame', () => {
    // The other side of the same coin: an inertial node is heliocentric by definition.
    const sc = craft({ maneuvers: [burn({ frame: 'inertial', a: 10, timeSeconds: 0 })] });
    const traj = propagateTrajectory(sc, {
      horizonSeconds: 60,
      mode: 'twoBody',
      epochJdTt: EPOCH_TT,
    });
    const helio = heliocentricState(sc, EPOCH_TT);
    expect(traj.points[0]!.v.x - helio.v.x).toBeCloseTo(10, 9);
  });

  it('records the Δv used and the post-burn duplicate point', () => {
    const sc = craft({ maneuvers: [burn({ a: 100, timeSeconds: 600 })] });
    const traj = propagateTrajectory(sc, {
      horizonSeconds: 1200,
      mode: 'twoBody',
      epochJdTt: EPOCH_TT,
    });
    expect(traj.usedDeltaV).toBeCloseTo(100, 9);

    // Exactly one post-burn point, at t = 600.
    const burns = traj.points.filter((p) => p.afterBurn);
    expect(burns.length).toBe(1);
    expect(burns[0]!.timeSeconds).toBeCloseTo(600, 6);
  });

  it('gives a discontinuous velocity at the burn and a continuous position', () => {
    const sc = craft({ maneuvers: [burn({ a: 100, timeSeconds: 600 })] });
    const traj = propagateTrajectory(sc, {
      horizonSeconds: 1200,
      mode: 'twoBody',
      epochJdTt: EPOCH_TT,
    });
    const burnIndex = traj.points.findIndex((p) => p.afterBurn);
    const before = traj.points[burnIndex - 1]!;
    const after = traj.points[burnIndex]!;
    expect(after.timeSeconds).toBeCloseTo(before.timeSeconds, 0);

    // Speed must be compared in the frame the burn is defined in. A prograde burn is
    // geocentric prograde, so geocentric speed rises by the delta-v; heliocentric speed
    // changes by only Δv·cos(angle between the two), which is a different number entirely.
    const relSpeed = (p: {
      r: { x: number; y: number; z: number };
      v: { x: number; y: number; z: number };
      timeSeconds: number;
    }) => {
      const jd = EPOCH_TT + p.timeSeconds / SECONDS_PER_DAY;
      const bodyV = bodyVelocity('earth', jd);
      return Math.hypot(p.v.x - bodyV.x, p.v.y - bodyV.y, p.v.z - bodyV.z);
    };
    expect(relSpeed(after) - relSpeed(before)).toBeCloseTo(100, 6);

    // Position is continuous: same instant, same point.
    expect(after.r).toEqual(before.r);
  });

  it('applies a burn exactly at the epoch before propagating', () => {
    const sc = craft({ maneuvers: [burn({ a: 50, timeSeconds: 0 })] });
    const traj = propagateTrajectory(sc, {
      horizonSeconds: 600,
      mode: 'twoBody',
      epochJdTt: EPOCH_TT,
    });
    expect(traj.usedDeltaV).toBeCloseTo(50, 9);
    expect(traj.points[0]!.afterBurn).toBe(true);
  });

  it('ignores burns outside the horizon', () => {
    const sc = craft({
      maneuvers: [burn({ id: 'late', a: 500, timeSeconds: 5000 })],
    });
    const traj = propagateTrajectory(sc, {
      horizonSeconds: 1000,
      mode: 'twoBody',
      epochJdTt: EPOCH_TT,
    });
    expect(traj.usedDeltaV).toBe(0);
  });

  it('applies several burns in time order', () => {
    const sc = craft({
      maneuvers: [
        burn({ id: 'second', a: 20, timeSeconds: 1000 }),
        burn({ id: 'first', a: 30, timeSeconds: 500 }),
      ],
    });
    const traj = propagateTrajectory(sc, {
      horizonSeconds: 1500,
      mode: 'twoBody',
      epochJdTt: EPOCH_TT,
    });
    expect(traj.usedDeltaV).toBeCloseTo(50, 9);
    const burnTimes = traj.points.filter((p) => p.afterBurn).map((p) => p.timeSeconds);
    expect(burnTimes[0]).toBeCloseTo(500, 6);
    expect(burnTimes[1]).toBeCloseTo(1000, 6);
  });
});

describe('N-body mode', () => {
  it('keeps a craft at 1 AU circling the Sun where no planet is close', () => {
    // Placed perpendicular to Earth, a quarter orbit away, so no planet's point mass is
    // nearby: this is the regime N-body mode is actually for.
    const earth = bodyPosition('earth', EPOCH_TT);
    const earthV = bodyVelocity('earth', EPOCH_TT);
    const rAu = Math.hypot(earth.x, earth.y, earth.z);
    // Rotate Earth's position and velocity 90 degrees about the ecliptic normal (z).
    const rotate = (p: { x: number; y: number; z: number }) => ({ x: -p.y, y: p.x, z: p.z });
    const sc: Spacecraft = {
      id: 'cruise',
      name: 'Heliocentric cruise',
      centralBody: 'sun',
      position: rotate(earth),
      velocity: rotate(earthV),
      deltaVBudget: 3000,
      maneuvers: [],
    };

    const traj = propagateTrajectory(sc, {
      horizonSeconds: 40 * SECONDS_PER_DAY,
      mode: 'nbody',
      epochJdTt: EPOCH_TT,
      samples: 40,
    });

    expect(traj.truncated).toBe(false);
    for (const p of traj.points) {
      const au = heliocentricDistanceAu(p.r);
      // A near-circular heliocentric orbit stays within a few percent of 1 AU over 40 days.
      expect(au).toBeGreaterThan(0.97);
      expect(au).toBeLessThan(1.03);
    }
    expect(Math.hypot(sc.position.x, sc.position.y, sc.position.z)).toBeCloseTo(rAu, -3);
  });

  it('sends a craft with excess speed away from 1 AU', () => {
    const earth = bodyPosition('earth', EPOCH_TT);
    const earthV = bodyVelocity('earth', EPOCH_TT);
    const rotate = (p: { x: number; y: number; z: number }) => ({ x: -p.y, y: p.x, z: p.z });
    const sc: Spacecraft = {
      id: 'outbound',
      name: 'Outbound',
      centralBody: 'sun',
      position: rotate(earth),
      velocity: { x: rotate(earthV).x * 1.2, y: rotate(earthV).y * 1.2, z: rotate(earthV).z * 1.2 },
      deltaVBudget: 3000,
      maneuvers: [],
    };

    const traj = propagateTrajectory(sc, {
      horizonSeconds: 60 * SECONDS_PER_DAY,
      mode: 'nbody',
      epochJdTt: EPOCH_TT,
      samples: 30,
    });

    const finalAu = heliocentricDistanceAu(traj.points[traj.points.length - 1]!.r);
    expect(finalAu).toBeGreaterThan(1.05);
  });

  it('propagates deterministically', () => {
    const earth = bodyPosition('earth', EPOCH_TT);
    const earthV = bodyVelocity('earth', EPOCH_TT);
    const rotate = (p: { x: number; y: number; z: number }) => ({ x: -p.y, y: p.x, z: p.z });
    const sc: Spacecraft = {
      id: 'det',
      name: 'Deterministic',
      centralBody: 'sun',
      position: rotate(earth),
      velocity: rotate(earthV),
      deltaVBudget: 0,
      maneuvers: [],
    };
    const opts = {
      horizonSeconds: 10 * SECONDS_PER_DAY,
      mode: 'nbody' as const,
      epochJdTt: EPOCH_TT,
      samples: 10,
    };
    const a = propagateTrajectory(sc, opts);
    const b = propagateTrajectory(sc, opts);
    for (let i = 0; i < a.points.length; i++) expect(a.points[i]!.r).toEqual(b.points[i]!.r);
  });
});

describe('delta-v budget', () => {
  it('reports the budget left after all nodes', () => {
    const sc = craft({
      deltaVBudget: 1000,
      maneuvers: [burn({ a: 300 }), burn({ id: 'b2', a: -150 })],
    });
    expect(remainingDeltaV(sc)).toBeCloseTo(1000 - 450, 9);
  });

  it('goes negative when the mission overdraws', () => {
    const sc = craft({ deltaVBudget: 100, maneuvers: [burn({ a: 400 })] });
    expect(remainingDeltaV(sc)).toBeLessThan(0);
  });

  it('agrees with totalDeltaV over the same nodes', () => {
    const sc = craft({ maneuvers: [burn({ a: 120 }), burn({ id: 'b2', b: 60 })] });
    expect(remainingDeltaV(sc)).toBeCloseTo(sc.deltaVBudget - totalDeltaV(sc.maneuvers), 9);
  });
});

describe('readout helpers', () => {
  it('converts a heliocentric position to AU', () => {
    expect(heliocentricDistanceAu(vec3(AU_M, 0, 0))).toBeCloseTo(1, 12);
    expect(heliocentricDistanceAu(vec3(0, 0, 0))).toBe(0);
  });
});
