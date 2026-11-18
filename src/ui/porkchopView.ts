/**
 * Porkchop view-model: the pure half of the heat-map panel.
 *
 * The grid itself (`core/transfer/porkchop.ts`) knows nothing about colour, pixels or axis
 * labels, and it should stay that way: it is physics. Everything a panel needs in order to
 * *show* a grid lives here, so that the parts which are easy to get subtly wrong — the row
 * orientation of a buffer, the mapping from a mouse position to a cell, the colour ramp, the
 * summary sentence — are asserted by unit tests instead of by squinting at a canvas.
 *
 * Three conventions worth stating once:
 *
 * - **Buffer row 0 is the top of the plot**, which is the *longest* time of flight. The grid
 *   stores rows shortest-first, so the image builder flips. Drawing then needs no transform,
 *   and there is exactly one flip in the codebase instead of one per consumer.
 * - **A cell with no solution is transparent**, not black. A hole in the domain must look
 *   like a hole; a black cell is indistinguishable from a very cheap transfer on a dark plot.
 * - **Fractions are 0..1 across the plot box**, origin top-left, with y growing downward, so a
 *   pointer position converts to a fraction by division alone.
 *
 * Pure: no DOM, no canvas, no clock. The component does the drawing.
 */

import { BODIES, type BodyId } from '../core/ephemeris/solarSystem.js';
import {
  calendarFromJulianDate,
  isoUtcFromJd,
  jdFromIsoUtc,
  jdTtFromJdUtc,
  jdUtcFromJdTt,
} from '../core/time/time.js';
import {
  cellAt,
  cellIndex,
  valueRange,
  type Porkchop,
  type PorkchopOptions,
} from '../core/transfer/porkchop.js';

/**
 * Bodies a heliocentric porkchop can be built between.
 *
 * The Sun is excluded because it is the centre of the problem, and the Moon because it is not
 * a heliocentric body: a "transfer to the Moon" is a geocentric problem with a much smaller
 * central body, and solving it with the Sun's mu would produce a confident wrong answer.
 */
export const TRANSFER_BODIES: readonly BodyId[] = [
  'mercury',
  'venus',
  'earth',
  'mars',
  'jupiter',
  'saturn',
  'uranus',
  'neptune',
];

/** What the user typed, before it becomes a grid. */
export interface PorkchopRequest {
  readonly departureBody: BodyId;
  readonly arrivalBody: BodyId;
  /** Civil date, `YYYY-MM-DD`: the first departure column. */
  readonly departureStartIso: string;
  /** Civil date, `YYYY-MM-DD`: the last departure column. */
  readonly departureEndIso: string;
  readonly minTofDays: number;
  readonly maxTofDays: number;
  /** Columns and rows. The grid is square. */
  readonly size: number;
}

/** Longest departure window accepted, days. */
const MAX_WINDOW_DAYS = 4000;
/** Largest grid side accepted. 200x200 is 40,000 Lambert solves (~0.5 s). */
const MAX_SIZE = 200;

/**
 * A sensible first window for a given epoch: the year of the epoch through two years later.
 *
 * Three years is chosen rather than a synodic period because it contains at least one Earth-
 * Mars window (780 d) and three of Venus's (584 d), so the default answer is interesting for
 * every pair without the caller knowing which pair it is.
 */
export function defaultPorkchopRequest(epochUtc: string): PorkchopRequest {
  const year = epochYear(epochUtc);
  return {
    departureBody: 'earth',
    arrivalBody: 'mars',
    departureStartIso: `${year}-01-01`,
    departureEndIso: `${year + 2}-12-31`,
    minTofDays: 150,
    maxTofDays: 420,
    size: 100,
  };
}

/** True for a `YYYY-MM-DD` string that parses as a supported date. */
function parseCivilDate(iso: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  try {
    return jdFromIsoUtc(`${iso}T00:00:00Z`);
  } catch {
    return null;
  }
}

/**
 * Calendar year of an ISO instant, for the "has the scenario moved?" check.
 *
 * A window seeded on 2026 is confidently empty in 2028, but re-seeding on every scenario
 * switch would throw away a hand-edited window for no reason. The year is the coarsest field
 * that distinguishes the two cases, so it is the one used.
 */
