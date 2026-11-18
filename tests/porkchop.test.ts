import { describe, expect, it } from 'vitest';
import {
  cellAt,
  cellIndex,
  computePorkchop,
  valueRange,
  type PorkchopOptions,
} from '../src/core/transfer/porkchop.js';
import { jdFromIsoUtc, jdTtFromJdUtc } from '../src/core/time/time.js';
import { BODIES } from '../src/core/ephemeris/solarSystem.js';
import { bodyPosition } from '../src/core/ephemeris/ephemeris.js';
import { solveLambert } from '../src/core/transfer/lambert.js';
import { length, sub, type Vec3 } from '../src/core/math/vec3.js';
import { GM, SECONDS_PER_DAY } from '../src/core/constants.js';

/** 2026-01-01T00:00:00Z as a TT Julian date. */
const START = jdTtFromJdUtc(jdFromIsoUtc('2026-01-01T00:00:00Z'));

/**
 * Central-difference velocity of a body, metres per second.
 *
 * Deliberately a re-derivation rather than a call into the grid's own private helper: this
 * exists so a test can compute the expected v-infinity independently. Same 600 s step, because
 * it is the derivative of the same position function.
 */
function velocityAround(id: 'earth' | 'mars', jdTt: number): Vec3 {
  const h = 600 / SECONDS_PER_DAY;
  const a = bodyPosition(id, jdTt - h);
  const b = bodyPosition(id, jdTt + h);
  const k = 1 / 1200;
  return { x: (b.x - a.x) * k, y: (b.y - a.y) * k, z: (b.z - a.z) * k };
}

function options(patch: Partial<PorkchopOptions> = {}): PorkchopOptions {
  return {
    departureBody: 'earth',
    arrivalBody: 'mars',
    departureStartJdTt: START,
    departureEndJdTt: START + 780,
    minTimeOfFlightDays: 150,
    maxTimeOfFlightDays: 420,
    columns: 40,
    rows: 40,
    ...patch,
  };
}

describe('porkchop grid construction', () => {
  it('builds the requested number of cells', () => {
    const grid = computePorkchop(options({ columns: 12, rows: 9 }));
    expect(grid.columns).toBe(12);
    expect(grid.rows).toBe(9);
    expect(grid.totalDeltaV.length).toBe(108);
    expect(grid.departureJdTt.length).toBe(12);
    expect(grid.timeOfFlightDays.length).toBe(9);
  });

  it('spans the departure window inclusively', () => {
    const grid = computePorkchop(options({ columns: 5 }));
    expect(grid.departureJdTt[0]).toBeCloseTo(START, 6);
    expect(grid.departureJdTt[4]).toBeCloseTo(START + 780, 6);
    // Even spacing: the middle column is the middle date, not an off-by-one neighbour.
    expect(grid.departureJdTt[2]).toBeCloseTo(START + 390, 6);
  });

  it('spans the time-of-flight range inclusively', () => {
    const grid = computePorkchop(options({ rows: 5 }));
    expect(grid.timeOfFlightDays[0]).toBeCloseTo(150, 9);
    expect(grid.timeOfFlightDays[4]).toBeCloseTo(420, 9);
    expect(grid.timeOfFlightDays[2]).toBeCloseTo(285, 9);
  });

  it('keeps every departure time ascending and every time of flight ascending', () => {
    const grid = computePorkchop(options({ columns: 17, rows: 11 }));
    for (let i = 1; i < grid.columns; i++) {
      expect(grid.departureJdTt[i]!).toBeGreaterThan(grid.departureJdTt[i - 1]!);
    }
    for (let i = 1; i < grid.rows; i++) {
      expect(grid.timeOfFlightDays[i]!).toBeGreaterThan(grid.timeOfFlightDays[i - 1]!);
    }
  });

  it('maps a row-major index to its column and row', () => {
    const grid = computePorkchop(options({ columns: 7, rows: 6 }));
    expect(cellIndex(grid, 0, 0)).toBe(0);
    expect(cellIndex(grid, 6, 5)).toBe(41);
    const cell = cellAt(grid, cellIndex(grid, 3, 2));
    expect(cell.column).toBe(3);
    expect(cell.row).toBe(2);
  });

  it('reports arrival as departure plus time of flight', () => {
    const grid = computePorkchop(options({ columns: 5, rows: 5 }));
    const cell = cellAt(grid, cellIndex(grid, 2, 3));
    expect(cell.arrivalJdTt).toBeCloseTo(cell.departureJdTt + cell.timeOfFlightDays, 9);
  });
});

