import { describe, expect, it } from 'vitest';
import {
  TRANSFER_BODIES,
  bestSummary,
  cellFromFraction,
  civilDateFromJdTt,
  convergedFraction,
  defaultPorkchopRequest,
  departureTicks,
  fractionOfCell,
  normaliseValue,
  porkchopImage,
  rampColor,
  RAMP,
  readoutAt,
  requestToOptions,
  tofTicks,
  validatePorkchopRequest,
  windowWidthDays,
  type PorkchopRequest,
} from '../src/ui/porkchopView.js';
import { computePorkchop, valueRange, type Porkchop } from '../src/core/transfer/porkchop.js';
import { jdFromIsoUtc, jdTtFromJdUtc } from '../src/core/time/time.js';

const START = jdTtFromJdUtc(jdFromIsoUtc('2026-01-01T00:00:00Z'));

/** A small but real grid: real ephemerides, real Lambert solves, cheap to build. */
const GRID = computePorkchop({
  departureBody: 'earth',
  arrivalBody: 'mars',
  departureStartJdTt: START,
  departureEndJdTt: START + 780,
  minTimeOfFlightDays: 150,
  maxTimeOfFlightDays: 420,
  columns: 12,
  rows: 9,
});

function request(patch: Partial<PorkchopRequest> = {}): PorkchopRequest {
  return {
    departureBody: 'earth',
    arrivalBody: 'mars',
    departureStartIso: '2026-01-01',
    departureEndIso: '2027-12-31',
    minTofDays: 150,
    maxTofDays: 420,
    size: 40,
    ...patch,
  };
}

describe('default request', () => {
  it('starts at the epoch, so no column is in the past and every column can become a node', () => {
    const r = defaultPorkchopRequest('2026-11-18T12:00:00Z');
    expect(r.departureStartIso).toBe('2026-11-18');
    expect(r.departureEndIso).toBe('2028-12-31');
  });

  it('starts at the epoch for a mid-January epoch too, not at the month boundary', () => {
    expect(defaultPorkchopRequest('2027-01-02T03:04:05Z').departureStartIso).toBe('2027-01-02');
  });

  it('defaults to Earth to Mars, the textbook case', () => {
    const r = defaultPorkchopRequest('2026-11-18T12:00:00Z');
    expect(r.departureBody).toBe('earth');
    expect(r.arrivalBody).toBe('mars');
  });

  it('produces a request that validates', () => {
    expect(validatePorkchopRequest(defaultPorkchopRequest('2026-11-18T12:00:00Z'))).toEqual([]);
  });

  it('leaves an end-of-year epoch a usable window rather than an empty one', () => {
    // 31 December: a window that ended "two years later" is still three years of days away, but
    // the start must not roll forward into an empty range.
    const r = defaultPorkchopRequest('2026-12-31T23:00:00Z');
    expect(r.departureStartIso).toBe('2026-12-31');
    expect(validatePorkchopRequest(r)).toEqual([]);
  });
});