export function epochYear(epochUtc: string): number {
  return calendarFromJulianDate(jdFromIsoUtc(epochUtc)).year;
}

/**
 * Everything wrong with a request, as sentences. Empty means it can be computed.
 *
 * Returned as a list rather than thrown-first because the panel shows all of it at once: a
 * user who mistypes both dates should not have to fix them one at a time.
 */
export function validatePorkchopRequest(request: PorkchopRequest): readonly string[] {
  const issues: string[] = [];

  if (request.departureBody === request.arrivalBody) {
    issues.push('Departure and arrival must be different bodies.');
  }
  for (const body of [request.departureBody, request.arrivalBody]) {
    if (!TRANSFER_BODIES.includes(body)) {
      issues.push(`Transfers are only defined between planets; ${BODIES[body].name} is not one.`);
      break;
    }
  }

  const start = parseCivilDate(request.departureStartIso);
  const end = parseCivilDate(request.departureEndIso);
  if (start === null) issues.push('The departure window start is not a valid date.');
  if (end === null) issues.push('The departure window end is not a valid date.');
  if (start !== null && end !== null) {
    const spanDays = end - start;
    if (!(spanDays >= 1)) {
      issues.push('The departure window must end after it starts.');
    } else if (spanDays > MAX_WINDOW_DAYS) {
      issues.push(`The departure window is wider than ${MAX_WINDOW_DAYS} days.`);
    }
  }

  if (!(request.minTofDays > 0)) {
    issues.push('The shortest time of flight must be positive.');
  }
  if (!(request.maxTofDays > request.minTofDays)) {
    issues.push('The longest time of flight must exceed the shortest.');
  }
  if (!Number.isInteger(request.size) || request.size < 2 || request.size > MAX_SIZE) {
    issues.push(`The grid must be a whole number of cells between 2 and ${MAX_SIZE}.`);
  }

  return issues;
}

/** Converts a validated request into the physics call's options. */
export function requestToOptions(request: PorkchopRequest): PorkchopOptions {
  const start = parseCivilDate(request.departureStartIso);
  const end = parseCivilDate(request.departureEndIso);
  if (start === null || end === null) {
    throw new Error('requestToOptions: departure window is not a valid date range');
  }
  return {
    departureBody: request.departureBody,
    arrivalBody: request.arrivalBody,
    // Civil dates in, TT out: the ephemeris is evaluated on TT (PHYSICS.md §2).
    departureStartJdTt: jdTtFromJdUtc(start),
    departureEndJdTt: jdTtFromJdUtc(end),
    minTimeOfFlightDays: request.minTofDays,
    maxTimeOfFlightDays: request.maxTofDays,
    columns: request.size,
    rows: request.size,
  };
}

/** An RGB triple, each component 0..255. */
export type Rgb = readonly [number, number, number];

/**
 * The colour ramp, cheap to expensive.
 *
 * Chosen for readability on the dark theme rather than for perceptual uniformity: the cheap
 * end sits near the background so a good window reads as a shadow, and the expensive end is
 * hot, so the eye is drawn to what a mission cannot afford. A perceptually uniform ramp
 * (`viridis`) would be prettier but its endpoints are both mid-bright, which makes the plot
 * fight the panel behind it for no gain in rank ordering, and rank ordering is all a porkchop
 * plots.
 */
export const RAMP: readonly Rgb[] = [
  [12, 24, 58],
  [23, 74, 128],
  [30, 132, 150],
  [58, 168, 118],
  [150, 190, 84],
  [226, 190, 74],
  [232, 132, 52],
  [190, 52, 44],
];

/**
 * Colour for a normalised cost `t`. Clamped, so an out-of-range value paints rather than
 * throwing; the caller's range is a percentile trim, so values outside it are expected.
 */