describe('porkchop cell values', () => {
  it('converges every cell for an Earth-Mars window', () => {
    // Lambert is single-revolution and the whole grid is well inside the reachable set, so
    // every cell must solve. A hole here means the solver, not the geometry.
    const grid = computePorkchop(options({ columns: 20, rows: 20 }));
    expect(grid.convergedCells).toBe(400);
  });

  it('reproduces the Lambert solution it was built from', () => {
    // Recompute one cell independently: the grid must not have its own physics.
    const grid = computePorkchop(options({ columns: 9, rows: 9 }));
    const cell = cellAt(grid, cellIndex(grid, 4, 5));

    const r1 = bodyPosition('earth', cell.departureJdTt);
    const r2 = bodyPosition('mars', cell.arrivalJdTt);
    const solution = solveLambert(r1, r2, cell.timeOfFlightDays * SECONDS_PER_DAY, GM.sun);
    expect(solution.converged).toBe(true);

    // The departure excess is the Lambert departure speed minus Earth's, and likewise for
    // Mars at arrival. Recomputing both from the analytic states checks that the grid used
    // the right pair of bodies at the right two times, which the grid's own arithmetic
    // cannot catch.
    const vEarth = velocityAround('earth', cell.departureJdTt);
    const vMars = velocityAround('mars', cell.arrivalJdTt);
    expect(cell.vInfDeparture).toBeCloseTo(length(sub(solution.v1, vEarth)), 3);
    expect(cell.vInfArrival).toBeCloseTo(length(sub(solution.v2, vMars)), 3);
    expect(cell.totalDeltaV).toBeCloseTo(cell.vInfDeparture + cell.vInfArrival, 9);
  });

  it('reports C3 as the square of the departure excess speed', () => {
    const grid = computePorkchop(options({ columns: 6, rows: 6 }));
    for (let i = 0; i < grid.totalDeltaV.length; i++) {
      expect(grid.c3[i]!).toBeCloseTo(grid.vInfDeparture[i]! ** 2, 3);
    }
  });

  it('finds an Earth-Mars window costing about 5.6 km/s', () => {
    // Textbook Earth-Mars: a coplanar-circular Hohmann from 1.0 to 1.524 AU costs
    // 5.59 km/s of heliocentric delta-v. The real bodies are eccentric and inclined, so a
    // Lambert minimum can only be higher; it lands at 5.61 km/s. Asserting a range rather
    // than a number keeps this a physics test instead of a snapshot.
    const grid = computePorkchop(options({ columns: 60, rows: 60 }));
    const best = grid.best!;
    expect(best.totalDeltaV / 1000).toBeGreaterThan(5.4);
    expect(best.totalDeltaV / 1000).toBeLessThan(5.9);
    // And the time of flight must be near the Hohmann half-period (259 d), not a fast arc.
    expect(best.timeOfFlightDays).toBeGreaterThan(250);
    expect(best.timeOfFlightDays).toBeLessThan(360);
  });

  it('departs within Aug-Nov 2026 for that window', () => {
    const grid = computePorkchop(options({ columns: 60, rows: 60 }));
    // The 2026 Earth-Mars synodic window. Measured: the minimum sits in late October.
    const departure = new Date((grid.best!.departureJdTt - 2440587.5) * 86400000);
    expect(departure.getUTCFullYear()).toBe(2026);
    expect(departure.getUTCMonth()).toBeGreaterThanOrEqual(7); // August
    expect(departure.getUTCMonth()).toBeLessThanOrEqual(10); // November
  });

  it('reports a transfer angle and a plane tilt for every converged cell', () => {
    const grid = computePorkchop(options({ columns: 8, rows: 8 }));
    for (let i = 0; i < grid.totalDeltaV.length; i++) {
      expect(grid.transferAngleDeg[i]!).toBeGreaterThan(0);
      expect(grid.transferAngleDeg[i]!).toBeLessThan(180);
      expect(grid.planeTiltDeg[i]!).toBeGreaterThanOrEqual(0);
      expect(grid.planeTiltDeg[i]!).toBeLessThanOrEqual(90);
    }
  });

  it('reports a near-zero tilt for the cheapest Earth-Mars cell', () => {
    // Earth and Mars are nearly coplanar, so the good window is a coplanar transfer. A tilt
    // of tens of degrees would mean the solver picked an out-of-ecliptic arc, which is a
    // physically different (and much more expensive) answer.
    const grid = computePorkchop(options({ columns: 40, rows: 40 }));
    expect(grid.best!.planeTiltDeg).toBeLessThan(5);
  });
});

