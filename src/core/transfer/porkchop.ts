/**
 * Porkchop plots: total delta-v over a grid of departure dates and times of flight.
 *
 * A porkchop plot answers one question — *when should this transfer leave?* — by solving
 * Lambert's problem once per (departure, time-of-flight) pair and reporting the cost. It is
 * the standard first cut for an interplanetary mission because it needs no optimisation
 * machinery: the expensive part is a table, and the answer is a minimum over that table.
 *
 * What is computed per cell:
 *
 *   r1 = heliocentric position of the departure body at t_dep
 *   r2 = heliocentric position of the arrival body at t_dep + TOF
 *   solve Lambert(r1, r2, TOF, mu_sun) -> v1, v2
 *   v_inf_dep = |v1 - v_body(dep, t_dep)|
 *   v_inf_arr = |v2 - v_body(arr, t_arr)|
 *   cost      = v_inf_dep + v_inf_arr
 *
 * The cost is the **sum of the two hyperbolic excess speeds**, which is the standard
 * "patch" comparison. It is NOT the delta-v from a parking orbit: the real figure needs the
 * Oberth effect (a departure from LEO costs less than v_inf because the burn happens deep in
 * the well), and the difference between two candidates is not preserved by that
 * transformation. So the plot ranks windows correctly and reports an *indicative* budget.
 * PHYSICS.md §11 states the gap and the size of the term.
 *
 * Axes are departure date against time of flight rather than departure against arrival,
 * because every (date, duration) pair is a valid transfer while half of a rectangular
 * date/date grid is "arrive before you left". Time of flight also reads as what it is: a
 * shape choice, not a calendar fact.
 *
 * Pure: no clock, no DOM, no randomness. The caller supplies the epoch window.
 */

import { type Vec3, cross, length, sub } from '../math/vec3.js';
import { bodyPosition } from '../ephemeris/ephemeris.js';
import { BODIES, type BodyId } from '../ephemeris/solarSystem.js';
import { SECONDS_PER_DAY } from '../constants.js';
import { solveLambert } from './lambert.js';

export interface PorkchopOptions {
  readonly departureBody: BodyId;
  readonly arrivalBody: BodyId;
  /** TT Julian date of the first departure column. */
  readonly departureStartJdTt: number;
  /** TT Julian date of the last departure column. */
  readonly departureEndJdTt: number;
  /** Shortest time of flight considered, days. First row. */
  readonly minTimeOfFlightDays: number;
  /** Longest time of flight considered, days. Last row. */
  readonly maxTimeOfFlightDays: number;
  /** Departure columns. At least 2. */
  readonly columns: number;
  /** Time-of-flight rows. At least 2. */
  readonly rows: number;
  /** Central body's gravitational parameter, m^3/s^2. Defaults to the Sun. */
  readonly mu?: number;
}

/** One cell of the grid, with everything needed to describe it in words. */
export interface PorkchopCell {
  readonly column: number;
  readonly row: number;
  /** TT JD of departure. */
  readonly departureJdTt: number;
  /** TT JD of arrival. */
  readonly arrivalJdTt: number;
  readonly timeOfFlightDays: number;
  /** Departure hyperbolic excess speed, m/s. */
  readonly vInfDeparture: number;
  /** Arrival hyperbolic excess speed, m/s. */
  readonly vInfArrival: number;
  /** Characteristic energy of the departure, m^2/s^2 (conventionally km^2/s^2). */
  readonly c3: number;
  /** `vInfDeparture + vInfArrival`, m/s. */
  readonly totalDeltaV: number;
  /** Angle swept about the Sun over the transfer, degrees. */
  readonly transferAngleDeg: number;
  /**
   * Tilt of the transfer plane away from the ecliptic, degrees.
   *
   * Computed as the angle between the plane normal `r1 × r2` and the ecliptic pole. It is
   * reported because it is the *explanation* for a neighbouring cell costing ten times more:
   * see the module note on near-180° transfers.
   */
  readonly planeTiltDeg: number;
}

export interface Porkchop {
  readonly departureBody: BodyId;
  readonly arrivalBody: BodyId;
  readonly departureJdTt: Float64Array;
  readonly timeOfFlightDays: Float64Array;
  /**
   * Cell values, row-major: `index = row * columns + column`. `NaN` marks a cell with no
   * single-revolution solution, which is drawn as a hole rather than as a zero.
   */
  readonly totalDeltaV: Float64Array;
  readonly vInfDeparture: Float64Array;
  readonly vInfArrival: Float64Array;
  readonly c3: Float64Array;
  /** Transfer angle swept, degrees, per cell. */
  readonly transferAngleDeg: Float64Array;
  /** Transfer-plane tilt from the ecliptic, degrees, per cell. */
  readonly planeTiltDeg: Float64Array;
  readonly columns: number;
  readonly rows: number;
  /** How many cells produced a solution. */
  readonly convergedCells: number;
  /** Lowest `totalDeltaV` cell, or null when nothing converged. */
  readonly best: PorkchopCell | null;
}