export function rampColor(t: number): Rgb {
  const clamped = Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0;
  const segments = RAMP.length - 1;
  const scaled = clamped * segments;
  const low = Math.min(segments - 1, Math.floor(scaled));
  const fraction = scaled - low;
  const a = RAMP[low]!;
  const b = RAMP[low + 1]!;
  return [
    Math.round(a[0] + (b[0] - a[0]) * fraction),
    Math.round(a[1] + (b[1] - a[1]) * fraction),
    Math.round(a[2] + (b[2] - a[2]) * fraction),
  ];
}

/** Normalises a cost against the colour range; a degenerate range maps to the cheap end. */
export function normaliseValue(value: number, range: { min: number; max: number }): number {
  const span = range.max - range.min;
  return span > 0 ? (value - range.min) / span : 0;
}

/** A cell-resolution image, ready for `ImageData`. Row 0 is the top of the plot. */
export interface PorkchopImage {
  readonly width: number;
  readonly height: number;
  /**
   * Backed by a plain `ArrayBuffer`, not merely `ArrayBufferLike`: `new ImageData(...)` takes
   * `Uint8ClampedArray<ArrayBuffer>`, and a `SharedArrayBuffer`-backed view is rejected by the
   * DOM types. Building the buffer locally means that is guaranteed rather than asserted.
   */
  readonly data: Uint8ClampedArray<ArrayBuffer>;
}

/**
 * Paints the grid into an RGBA buffer, one pixel per cell.
 *
 * One pixel per cell rather than one pixel per screen pixel: the geometry is a grid, the cell
 * is the unit, and letting the canvas scale a small buffer gives a smooth surface for free. It
 * also makes the buffer a pure function of the grid, which is what lets the orientation be
 * tested.
 */
export function porkchopImage(
  grid: Porkchop,
  range: { min: number; max: number } = valueRange(grid.totalDeltaV),
): PorkchopImage {
  const { columns, rows } = grid;
  const data: Uint8ClampedArray<ArrayBuffer> = new Uint8ClampedArray(columns * rows * 4);
  for (let row = 0; row < rows; row++) {
    // Flip: the top of the plot is the longest time of flight.
    const bufferRow = rows - 1 - row;
    for (let column = 0; column < columns; column++) {
      const value = grid.totalDeltaV[cellIndex(grid, column, row)]!;
      if (!Number.isFinite(value)) continue; // leaves the pixel transparent: a hole
      const [red, green, blue] = rampColor(normaliseValue(value, range));
      const at = (bufferRow * columns + column) * 4;
      data[at] = red;
      data[at + 1] = green;
      data[at + 2] = blue;
      data[at + 3] = 255;
    }
  }
  return { width: columns, height: rows, data };
}

/** A cell address in the grid. */
export interface GridPoint {
  readonly column: number;
  readonly row: number;
}

const clampFraction = (f: number): number => (f < 0 ? 0 : f > 1 ? 1 : f);

/**
 * The cell under a fractional position in the plot box.
 *
 * `floor` rather than `round`, because the drawn image divides the box into `columns` equal
 * strips: the cell whose strip contains the pointer is the honest answer. `round` would make
 * the outermost half-strip unselectable.
 */
export function cellFromFraction(grid: Porkchop, x: number, y: number): GridPoint {
  const column = Math.min(grid.columns - 1, Math.floor(clampFraction(x) * grid.columns));
  const row = Math.min(grid.rows - 1, Math.floor((1 - clampFraction(y)) * grid.rows));
  return { column, row };
}

/** Fractional position of a cell's centre, for markers. */
export function fractionOfCell(
  grid: Porkchop,
  column: number,
  row: number,
): { x: number; y: number } {
  return {
    x: (column + 0.5) / grid.columns,
    y: 1 - (row + 0.5) / grid.rows,
  };
}

/** A TT Julian date as a civil `YYYY-MM-DD`, which is how a departure window is discussed. */
export function civilDateFromJdTt(jdTt: number): string {
  return isoUtcFromJd(jdUtcFromJdTt(jdTt)).slice(0, 10);
}

/** One labelled position on an axis, `fraction` in 0..1 from the axis origin. */
export interface AxisTick {
  readonly fraction: number;
  readonly label: string;
}