describe('request validation', () => {
  it('accepts a sane request', () => {
    expect(validatePorkchopRequest(request())).toEqual([]);
  });

  it('rejects the same body twice', () => {
    expect(validatePorkchopRequest(request({ arrivalBody: 'earth' }))).toContain(
      'Departure and arrival must be different bodies.',
    );
  });

  it('rejects a body that is not a planet', () => {
    // The Moon is a geocentric problem; the Sun is the centre. Both are excluded on purpose.
    expect(validatePorkchopRequest(request({ departureBody: 'moon' })).join(' ')).toContain(
      'not one',
    );
    expect(validatePorkchopRequest(request({ arrivalBody: 'sun' })).join(' ')).toContain('not one');
  });

  it('rejects an unparseable date', () => {
    const issues = validatePorkchopRequest(request({ departureStartIso: '2026-13-45' }));
    expect(issues.join(' ')).toContain('not a valid date');
  });

  it('rejects a date in the wrong format', () => {
    expect(
      validatePorkchopRequest(request({ departureStartIso: '1 Jan 2026' })).join(' '),
    ).toContain('not a valid date');
  });

  it('rejects a window that ends before it starts', () => {
    const issues = validatePorkchopRequest(
      request({ departureStartIso: '2027-01-01', departureEndIso: '2026-01-01' }),
    );
    expect(issues.join(' ')).toContain('must end after it starts');
  });

  it('rejects a zero-width window', () => {
    const issues = validatePorkchopRequest(
      request({ departureStartIso: '2026-01-01', departureEndIso: '2026-01-01' }),
    );
    expect(issues.join(' ')).toContain('must end after it starts');
  });

  it('rejects an absurdly wide window', () => {
    const issues = validatePorkchopRequest(
      request({ departureStartIso: '1850-01-01', departureEndIso: '2050-01-01' }),
    );
    expect(issues.join(' ')).toContain('wider than');
  });

  it('rejects a non-positive time of flight', () => {
    expect(validatePorkchopRequest(request({ minTofDays: 0 })).join(' ')).toContain('positive');
  });

  it('rejects an inverted time-of-flight range', () => {
    expect(
      validatePorkchopRequest(request({ minTofDays: 400, maxTofDays: 200 })).join(' '),
    ).toContain('must exceed');
  });

  it('rejects a grid outside the supported size', () => {
    expect(validatePorkchopRequest(request({ size: 1 })).join(' ')).toContain('whole number');
    expect(validatePorkchopRequest(request({ size: 500 })).join(' ')).toContain('whole number');
    expect(validatePorkchopRequest(request({ size: 40.5 })).join(' ')).toContain('whole number');
  });

  it('reports every problem at once rather than stopping at the first', () => {
    const issues = validatePorkchopRequest(
      request({ arrivalBody: 'earth', minTofDays: 0, size: 1 }),
    );
    // Three independent faults, three messages: a user fixing a form should not need three
    // round trips.
    expect(issues.length).toBeGreaterThanOrEqual(3);
  });
});

describe('request to physics options', () => {
  it('converts civil dates to TT', () => {
    const options = requestToOptions(
      request({ departureStartIso: '2026-01-01', departureEndIso: '2027-01-01' }),
    );
    const expectedStart = jdTtFromJdUtc(jdFromIsoUtc('2026-01-01T00:00:00Z'));
    expect(options.departureStartJdTt).toBeCloseTo(expectedStart, 9);
    // A year of civil days, measured on the TT scale the ephemeris uses.
    expect(options.departureEndJdTt - options.departureStartJdTt).toBeCloseTo(365, 6);
  });

  it('passes the bodies and the grid size straight through', () => {
    const options = requestToOptions(
      request({ departureBody: 'venus', arrivalBody: 'jupiter', size: 64 }),
    );
    expect(options.departureBody).toBe('venus');
    expect(options.arrivalBody).toBe('jupiter');
    expect(options.columns).toBe(64);
    expect(options.rows).toBe(64);
  });

  it('throws rather than inventing a window when a date is unparseable', () => {
    expect(() => requestToOptions(request({ departureStartIso: 'not a date' }))).toThrow(/valid/);
  });
});

