import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PHASE_SAMPLES,
  asymptoteDirection,
  departureAtPhase,
  idealDepartureDeltaV,
  oberthHelps,
  planDeparture,
} from '../src/core/transfer/departure.js';
import type { DepartureBurn } from '../src/core/transfer/departure.js';
import { GM, RADIUS } from '../src/core/constants.js';
import {
  type Vec3,
  add,
  cross,
  dot,
  length,
  normalize,
  scale,
  sub,
  vec3,
} from '../src/core/math/vec3.js';

const MU_EARTH = GM.earth;
const R_EARTH = RADIUS.earth;

/** Rebuilds the parking frame the module uses, so tests can place a burn at a known phase. */
function parkingBasis(normal: Vec3, radial: Vec3): { e1: Vec3; e2: Vec3 } {
  const n = normalize(normal);
  const flattened = sub(normalize(radial), scale(n, dot(normalize(radial), n)));
  const e1 = normalize(flattened);
  return { e1, e2: cross(n, e1) };
}

/** Speed on a hyperbolic orbit from its excess speed: the whole of the Oberth relation. */
const burnSpeed = (mu: number, r: number, vInf: number): number =>
  Math.sqrt((2 * mu) / r + vInf * vInf);

/** Eccentricity and asymptote recovered from a state, by a route independent of the solver. */
function hyperbolaOf(postBurn: { r: Vec3; v: Vec3 }, mu: number) {
  const rMag = length(postBurn.r);
  const vMag = length(postBurn.v);
  const energy = (vMag * vMag) / 2 - mu / rMag;
  const a = -mu / (2 * energy);
  const eVec = scale(
    sub(scale(postBurn.r, vMag * vMag - mu / rMag), scale(postBurn.v, dot(postBurn.r, postBurn.v))),
    1 / mu,
  );
  const e = length(eVec);
  const nuInf = Math.acos(Math.max(-1, Math.min(1, -1 / e)));
  const cosNu = dot(eVec, postBurn.r) / (e * rMag);
  const h = cross(postBurn.r, postBurn.v);
  const hHat = normalize(h);
  const sign = dot(cross(eVec, postBurn.r), hHat) >= 0 ? 1 : -1;
  const nu = sign * Math.acos(Math.max(-1, Math.min(1, cosNu)));
  return { a, e, nuInf, nu, periapsis: a * (1 - e), vInf: Math.sqrt(-mu / a) };
}

describe('idealDepartureDeltaV', () => {
  it('is the Oberth relation, not the excess speed', () => {
    const r = R_EARTH + 300e3;
    const expected = burnSpeed(MU_EARTH, r, 3060) - Math.sqrt(MU_EARTH / r);
    expect(idealDepartureDeltaV(MU_EARTH, r, 3060)).toBeCloseTo(expected, 9);
  });

  it('beats the excess speed only above half the parking speed, which is the Oberth crossover', () => {
    // sqrt(vc^2 + v^2) - vc < v reduces to v > vc/2. Below that, most of the burn goes into
    // cancelling speed the craft already has, and leaving slowly from a fast orbit costs more
    // than the excess speed itself. Both regimes are reachable in the interplanetary range, so
    // a blanket "Oberth always helps" would be quietly wrong for the low end.
    for (const alt of [200e3, 300e3, 800e3, 5000e3]) {
      const r = R_EARTH + alt;
      const vc = Math.sqrt(MU_EARTH / r);
      expect(oberthHelps(MU_EARTH, r, vc / 2 + 1)).toBe(true);
      expect(oberthHelps(MU_EARTH, r, vc / 2 - 1)).toBe(false);
      // The crossover is exactly where the ideal burn costs exactly the excess speed.
      expect(idealDepartureDeltaV(MU_EARTH, r, vc / 2)).toBeCloseTo(vc / 2, 6);
      // And on each side of it, the sign of the saving flips.
      expect(idealDepartureDeltaV(MU_EARTH, r, 10000)).toBeLessThan(10000);
    }
  });

  it('falls with altitude: a higher parking orbit loses the Oberth benefit', () => {
    let previous = Infinity;
    for (const alt of [200e3, 300e3, 500e3, 1000e3, 5000e3, 35786e3]) {
      const value = idealDepartureDeltaV(MU_EARTH, R_EARTH + alt, 3060);
      expect(value).toBeLessThan(previous);
      previous = value;
    }
  });

  it('returns NaN for a non-physical input rather than a plausible number', () => {
    expect(idealDepartureDeltaV(0, R_EARTH, 3060)).toBeNaN();
    expect(idealDepartureDeltaV(MU_EARTH, 0, 3060)).toBeNaN();
    expect(idealDepartureDeltaV(MU_EARTH, R_EARTH, -1)).toBeNaN();
  });
});