/** Evenly spaced departure-date ticks, labelled by year and month. */
export function departureTicks(grid: Porkchop, count = 4): readonly AxisTick[] {
  const n = Math.max(2, Math.floor(count));
  const first = grid.departureJdTt[0]!;
  const last = grid.departureJdTt[grid.columns - 1]!;
  const ticks: AxisTick[] = [];
  for (let i = 0; i < n; i++) {
    const fraction = i / (n - 1);
    // Interpolated rather than indexed: the ticks are positions on an axis, not cells.
    ticks.push({
      fraction,
      label: civilDateFromJdTt(first + fraction * (last - first)).slice(0, 7),
    });
  }
  return ticks;
}

/** Evenly spaced time-of-flight ticks, labelled in whole days. */
export function tofTicks(grid: Porkchop, count = 4): readonly AxisTick[] {
  const n = Math.max(2, Math.floor(count));
  const first = grid.timeOfFlightDays[0]!;
  const last = grid.timeOfFlightDays[grid.rows - 1]!;
  const ticks: AxisTick[] = [];
  for (let i = 0; i < n; i++) {
    const fraction = i / (n - 1);
    ticks.push({
      fraction,
      label: `${Math.round(first + fraction * (last - first))} d`,
    });
  }
  return ticks;
}

/** Everything a hover readout reports about one cell. */
export interface CellReadout {
  readonly column: number;
  readonly row: number;
  readonly departureIso: string;
  readonly arrivalIso: string;
  readonly timeOfFlightDays: number;
  /** `vInfDeparture + vInfArrival`, m/s. */
  readonly totalDeltaV: number;
  readonly vInfDeparture: number;
  readonly vInfArrival: number;
  /** km^2/s^2. */
  readonly c3: number;
  readonly transferAngleDeg: number;
  readonly planeTiltDeg: number;
}

/**
 * Readout for a cell, or null when that cell has no solution.
 *
 * Null rather than a row of NaN so the panel can say "no single-revolution arc here" instead
 * of printing `NaN km/s`, which reads as a bug in the readout rather than a fact about the
 * geometry.
 */
export function readoutAt(grid: Porkchop, column: number, row: number): CellReadout | null {
  if (column < 0 || row < 0 || column >= grid.columns || row >= grid.rows) return null;
  const cell = cellAt(grid, cellIndex(grid, column, row));
  if (!Number.isFinite(cell.totalDeltaV)) return null;
  return {
    column: cell.column,
    row: cell.row,
    departureIso: civilDateFromJdTt(cell.departureJdTt),
    arrivalIso: civilDateFromJdTt(cell.arrivalJdTt),
    timeOfFlightDays: cell.timeOfFlightDays,
    totalDeltaV: cell.totalDeltaV,
    vInfDeparture: cell.vInfDeparture,
    vInfArrival: cell.vInfArrival,
    c3: cell.c3 / 1e6,
    transferAngleDeg: cell.transferAngleDeg,
    planeTiltDeg: cell.planeTiltDeg,
  };
}

/**
 * One sentence describing the cheapest cell, or null when nothing converged.
 *
 * Kept ASCII-only and free of units symbols beyond `km/s`: this string is also the canvas's
 * accessible name, and it is the only thing a screen reader gets from the plot.
 */
export function bestSummary(grid: Porkchop): string | null {
  const best = grid.best;
  if (!best) return null;
  const departDate = civilDateFromJdTt(best.departureJdTt);
  const arriveDate = civilDateFromJdTt(best.arrivalJdTt);
  return (
    `Cheapest window: depart ${departDate}, arrive ${arriveDate} ` +
    `(${best.timeOfFlightDays.toFixed(0)} d), ` +
    `${(best.totalDeltaV / 1000).toFixed(2)} km/s of v-infinity, ` +
    `C3 ${(best.c3 / 1e6).toFixed(1)} km^2/s^2.`
  );
}

/** Days in the departure window, for the caption. */
export function windowWidthDays(grid: Porkchop): number {
  return grid.departureJdTt[grid.columns - 1]! - grid.departureJdTt[0]!;
}

/** Cells that produced a solution, as a fraction of the whole. */
export function convergedFraction(grid: Porkchop): number {
  return grid.convergedCells / (grid.columns * grid.rows);
}