describe('colour ramp', () => {
  it('returns the first and last stops at the extremes', () => {
    expect(rampColor(0)).toEqual([12, 24, 58]);
    expect(rampColor(1)).toEqual([190, 52, 44]);
  });

  it('clamps out-of-range inputs instead of throwing', () => {
    // The range comes from a percentile trim, so values beyond it are normal, not exceptional.
    expect(rampColor(-3)).toEqual(rampColor(0));
    expect(rampColor(7)).toEqual(rampColor(1));
    expect(rampColor(Number.NaN)).toEqual(rampColor(0));
  });

  it('moves from a cold end to a hot end', () => {
    // The ramp is not monotonic in any single channel — that is what makes it readable as
    // cold-to-hot rather than as a brightness bar. What it does guarantee is the ends: the
    // cheap end is blue-dominant, the expensive end red-dominant, and every stop distinct.
    const cheap = rampColor(0);
    const dear = rampColor(1);
    expect(cheap[2]).toBeGreaterThan(cheap[0]);
    expect(dear[0]).toBeGreaterThan(dear[2]);
    const stops = RAMP.map((_, i) => rampColor(i / (RAMP.length - 1)).join(','));
    expect(new Set(stops).size).toBe(RAMP.length);
  });

  it('separates neighbouring stops by a visible amount', () => {
    // Two adjacent stops that round to nearly the same colour would flatten part of the plot
    // into a single hue and hide a cost band. 25 of Euclidean RGB distance is comfortably
    // above the ~10 that a viewer can distinguish on a dark background.
    for (let i = 0; i < RAMP.length - 1; i++) {
      const a = rampColor(i / (RAMP.length - 1));
      const b = rampColor((i + 1) / (RAMP.length - 1));
      const distance = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      expect(distance).toBeGreaterThan(25);
    }
  });

  it('normalises against a range', () => {
    expect(normaliseValue(5, { min: 5, max: 10 })).toBe(0);
    expect(normaliseValue(7.5, { min: 5, max: 10 })).toBe(0.5);
    expect(normaliseValue(10, { min: 5, max: 10 })).toBe(1);
  });

  it('treats a degenerate range as the cheap end', () => {
    expect(normaliseValue(5, { min: 5, max: 5 })).toBe(0);
  });
});

describe('image buffer', () => {
  it('is one pixel per cell', () => {
    const image = porkchopImage(GRID);
    expect(image.width).toBe(GRID.columns);
    expect(image.height).toBe(GRID.rows);
    expect(image.data.length).toBe(GRID.columns * GRID.rows * 4);
  });

  it('puts the longest time of flight at the top', () => {
    // A synthetic grid whose cost is a function of its row, so any row in the buffer can be
    // identified from its colour. Orientation is then a fact about the pixels rather than a
    // restatement of the index arithmetic.
    const columns = 3;
    const rows = 4;
    const totalDeltaV = new Float64Array(columns * rows);
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < columns; column++) {
        // Row 0 costs the least, row 3 the most.
        totalDeltaV[row * columns + column] = row / (rows - 1);
      }
    }
    const grid: Porkchop = {
      departureBody: 'earth',
      arrivalBody: 'mars',
      departureJdTt: Float64Array.from([START, START + 10, START + 20]),
      timeOfFlightDays: Float64Array.from([150, 200, 250, 420]),
      totalDeltaV,
      vInfDeparture: totalDeltaV,
      vInfArrival: totalDeltaV,
      c3: totalDeltaV,
      transferAngleDeg: totalDeltaV,
      planeTiltDeg: totalDeltaV,
      columns,
      rows,
      convergedCells: columns * rows,
      best: null,
    };

    const image = porkchopImage(grid, { min: 0, max: 1 });
    const pixelAt = (bufferRow: number, column: number): number[] =>
      Array.from(
        image.data.slice(
          (bufferRow * columns + column) * 4,
          (bufferRow * columns + column) * 4 + 4,
        ),
      );

    // The strongest possible form of this assertion: every buffer row must be the exact ramp
    // colour of the grid row it is supposed to represent. Buffer row 0 must be grid row 3 (the
    // longest time of flight, cost 1), buffer row 3 must be grid row 0 (cost 0).
    for (let bufferRow = 0; bufferRow < rows; bufferRow++) {
      const gridRow = rows - 1 - bufferRow;
      const expected = [...rampColor(gridRow / (rows - 1)), 255];
      expect(pixelAt(bufferRow, 0)).toEqual(expected);
    }
    // And the two ends really are different colours, so the loop above is not vacuous.
    expect(pixelAt(0, 0)).not.toEqual(pixelAt(rows - 1, 0));
  });

  it('leaves unconverged cells fully transparent', () => {
    // A fraction of a day to Mars has no single-revolution solution, so every cell is a hole.
    const grid = computePorkchop({
      departureBody: 'earth',
      arrivalBody: 'mars',
      departureStartJdTt: START,
      departureEndJdTt: START + 780,
      minTimeOfFlightDays: 0.01,
      maxTimeOfFlightDays: 0.014,
      columns: 4,
      rows: 4,
    });
    const image = porkchopImage(grid);
    expect(grid.convergedCells).toBe(0);
    for (let i = 3; i < image.data.length; i += 4) expect(image.data[i]).toBe(0);
  });

  it('paints converged cells opaque', () => {
    const image = porkchopImage(GRID);
    let opaque = 0;
    for (let i = 3; i < image.data.length; i += 4) if (image.data[i] === 255) opaque++;
    expect(opaque).toBe(GRID.convergedCells);
  });

  it('gives the cheapest cell a cooler colour than the dearest', () => {
    const range = valueRange(GRID.totalDeltaV);
    const image = porkchopImage(GRID, range);
    let cheapRed = 255;
    let dearRed = -1;
    for (let row = 0; row < GRID.rows; row++) {
      for (let column = 0; column < GRID.columns; column++) {
        const at = ((GRID.rows - 1 - row) * GRID.columns + column) * 4;
        const red = image.data[at]!;
        const value = GRID.totalDeltaV[row * GRID.columns + column]!;
        if (!Number.isFinite(value)) continue;
        if (value === GRID.best!.totalDeltaV) cheapRed = Math.min(cheapRed, red);
        if (value < range.max) continue;
        dearRed = Math.max(dearRed, red);
      }
    }
    expect(cheapRed).toBeLessThan(dearRed);
  });
});