describe('hyperbolaOf (test helper sanity)', () => {
  it('recovers the excess speed and eccentricity from a known state', () => {
    // Build a hyperbola by hand: periapsis 7000 km, e = 1.5, in the xy plane.
    const mu = MU_EARTH;
    const rp = 7e6;
    const e = 1.5;
    const a = rp / (1 - e);
    const r = vec3(rp, 0, 0);
    const vp = Math.sqrt(mu * (2 / rp - 1 / a));
    const got = hyperbolaOf({ r, v: vec3(0, vp, 0) }, mu);
    expect(got.e).toBeCloseTo(e, 10);
    expect(got.vInf).toBeCloseTo(Math.sqrt(-mu / a), 6);
    expect(got.nu).toBeCloseTo(0, 10);
  });
});

describe('asymptoteDirection', () => {
  it('returns null for an elliptic orbit', () => {
    const r = R_EARTH + 400e3;
    const v = Math.sqrt(MU_EARTH / r);
    expect(asymptoteDirection({ r: vec3(r, 0, 0), v: vec3(0, v, 0) }, MU_EARTH)).toBeNull();
  });

  it('returns null for a degenerate state rather than NaN vectors', () => {
    expect(asymptoteDirection({ r: vec3(0, 0, 0), v: vec3(1, 0, 0) }, MU_EARTH)).toBeNull();
    expect(asymptoteDirection({ r: vec3(1e7, 0, 0), v: vec3(0, 0, 0) }, MU_EARTH)).toBeNull();
  });

  it('agrees with the asymptote the solver aimed at, on a real departure', () => {
    const radius = R_EARTH + 300e3;
    const aim = normalize(vec3(0, 1, 0));
    const plan = planDeparture({
      mu: MU_EARTH,
      radius,
      vInf: 3060,
      asymptote: aim,
      parkingNormal: vec3(0, 0, 1),
      parkingRadial: vec3(1, 0, 0),
    });
    expect(plan).not.toBeNull();
    const got = asymptoteDirection(plan!.burn.postBurn, MU_EARTH);
    expect(got).not.toBeNull();
    expect(dot(got!, aim)).toBeCloseTo(1, 10);
  });
});