describe('the plane tilt that makes a transfer expensive', () => {
  /**
   * A transfer plane must contain the Sun and both endpoints. When the two endpoints are
   * nearly opposite, that plane is nearly undetermined — a tiny change in either position
   * rotates it by tens of degrees — so the cheap coplanar arc may not exist at that geometry
   * and the solver has to use a steeply inclined one. An inclined plane must be reached from
   * bodies that are themselves in the ecliptic, so the cost goes up with the tilt.
   *
   * This is asserted as a *relationship* (tilt predicts cost) rather than as "near 180
   * degrees is always expensive", because the latter is false: cheap cells do exist close to
   * 180 when the geometry happens to give a nearly coplanar plane. Measured on a 200x80
   * Earth-Venus grid, the cheapest cell with tilt under 10 degrees beats the cheapest cell
   * with tilt over 10 degrees in every transfer-angle band.
   */
  it('costs more at high plane tilt in every transfer-angle band', () => {
    const grid = computePorkchop(
      options({
        arrivalBody: 'venus',
        minTimeOfFlightDays: 100,
        maxTimeOfFlightDays: 260,
        columns: 200,
        rows: 80,
      }),
    );

    const bands: readonly (readonly [number, number])[] = [
      [160, 170],
      [170, 175],
      [175, 179],
    ];
    for (const [lo, hi] of bands) {
      const coplanar: number[] = [];
      const inclined: number[] = [];
      for (let i = 0; i < grid.totalDeltaV.length; i++) {
        const angle = grid.transferAngleDeg[i]!;
        const cost = grid.totalDeltaV[i]!;
        if (!Number.isFinite(cost) || angle < lo || angle >= hi) continue;
        (grid.planeTiltDeg[i]! < 10 ? coplanar : inclined).push(cost);
      }
      // Both populations must be populated for the comparison to mean anything.
      expect(coplanar.length).toBeGreaterThan(0);
      expect(inclined.length).toBeGreaterThan(0);
      // Measured: 7.0 vs 11.0 km/s, 7.4 vs 11.2, 7.7 vs 12.5. 1.3x is a conservative floor.
      expect(Math.min(...coplanar)).toBeLessThan(Math.min(...inclined) / 1.3);
    }
  });

  it('analyses an impossible request instead of inventing a transfer', () => {
    // A tenth of a day to Mars is beyond the single-revolution model: the solver's speed
    // ceiling rejects the rectilinear-plunge answer, so some cells have no solution and the
    // grid must report holes rather than a plausible cost.
    const grid = computePorkchop(
      options({ minTimeOfFlightDays: 0.02, maxTimeOfFlightDays: 0.03, columns: 4, rows: 4 }),
    );
    expect(grid.convergedCells).toBe(0);
    expect(grid.best).toBeNull();
  });

  it('never chooses a steeply inclined cell as the best one', () => {
    // The minimum must be a well-conditioned, nearly coplanar transfer, so a porkchop read
    // off this grid cannot recommend a wildly inclined window.
    const grid = computePorkchop(
      options({
        arrivalBody: 'venus',
        minTimeOfFlightDays: 100,
        maxTimeOfFlightDays: 260,
        columns: 120,
        rows: 60,
      }),
    );
    expect(grid.best!.planeTiltDeg).toBeLessThan(10);
  });
});