describe('pointer to cell', () => {
  it('maps the top-left corner to the shortest-column, longest-row cell', () => {
    expect(cellFromFraction(GRID, 0, 0)).toEqual({ column: 0, row: GRID.rows - 1 });
  });

  it('maps the bottom-right corner to the last column, shortest row', () => {
    expect(cellFromFraction(GRID, 1, 1)).toEqual({ column: GRID.columns - 1, row: 0 });
  });

  it('uses floor rather than round, so the outer half-strip stays selectable', () => {
    // A tenth of the way into the first strip is still the first strip.
    expect(cellFromFraction(GRID, 0.1 / GRID.columns, 0.5).column).toBe(0);
  });

  it('clamps a pointer outside the box rather than returning an invalid cell', () => {
    const point = cellFromFraction(GRID, -2, 3);
    expect(point.column).toBe(0);
    expect(point.row).toBe(0);
  });

  it('round-trips a cell centre through its fraction', () => {
    const fraction = fractionOfCell(GRID, 3, 5);
    expect(cellFromFraction(GRID, fraction.x, fraction.y)).toEqual({ column: 3, row: 5 });
  });

  it('round-trips every cell, including the edges', () => {
    for (let row = 0; row < GRID.rows; row++) {
      for (let column = 0; column < GRID.columns; column++) {
        const f = fractionOfCell(GRID, column, row);
        expect(cellFromFraction(GRID, f.x, f.y)).toEqual({ column, row });
      }
    }
  });
});

describe('axis ticks', () => {
  it('spans the departure window end to end', () => {
    const ticks = departureTicks(GRID, 4);
    expect(ticks).toHaveLength(4);
    expect(ticks[0]!.fraction).toBe(0);
    expect(ticks[3]!.fraction).toBe(1);
    expect(ticks[0]!.label).toBe(civilDateFromJdTt(GRID.departureJdTt[0]!).slice(0, 7));
    expect(ticks[3]!.label).toBe(
      civilDateFromJdTt(GRID.departureJdTt[GRID.columns - 1]!).slice(0, 7),
    );
  });

  it('labels time of flight in whole days, ascending', () => {
    const ticks = tofTicks(GRID, 4);
    expect(ticks[0]!.label).toBe('150 d');
    expect(ticks[3]!.label).toBe('420 d');
    const values = ticks.map((t) => Number.parseInt(t.label, 10));
    for (let i = 1; i < values.length; i++) expect(values[i]!).toBeGreaterThan(values[i - 1]!);
  });

  it('never returns fewer than two ticks', () => {
    expect(departureTicks(GRID, 1)).toHaveLength(2);
    expect(tofTicks(GRID, 0)).toHaveLength(2);
  });
});