describe('departureAtPhase: the closed form against the physics it claims', () => {
  it('reaches exactly the requested excess speed, for every geometry', () => {
    const radius = R_EARTH + 300e3;
    for (const inc of [0, 0.1, 0.5, 1.0, 1.5]) {
      const normal = normalize(vec3(0, Math.sin(inc), Math.cos(inc)));
      for (const aim of [vec3(1, 0, 0), vec3(0, 1, 0), normalize(vec3(0.3, 0.9, 0.2))]) {
        for (const phase of [0.3, 1.7, 4.1]) {
          const radial = normalize(
            add(
              scale(vec3(1, 0, 0), Math.cos(phase)),
              scale(cross(normal, vec3(1, 0, 0)), Math.sin(phase)),
            ),
          );
          const burn = departureAtPhase(MU_EARTH, radius, 3060, radial, aim, normal);
          if (!burn) continue;
          const got = hyperbolaOf(burn.postBurn, MU_EARTH);
          expect(got.vInf).toBeCloseTo(3060, 4);
          expect(got.e).toBeCloseTo(burn.eccentricity, 8);
        }
      }
    }
  });

  it('lands the asymptote exactly on the requested direction', () => {
    const radius = R_EARTH + 300e3;
    // Phases chosen by scanning the documented feasibility: near the cheap end of the orbit
    // for the tilted cases, where the 90-degree-at-the-burn-point geometry is not available.
    const cases: { normal: Vec3; aim: Vec3; phase: number }[] = [
      { normal: vec3(0, 0, 1), aim: vec3(1, 0, 0), phase: 0.4 },
      { normal: vec3(0, 0, 1), aim: vec3(0, 1, 0), phase: 2.2 },
      { normal: normalize(vec3(0, 0.48, 0.87)), aim: normalize(vec3(0.1, 0.95, 0.3)), phase: 5.8 },
      {
        normal: normalize(vec3(0.2, -0.9, 0.4)),
        aim: normalize(vec3(-0.5, 0.2, 0.8)),
        phase: 5.85,
      },
    ];
    for (const c of cases) {
      const { e1, e2 } = parkingBasis(c.normal, vec3(1, 0, 0));
      const radial = add(scale(e1, Math.cos(c.phase)), scale(e2, Math.sin(c.phase)));
      const burn = departureAtPhase(MU_EARTH, radius, 3060, radial, c.aim, c.normal);
      expect(burn).not.toBeNull();
      const got = asymptoteDirection(burn!.postBurn, MU_EARTH)!;
      // Round-trip through the state, not through the solver's own bookkeeping.
      expect(dot(got, normalize(c.aim))).toBeCloseTo(1, 9);
    }
  });

  it('reaches periapsis only when the asymptote is nu_inf away, and that is the floor', () => {
    // A spacecraft burns at periapsis when the angle from the burn point to the outbound
    // asymptote equals the hyperbola's nu_inf (about 150 degrees for these speeds), NOT 90
    // degrees as a first guess suggests. This is worth pinning precisely, because the
    // intuitive "aim 90 degrees from where I am" choice is expensive rather than optimal.
    const radius = R_EARTH + 300e3;
    const warm = departureAtPhase(
      MU_EARTH,
      radius,
      3060,
      vec3(1, 0, 0),
      vec3(0, 1, 0),
      vec3(0, 0, 1),
    )!;
    const nuInf = Math.acos(-1 / warm.eccentricity);
    expect((nuInf * 180) / Math.PI).toBeGreaterThan(140);
    expect((nuInf * 180) / Math.PI).toBeLessThan(160);

    // Scan the equatorial plane for the cheapest burn, and confirm it is the periapsis one.
    const best = planDeparture({
      mu: MU_EARTH,
      radius,
      vInf: 3060,
      asymptote: vec3(0, 1, 0),
      parkingNormal: vec3(0, 0, 1),
      parkingRadial: vec3(1, 0, 0),
    })!;
    expect(best.burn.trueAnomalyRad).toBeLessThan(1e-6);
    expect(best.burn.normal).toBeCloseTo(0, 6);
    expect(best.burn.radial).toBeCloseTo(0, 4);
    expect(best.burn.deltaV).toBeCloseTo(idealDepartureDeltaV(MU_EARTH, radius, 3060), 4);
  });

  it('costs more than the floor when the aim is out of the parking plane', () => {
    // 12 degrees out of plane at a 300 km orbit: the transfer plane cannot coincide with the
    // parking plane, so some plane change is unavoidable.
    const radius = R_EARTH + 300e3;
    const plan = planDeparture({
      mu: MU_EARTH,
      radius,
      vInf: 3060,
      asymptote: normalize(vec3(0.05, 0.99, 0.12)),
      parkingNormal: vec3(0, 0, 1),
      parkingRadial: vec3(1, 0, 0),
    })!;
    expect(plan.burn.deltaV).toBeGreaterThan(plan.idealDeltaV + 100);
    // 4116.8 measured against a 3622.0 floor: 495 m/s of plane change for 6.9 degrees of
    // out-of-plane aim. Pinned so a regression in the parking frame shows up as a number.
    expect(plan.burn.deltaV).toBeCloseTo(4116.8, 0);
  });

  it('reports prograde/normal/radial that reconstruct the burn magnitude', () => {
    const radius = R_EARTH + 300e3;
    const normal = normalize(vec3(0, 0.48, 0.87));
    const burn = departureAtPhase(
      MU_EARTH,
      radius,
      3060,
      vec3(1, 0, 0),
      normalize(vec3(0.1, 0.95, 0.3)),
      normal,
    )!;
    expect(Math.hypot(burn.prograde, burn.normal, burn.radial)).toBeCloseTo(burn.deltaV, 9);
  });

  it('charges a plane change when the parking plane and the aim plane differ', () => {
    // Same excess speed and radius, only the parking inclination changes. For an aim fixed in
    // the ecliptic-ish plane, a rising inclination forces a growing plane change, so the cost
    // must rise monotonically.
    const radius = R_EARTH + 300e3;
    const aim = normalize(vec3(0.05, 0.99, 0.12));
    const costs: number[] = [];
    for (const incDeg of [0, 10, 20, 28.5, 40, 51.6]) {
      const inc = (incDeg * Math.PI) / 180;
      const normal = normalize(vec3(0, Math.sin(inc), Math.cos(inc)));
      let best = Infinity;
      for (let i = 0; i < 720; i++) {
        const phase = (2 * Math.PI * i) / 720;
        const { e1, e2 } = parkingBasis(normal, vec3(1, 0, 0));
        const radial = add(scale(e1, Math.cos(phase)), scale(e2, Math.sin(phase)));
        const burn = departureAtPhase(MU_EARTH, radius, 3060, radial, aim, normal);
        if (burn) best = Math.min(best, burn.deltaV);
      }
      costs.push(best);
    }
    for (let i = 1; i < costs.length; i++) {
      expect(costs[i]!).toBeGreaterThan(costs[i - 1]!);
    }
    // A fully coplanar aim has no plane change at all, so it must hit the floor.
    let coplanarBest = Infinity;
    for (let i = 0; i < 3600; i++) {
      const phase = (2 * Math.PI * i) / 3600;
      const burn = departureAtPhase(
        MU_EARTH,
        radius,
        3060,
        vec3(Math.cos(phase), Math.sin(phase), 0),
        normalize(vec3(0.4, 0.9, 0)),
        vec3(0, 0, 1),
      );
      if (burn) coplanarBest = Math.min(coplanarBest, burn.deltaV);
    }
    expect(coplanarBest).toBeCloseTo(idealDepartureDeltaV(MU_EARTH, radius, 3060), 0);
  });

  it('rejects a radial asymptote instead of dividing by zero', () => {
    const radius = R_EARTH + 300e3;
    expect(
      departureAtPhase(MU_EARTH, radius, 3060, vec3(1, 0, 0), vec3(1, 0, 0), vec3(0, 0, 1)),
    ).toBeNull();
    expect(
      departureAtPhase(MU_EARTH, radius, 3060, vec3(1, 0, 0), vec3(-1, 0, 0), vec3(0, 0, 1)),
    ).toBeNull();
  });

  it('rejects a non-physical input rather than returning a number', () => {
    const r = R_EARTH + 300e3;
    expect(departureAtPhase(0, r, 3060, vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1))).toBeNull();
    expect(
      departureAtPhase(MU_EARTH, 0, 3060, vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1)),
    ).toBeNull();
    expect(
      departureAtPhase(MU_EARTH, r, 0, vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1)),
    ).toBeNull();
    expect(
      departureAtPhase(MU_EARTH, r, 3060, vec3(0, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1)),
    ).toBeNull();
  });

  it('flags a periapsis inside the body, which is legal but worth saying', () => {
    const radius = R_EARTH + 300e3;
    const plan = planDeparture({
      mu: MU_EARTH,
      radius,
      vInf: 3060,
      asymptote: normalize(vec3(0.08, 0.99, 0.05)),
      parkingNormal: normalize(
        vec3(0, Math.sin((28.5 * Math.PI) / 180), Math.cos((28.5 * Math.PI) / 180)),
      ),
      parkingRadial: vec3(1, 0, 0),
      bodyRadius: R_EARTH,
    })!;
    // A high-eccentricity departure has its periapsis well below the burn radius.
    expect(plan.burn.periapsisRadius).toBeLessThan(radius);
    expect(typeof plan.burn.periapsisBelowSurface).toBe('boolean');
    if (plan.burn.periapsisBelowSurface) {
      expect(plan.burn.periapsisRadius).toBeLessThan(R_EARTH);
    }
  });
});