/** Row-major index for a grid cell. */
export function cellIndex(grid: { columns: number }, column: number, row: number): number {
  return row * grid.columns + column;
}

/** The cell at a row-major index, with NaN values reported as `null` fields intact. */
export function cellAt(grid: Porkchop, index: number): PorkchopCell {
  const row = Math.floor(index / grid.columns);
  const column = index - row * grid.columns;
  const tof = grid.timeOfFlightDays[row]!;
  const departure = grid.departureJdTt[column]!;
  return {
    column,
    row,
    departureJdTt: departure,
    arrivalJdTt: departure + tof,
    timeOfFlightDays: tof,
    vInfDeparture: grid.vInfDeparture[index]!,
    vInfArrival: grid.vInfArrival[index]!,
    c3: grid.c3[index]!,
    totalDeltaV: grid.totalDeltaV[index]!,
    transferAngleDeg: grid.transferAngleDeg[index]!,
    planeTiltDeg: grid.planeTiltDeg[index]!,
  };
}

/**
 * Computes the grid.
 *
 * Cost is `columns * rows` Lambert solves. Body positions are computed once per column and
 * once per row rather than once per cell, which is the difference between 2(N+M) ephemeris
 * evaluations and NM — worth doing because a 60x60 grid is 3,600 cells.
 */
export function computePorkchop(options: PorkchopOptions): Porkchop {
  const {
    departureBody,
    arrivalBody,
    departureStartJdTt,
    departureEndJdTt,
    minTimeOfFlightDays,
    maxTimeOfFlightDays,
    columns,
    rows,
  } = options;

  if (!(columns >= 2) || !Number.isInteger(columns)) {
    throw new Error('computePorkchop: columns must be an integer of at least 2');
  }
  if (!(rows >= 2) || !Number.isInteger(rows)) {
    throw new Error('computePorkchop: rows must be an integer of at least 2');
  }
  if (departureBody === arrivalBody) {
    throw new Error('computePorkchop: departure and arrival bodies must differ');
  }
  if (!Number.isFinite(departureStartJdTt) || !Number.isFinite(departureEndJdTt)) {
    throw new Error('computePorkchop: departure window must be finite');
  }
  if (!(departureEndJdTt > departureStartJdTt)) {
    throw new Error('computePorkchop: departure window must have positive width');
  }
  if (!(minTimeOfFlightDays > 0) || !(maxTimeOfFlightDays > minTimeOfFlightDays)) {
    throw new Error('computePorkchop: time-of-flight range must be positive and ordered');
  }

  const mu = options.mu ?? BODIES.sun.mu;
  if (!(mu > 0)) throw new Error('computePorkchop: mu must be positive');

  const departureJdTt = new Float64Array(columns);
  for (let c = 0; c < columns; c++) {
    const f = columns === 1 ? 0 : c / (columns - 1);
    departureJdTt[c] = departureStartJdTt + f * (departureEndJdTt - departureStartJdTt);
  }

  const timeOfFlightDays = new Float64Array(rows);
  for (let r = 0; r < rows; r++) {
    const f = rows === 1 ? 0 : r / (rows - 1);
    timeOfFlightDays[r] = minTimeOfFlightDays + f * (maxTimeOfFlightDays - minTimeOfFlightDays);
  }

  // Departure positions depend only on the column, and their velocities likewise.
  const departureState: { r: Vec3; v: Vec3 }[] = [];
  for (let c = 0; c < columns; c++) {
    const jd = departureJdTt[c]!;
    departureState.push({ r: bodyPosition(departureBody, jd), v: bodyVelocity(departureBody, jd) });
  }

  // Arrival state depends on the cell, not the row (arrival = departure + TOF), so it cannot
  // be hoisted. Cache it per (column, row) while filling the grid row by row.
  const size = columns * rows;
  const totalDeltaV = new Float64Array(size).fill(Number.NaN);
  const vInfDeparture = new Float64Array(size).fill(Number.NaN);
  const vInfArrival = new Float64Array(size).fill(Number.NaN);
  const c3 = new Float64Array(size).fill(Number.NaN);
  const transferAngleDeg = new Float64Array(size).fill(Number.NaN);
  const planeTiltDeg = new Float64Array(size).fill(Number.NaN);

  let convergedCells = 0;
  let bestIndex = -1;
  let bestValue = Number.POSITIVE_INFINITY;

  for (let r = 0; r < rows; r++) {
    const tofDays = timeOfFlightDays[r]!;
    const tofSeconds = tofDays * SECONDS_PER_DAY;

    for (let c = 0; c < columns; c++) {
      const index = r * columns + c;
      const departure = departureState[c]!;
      const jdArrival = departureJdTt[c]! + tofDays;
      const arrivalPosition = bodyPosition(arrivalBody, jdArrival);

      const solution = solveLambert(departure.r, arrivalPosition, tofSeconds, mu);
      if (!solution.converged) continue;

      const arrivalVelocity = bodyVelocity(arrivalBody, jdArrival);
      const dVDep = length(sub(solution.v1, departure.v));
      const dVArr = length(sub(solution.v2, arrivalVelocity));
      const total = dVDep + dVArr;

      totalDeltaV[index] = total;
      vInfDeparture[index] = dVDep;
      vInfArrival[index] = dVArr;
      c3[index] = dVDep * dVDep;

      // Geometry of the arc, so a readout can explain its own cost. The transfer angle is
      // the swept angle about the Sun; the tilt is how far the transfer plane is rotated out
      // of the ecliptic, which is what makes a near-180-degree transfer expensive.
      const r1Len = length(departure.r);
      const r2Len = length(arrivalPosition);
      const cosSweep = clamp(
        (departure.r.x * arrivalPosition.x +
          departure.r.y * arrivalPosition.y +
          departure.r.z * arrivalPosition.z) /
          (r1Len * r2Len),
        -1,
        1,
      );
      transferAngleDeg[index] = (Math.acos(cosSweep) * 180) / Math.PI;
      const h = cross(departure.r, arrivalPosition);
      const hLen = length(h);
      // |h_z| / |h| is |cos(tilt)|; tilt is measured from the ecliptic plane, so 0 is
      // coplanar and 90 is a polar transfer. A degenerate r1 x r2 = 0 is left as NaN.
      planeTiltDeg[index] =
        hLen > 0 ? (Math.acos(Math.min(1, Math.abs(h.z) / hLen)) * 180) / Math.PI : Number.NaN;

      convergedCells++;

      if (total < bestValue) {
        bestValue = total;
        bestIndex = index;
      }
    }
  }

  const best =
    bestIndex >= 0
      ? cellAt(
          {
            departureBody,
            arrivalBody,
            departureJdTt,
            timeOfFlightDays,
            totalDeltaV,
            vInfDeparture,
            vInfArrival,
            c3,
            transferAngleDeg,
            planeTiltDeg,
            columns,
            rows,
            convergedCells,
            best: null,
          },
          bestIndex,
        )
      : null;

  return {
    departureBody,
    arrivalBody,
    departureJdTt,
    timeOfFlightDays,
    totalDeltaV,
    vInfDeparture,
    vInfArrival,
    c3,
    transferAngleDeg,
    planeTiltDeg,
    columns,
    rows,
    convergedCells,
    best,
  };
}