describe('cell readout', () => {
  it('reports the dates, the cost and the geometry of a converged cell', () => {
    const cell = readoutAt(GRID, 6, 4)!;
    expect(cell).not.toBeNull();
    expect(cell.column).toBe(6);
    expect(cell.row).toBe(4);
    expect(cell.departureIso).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(cell.arrivalIso).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(cell.arrivalIso > cell.departureIso).toBe(true);
    expect(cell.totalDeltaV).toBeCloseTo(cell.vInfDeparture + cell.vInfArrival, 6);
    // C3 is reported in km^2/s^2 while the grid stores m^2/s^2.
    expect(cell.c3).toBeCloseTo((cell.vInfDeparture * cell.vInfDeparture) / 1e6, 3);
    expect(cell.timeOfFlightDays).toBeCloseTo(GRID.timeOfFlightDays[4]!, 9);
  });

  it('returns null for a coordinate outside the grid', () => {
    expect(readoutAt(GRID, -1, 0)).toBeNull();
    expect(readoutAt(GRID, 0, GRID.rows)).toBeNull();
  });

  it('returns null for a cell with no solution', () => {
    const holed = computePorkchop({
      departureBody: 'earth',
      arrivalBody: 'mars',
      departureStartJdTt: START,
      departureEndJdTt: START + 780,
      minTimeOfFlightDays: 0.01,
      maxTimeOfFlightDays: 0.014,
      columns: 4,
      rows: 4,
    });
    expect(readoutAt(holed, 1, 1)).toBeNull();
  });
});

describe('summary', () => {
  it('names the cheapest window in one sentence', () => {
    const summary = bestSummary(GRID)!;
    expect(summary).toContain('Cheapest window');
    expect(summary).toContain('km/s');
    expect(summary).toContain('C3');
    expect(summary).toMatch(/depart \d{4}-\d{2}-\d{2}/);
    expect(summary).toMatch(/arrive \d{4}-\d{2}-\d{2}/);
  });

  it('reports the same cost the grid found', () => {
    const summary = bestSummary(GRID)!;
    const kmPerSecond = (GRID.best!.totalDeltaV / 1000).toFixed(2);
    expect(summary).toContain(kmPerSecond);
  });

  it('is null when nothing converged, rather than claiming a window', () => {
    const holed = computePorkchop({
      departureBody: 'earth',
      arrivalBody: 'mars',
      departureStartJdTt: START,
      departureEndJdTt: START + 780,
      minTimeOfFlightDays: 0.01,
      maxTimeOfFlightDays: 0.014,
      columns: 4,
      rows: 4,
    });
    expect(bestSummary(holed)).toBeNull();
  });
});

describe('plot statistics', () => {
  it('reports the departure window width in days', () => {
    expect(windowWidthDays(GRID)).toBeCloseTo(780, 6);
  });

  it('reports the converged fraction', () => {
    expect(convergedFraction(GRID)).toBe(1);
  });

  it('reports a partial grid honestly', () => {
    // A sub-day time of flight to Mars has no single-revolution solution for some cells: the
    // solver's speed ceiling rejects the rectilinear plunge. Measured on this grid: 29 of 64
    // cells converge. A fraction of 1 here would mean the holes were being filled in.
    const holed = computePorkchop({
      departureBody: 'earth',
      arrivalBody: 'mars',
      departureStartJdTt: START,
      departureEndJdTt: START + 780,
      minTimeOfFlightDays: 0.04,
      maxTimeOfFlightDays: 0.2,
      columns: 8,
      rows: 8,
    });
    const fraction = convergedFraction(holed);
    expect(fraction).toBeGreaterThan(0);
    expect(fraction).toBeLessThan(1);
    expect(fraction).toBeCloseTo(holed.convergedCells / 64, 9);
  });
});

describe('transfer body list', () => {
  it('offers every planet and neither the Sun nor the Moon', () => {
    expect(TRANSFER_BODIES).toContain('mercury');
    expect(TRANSFER_BODIES).toContain('neptune');
    expect(TRANSFER_BODIES).not.toContain('sun');
    expect(TRANSFER_BODIES).not.toContain('moon');
  });
});