describe('planDeparture: the search over phase', () => {
  const radius = R_EARTH + 300e3;

  it('finds the Oberth floor on the geometry where it exists', () => {
    const plan = planDeparture({
      mu: MU_EARTH,
      radius,
      vInf: 3060,
      asymptote: vec3(0, 1, 0),
      parkingNormal: vec3(0, 0, 1),
      parkingRadial: vec3(1, 0, 0),
    })!;
    expect(plan.burn.deltaV).toBeCloseTo(plan.idealDeltaV, 4);
    expect(plan.excessOverIdeal).toBeLessThan(1e-3);
  });

  it('beats a naive single-bracket search, which is why every minimum is refined', () => {
    // A geometry measured to have two local minima. A ternary search run from only the
    // cheapest sample lands on a worse one, so this asserts the global answer.
    const aim = normalize(vec3(0.6, 0.6, 0.5));
    const normal = normalize(vec3(0.1, 0.8, 0.6));
    const plan = planDeparture({
      mu: MU_EARTH,
      radius,
      vInf: 4000,
      asymptote: aim,
      parkingNormal: normal,
      parkingRadial: normalize(cross(normal, vec3(1, 0.2, 0))),
    })!;
    // Brute force, five hundred times finer than the module's coarse scan.
    let brute = Infinity;
    for (let i = 0; i < 360 * 500; i++) {
      const phase = (2 * Math.PI * i) / (360 * 500);
      const { e1, e2 } = parkingBasis(normal, normalize(cross(normal, vec3(1, 0.2, 0))));
      const radial = add(scale(e1, Math.cos(phase)), scale(e2, Math.sin(phase)));
      const burn = departureAtPhase(MU_EARTH, radius, 4000, radial, aim, normal);
      if (burn) brute = Math.min(brute, burn.deltaV);
    }
    expect(plan.burn.deltaV).toBeLessThanOrEqual(brute + 1e-6);
    expect(plan.refinedMinima).toBeGreaterThan(0);
  });

  it('agrees with a dense scan across many random geometries', () => {
    // Deterministic pseudo-random, so a failure is reproducible.
    let seed = 20261118;
    const rnd = () => {
      seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const unit = () => {
      const z = 2 * rnd() - 1;
      const t = 2 * Math.PI * rnd();
      const r = Math.sqrt(Math.max(0, 1 - z * z));
      return vec3(r * Math.cos(t), r * Math.sin(t), z);
    };

    let worst = 0;
    let compared = 0;
    for (let trial = 0; trial < 12; trial++) {
      const normal = unit();
      const aim = unit();
      const radial = normalize(cross(normal, unit()));
      const plan = planDeparture({
        mu: MU_EARTH,
        radius,
        vInf: 3500,
        asymptote: aim,
        parkingNormal: normal,
        parkingRadial: radial,
      });
      if (!plan) continue;

      let brute = Infinity;
      const { e1, e2 } = parkingBasis(normal, radial);
      for (let i = 0; i < 720 * 60; i++) {
        const phase = (2 * Math.PI * i) / (720 * 60);
        const burn = departureAtPhase(
          MU_EARTH,
          radius,
          3500,
          add(scale(e1, Math.cos(phase)), scale(e2, Math.sin(phase))),
          aim,
          normal,
        );
        if (burn) brute = Math.min(brute, burn.deltaV);
      }
      if (!Number.isFinite(brute)) continue;
      compared++;
      worst = Math.max(worst, plan.burn.deltaV - brute);
    }
    expect(compared).toBeGreaterThan(8);
    expect(worst).toBeLessThan(0.05);
  });

  it('never returns less than the in-plane floor', () => {
    let seed = 7;
    const rnd = () => {
      seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let trial = 0; trial < 40; trial++) {
      const z = 2 * rnd() - 1;
      const t = 2 * Math.PI * rnd();
      const rr = Math.sqrt(Math.max(0, 1 - z * z));
      const normal = vec3(rr * Math.cos(t), rr * Math.sin(t), z);
      const aimZ = 2 * rnd() - 1;
      const aimT = 2 * Math.PI * rnd();
      const aimR = Math.sqrt(Math.max(0, 1 - aimZ * aimZ));
      const plan = planDeparture({
        mu: MU_EARTH,
        radius,
        vInf: 3060,
        asymptote: vec3(aimR * Math.cos(aimT), aimR * Math.sin(aimT), aimZ),
        parkingNormal: normal,
        parkingRadial: normalize(cross(normal, vec3(1, 0, 0))),
      });
      if (!plan) continue;
      expect(plan.burn.deltaV).toBeGreaterThanOrEqual(plan.idealDeltaV - 1e-6);
    }
  });

  it('places the burn within one parking period', () => {
    const normal = normalize(vec3(0.3, 0.9, 0.3));
    const plan = planDeparture({
      mu: MU_EARTH,
      radius,
      vInf: 3060,
      asymptote: normalize(vec3(0, 1, 0)),
      parkingNormal: normal,
      parkingRadial: normalize(cross(normal, vec3(1, 0, 0))),
    })!;
    expect(plan.timeToBurnSeconds).toBeGreaterThanOrEqual(0);
    expect(plan.timeToBurnSeconds).toBeLessThanOrEqual(plan.parkingPeriod + 1e-9);
    expect(plan.phaseRad).toBeGreaterThanOrEqual(0);
    expect(plan.phaseRad).toBeLessThan(2 * Math.PI + 1e-12);
  });

  it('is deterministic: the same request gives the same answer', () => {
    const request = {
      mu: MU_EARTH,
      radius,
      vInf: 3060,
      asymptote: normalize(vec3(0.2, 0.9, 0.1)),
      parkingNormal: normalize(vec3(0.1, 0.2, 0.9)),
      parkingRadial: vec3(1, 0, 0),
    };
    const a = planDeparture(request)!;
    const b = planDeparture(request)!;
    expect(a.burn.deltaV).toBe(b.burn.deltaV);
    expect(a.phaseRad).toBe(b.phaseRad);
    expect(a.refinedMinima).toBe(b.refinedMinima);
  });

  it('defaults to the documented sample count', () => {
    const plan = planDeparture({
      mu: MU_EARTH,
      radius,
      vInf: 3060,
      asymptote: vec3(0, 1, 0),
      parkingNormal: vec3(0, 0, 1),
      parkingRadial: vec3(1, 0, 0),
    })!;
    expect(plan.sampledPhases).toBe(DEFAULT_PHASE_SAMPLES);
  });

  it('rejects a sample count that cannot bracket a minimum', () => {
    expect(() =>
      planDeparture({
        mu: MU_EARTH,
        radius,
        vInf: 3060,
        asymptote: vec3(0, 1, 0),
        parkingNormal: vec3(0, 0, 1),
        parkingRadial: vec3(1, 0, 0),
        samples: 3,
      }),
    ).toThrow(/at least 8/);
    expect(() =>
      planDeparture({
        mu: MU_EARTH,
        radius,
        vInf: 3060,
        asymptote: vec3(0, 1, 0),
        parkingNormal: vec3(0, 0, 1),
        parkingRadial: vec3(1, 0, 0),
        samples: 12.5,
      }),
    ).toThrow(/integer/);
  });

  it('returns null rather than a plan for a degenerate basis', () => {
    expect(
      planDeparture({
        mu: MU_EARTH,
        radius,
        vInf: 3060,
        asymptote: vec3(0, 1, 0),
        parkingNormal: vec3(0, 0, 1),
        parkingRadial: vec3(0, 0, 1),
      }),
    ).toBeNull();
    expect(
      planDeparture({
        mu: MU_EARTH,
        radius,
        vInf: 3060,
        asymptote: vec3(0, 1, 0),
        parkingNormal: vec3(0, 0, 0),
        parkingRadial: vec3(1, 0, 0),
      }),
    ).toBeNull();
  });

  it('scales with v_inf as the Oberth relation says it must', () => {
    // A fixed geometry (equatorial park, prograde aim at the burn point) has a known answer,
    // so the whole relation can be checked at several excess speeds at once.
    const eq = (vInf: number) =>
      planDeparture({
        mu: MU_EARTH,
        radius,
        vInf,
        asymptote: vec3(0, 1, 0),
        parkingNormal: vec3(0, 0, 1),
        parkingRadial: vec3(1, 0, 0),
      })!;
    for (const vInf of [500, 1500, 3060, 8000]) {
      expect(eq(vInf).burn.deltaV).toBeCloseTo(idealDepartureDeltaV(MU_EARTH, radius, vInf), 4);
    }
  });

  it('works at a high-altitude parking orbit, where the Oberth benefit is small', () => {
    const geo = R_EARTH + 35786e3;
    const plan = planDeparture({
      mu: MU_EARTH,
      radius: geo,
      vInf: 2000,
      asymptote: vec3(0, 1, 0),
      parkingNormal: vec3(0, 0, 1),
      parkingRadial: vec3(1, 0, 0),
    })!;
    expect(plan.idealDeltaV).toBeCloseTo(idealDepartureDeltaV(MU_EARTH, geo, 2000), 6);
    expect(plan.burn.deltaV).toBeCloseTo(plan.idealDeltaV, 3);
    // A GEO parking orbit spends only a little over the excess speed itself.
    expect(plan.idealDeltaV / 2000).toBeGreaterThan(0.6);
  });
});

describe('DepartureBurn invariants', () => {
  it('always reports an eccentricity above 1', () => {
    const burns: DepartureBurn[] = [];
    const radius = R_EARTH + 300e3;
    for (const vInf of [100, 1000, 5000, 20000]) {
      for (const phase of [0.5, 2.0, 3.9]) {
        const radial = vec3(Math.cos(phase), Math.sin(phase), 0);
        const burn = departureAtPhase(MU_EARTH, radius, vInf, radial, vec3(0, 1, 0), vec3(0, 0, 1));
        if (burn) burns.push(burn);
      }
    }
    expect(burns.length).toBeGreaterThan(3);
    for (const b of burns) expect(b.eccentricity).toBeGreaterThan(1);
  });

  it('keeps the post-burn speed equal to sqrt(2mu/r + vInf^2)', () => {
    const radius = R_EARTH + 300e3;
    for (const vInf of [500, 3060, 12000]) {
      const burn = departureAtPhase(
        MU_EARTH,
        radius,
        vInf,
        vec3(1, 0, 0),
        vec3(0, 1, 0),
        vec3(0, 0, 1),
      )!;
      expect(length(burn.postBurn.v)).toBeCloseTo(burnSpeed(MU_EARTH, radius, vInf), 6);
    }
  });

  it('keeps the burn point on the parking orbit', () => {
    const radius = R_EARTH + 300e3;
    const burn = departureAtPhase(
      MU_EARTH,
      radius,
      3060,
      vec3(1, 0, 0),
      vec3(0, 1, 0),
      vec3(0, 0, 1),
    )!;
    expect(length(burn.postBurn.r)).toBeCloseTo(radius, 3);
  });
});