/**
 * Central-difference velocity of a body at a TT Julian date.
 *
 * Deliberately the same 600 s step and the same reasoning as `sim/trajectory.ts` and the
 * ephemeris module: the honest derivative is of the shipped position function, because every
 * element is advanced linearly in time and an analytic derivative with constant elements
 * omits the rate terms. Duplicated rather than imported so that `src/core` does not depend on
 * `src/sim` (the dependency direction is sim -> core, never the reverse).
 */
function bodyVelocity(id: BodyId, jdTt: number): Vec3 {
  const h = 600 / SECONDS_PER_DAY;
  const a = bodyPosition(id, jdTt - h);
  const b = bodyPosition(id, jdTt + h);
  const k = 1 / 1200;
  return { x: (b.x - a.x) * k, y: (b.y - a.y) * k, z: (b.z - a.z) * k };
}

/** Local clamp, so this module imports nothing beyond the vector helpers it needs. */
function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/**
 * Value range over converged cells, for colour scaling.
 *
 * Uses the 2nd and 98th percentile rather than min and max. A porkchop grid almost always
 * contains a few near-grazing cells whose cost is enormous, and scaling to the maximum
 * compresses the entire useful window into the first two percent of the colour ramp.
 */
export function valueRange(
  values: Float64Array,
  lowQuantile = 0.02,
  highQuantile = 0.98,
): { min: number; max: number } {
  const finite: number[] = [];
  for (const v of values) if (Number.isFinite(v)) finite.push(v);
  // A grid with no solutions still needs a valid span, or the colour scale divides by zero.
  if (finite.length === 0) return { min: 0, max: 1 };
  finite.sort((a, b) => a - b);
  const lo = finite[Math.floor(lowQuantile * (finite.length - 1))]!;
  const hi = finite[Math.floor(highQuantile * (finite.length - 1))]!;
  // A constant grid (one converged cell, or all equal) still needs a non-zero span.
  return hi > lo ? { min: lo, max: hi } : { min: lo, max: lo + 1 };
}