describe('porkchop summary', () => {
  it('finds the single lowest-cost cell', () => {
    const grid = computePorkchop(options({ columns: 25, rows: 25 }));
    const best = grid.best!;
    expect(best.totalDeltaV).toBe(
      Math.min(...Array.from(grid.totalDeltaV).filter((v) => Number.isFinite(v))),
    );
  });

  it('reports which cell the best one is', () => {
    const grid = computePorkchop(options({ columns: 25, rows: 25 }));
    const best = grid.best!;
    const byIndex = cellAt(grid, cellIndex(grid, best.column, best.row));
    expect(byIndex.totalDeltaV).toBe(best.totalDeltaV);
    expect(byIndex.departureJdTt).toBe(best.departureJdTt);
  });

  it('returns a null best when nothing converges', () => {
    // Twenty minutes to Mars is beyond the single-revolution model: the solver's speed
    // ceiling rejects the rectilinear-plunge answer that would otherwise be computed, so
    // every cell is a hole and there is no best cell to report.
    const grid = computePorkchop(
      options({ minTimeOfFlightDays: 0.01, maxTimeOfFlightDays: 0.014, columns: 4, rows: 4 }),
    );
    expect(grid.convergedCells).toBe(0);
    expect(grid.best).toBeNull();
    for (const v of grid.totalDeltaV) expect(Number.isNaN(v)).toBe(true);
  });

  it('marks unconverged cells NaN rather than zero', () => {
    const grid = computePorkchop(
      options({ minTimeOfFlightDays: 0.01, maxTimeOfFlightDays: 0.014, columns: 4, rows: 4 }),
    );
    // Zero would be indistinguishable from a free transfer.
    expect(Array.from(grid.totalDeltaV).every((v) => Number.isNaN(v))).toBe(true);
  });
});

describe('porkchop input validation', () => {
  it('rejects a grid narrower than two columns', () => {
    expect(() => computePorkchop(options({ columns: 1 }))).toThrow(/columns/);
  });

  it('rejects a grid shorter than two rows', () => {
    expect(() => computePorkchop(options({ rows: 1 }))).toThrow(/rows/);
  });

  it('rejects a non-integer column count', () => {
    expect(() => computePorkchop(options({ columns: 4.5 }))).toThrow(/integer/);
  });

  it('rejects a zero or inverted departure window', () => {
    expect(() => computePorkchop(options({ departureEndJdTt: START }))).toThrow(/positive width/);
    expect(() => computePorkchop(options({ departureEndJdTt: START - 10 }))).toThrow(
      /positive width/,
    );
  });

  it('rejects an inverted time-of-flight range', () => {
    expect(() =>
      computePorkchop(options({ minTimeOfFlightDays: 400, maxTimeOfFlightDays: 200 })),
    ).toThrow(/time-of-flight/);
  });

  it('rejects a non-positive time of flight', () => {
    expect(() => computePorkchop(options({ minTimeOfFlightDays: 0 }))).toThrow(/time-of-flight/);
  });

  it('rejects the same body departing and arriving', () => {
    expect(() => computePorkchop(options({ arrivalBody: 'earth' }))).toThrow(/must differ/);
  });

  it('rejects a non-positive mu', () => {
    expect(() => computePorkchop(options({ mu: 0 }))).toThrow(/mu/);
  });

  it('defaults mu to the Sun', () => {
    const grid = computePorkchop(options({ columns: 5, rows: 5 }));
    const cell = cellAt(grid, 0);
    const r1 = bodyPosition('earth', cell.departureJdTt);
    const r2 = bodyPosition('mars', cell.arrivalJdTt);
    const solution = solveLambert(r1, r2, cell.timeOfFlightDays * SECONDS_PER_DAY, BODIES.sun.mu);
    expect(solution.converged).toBe(true);
  });
});

describe('value range for colour scaling', () => {
  it('ignores NaN cells', () => {
    const values = Float64Array.from([Number.NaN, 1, 2, 3, Number.NaN]);
    const range = valueRange(values, 0, 1);
    expect(range).toEqual({ min: 1, max: 3 });
  });

  it('trims outliers at the requested quantiles', () => {
    const values = Float64Array.from([1, 2, 3, 4, 1000]);
    const range = valueRange(values, 0, 0.5);
    expect(range.min).toBe(1);
    expect(range.max).toBe(3);
  });

  it('returns a usable span for an all-NaN grid', () => {
    const range = valueRange(Float64Array.from([Number.NaN, Number.NaN]));
    expect(range.max).toBeGreaterThan(range.min);
  });

  it('returns a usable span for a constant grid', () => {
    const range = valueRange(Float64Array.from([5, 5, 5]));
    expect(range.max).toBeGreaterThan(range.min);
  });

  it('spans the real ranges a grid produces', () => {
    const grid = computePorkchop(options({ columns: 20, rows: 20 }));
    const range = valueRange(grid.totalDeltaV);
    expect(range.min).toBeGreaterThan(0);
    expect(range.max).toBeGreaterThan(range.min);
  });
});
