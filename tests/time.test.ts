import { describe, expect, it } from 'vitest';
import {
  julianDateFromCalendar,
  calendarFromJulianDate,
  jdFromIsoUtc,
  isoUtcFromJd,
  gmstRadians,
  gmstFromJdTt,
  earthRotationAngle,
  jdTtFromJdUtc,
  jdUtcFromJdTt,
  taiMinusUtc,
  assertDateInRange,
  TT_MINUS_TAI,
} from '../src/core/time/time.js';

const J2000_JD = 2451545.0;

describe('Julian date conversion', () => {
  it('maps the J2000.0 epoch to JD 2451545.0', () => {
    const jd = julianDateFromCalendar({
      year: 2000,
      month: 1,
      day: 1,
      hour: 12,
      minute: 0,
      second: 0,
    });
    expect(jd).toBeCloseTo(J2000_JD, 9);
  });

  it('maps a known modern date correctly', () => {
    // 2026-11-18T00:00:00Z. Cross-checked against Date.getTime(): the Unix epoch
    // offset is 2461362.5 JD, i.e. 9817.5 days after 2000-01-01T12:00.
    expect(jdFromIsoUtc('2026-11-18T00:00:00Z')).toBeCloseTo(2461362.5, 9);
  });

  it('maps 1987-01-27.0 (Meeus example 7.a) to JD 2446822.5', () => {
    const jd = julianDateFromCalendar({
      year: 1987,
      month: 1,
      day: 27,
      hour: 0,
      minute: 0,
      second: 0,
    });
    expect(jd).toBeCloseTo(2446822.5, 9);
  });

  it('maps 1987-06-19.5 (Meeus example 7.b) to JD 2446966.0', () => {
    const jd = julianDateFromCalendar({
      year: 1987,
      month: 6,
      day: 19,
      hour: 12,
      minute: 0,
      second: 0,
    });
    expect(jd).toBeCloseTo(2446966.0, 9);
  });

  it('maps J2000.0 back to the calendar date', () => {
    const c = calendarFromJulianDate(J2000_JD);
    expect(c.year).toBe(2000);
    expect(c.month).toBe(1);
    expect(c.day).toBe(1);
    expect(c.hour).toBe(12);
    expect(c.minute).toBe(0);
    expect(c.second).toBeCloseTo(0, 6);
  });

  it('round-trips calendar -> JD -> calendar over many dates', () => {
    for (let year = 1900; year <= 2100; year += 7) {
      for (const month of [1, 3, 6, 9, 12]) {
        for (const day of [1, 15, 28]) {
          for (const hour of [0, 7, 23]) {
            const input = { year, month, day, hour, minute: 30, second: 15 };
            const jd = julianDateFromCalendar(input);
            const out = calendarFromJulianDate(jd);
            expect(out.year).toBe(year);
            expect(out.month).toBe(month);
            expect(out.day).toBe(day);
            expect(out.hour).toBe(hour);
            expect(out.minute).toBe(30);
            expect(out.second).toBeCloseTo(15, 4);
          }
        }
      }
    }
  });

  it('round-trips ISO strings', () => {
    for (const iso of [
      '2026-11-18T00:00:00Z',
      '1999-12-31T23:59:59Z',
      '2035-04-01T12:34:56Z',
      '2000-01-01T12:00:00Z',
    ]) {
      expect(isoUtcFromJd(jdFromIsoUtc(iso))).toBe(iso);
    }
  });

  it('rejects out-of-range and malformed dates', () => {
    expect(() => jdFromIsoUtc('1700-01-01T00:00:00Z')).toThrow(/out of supported range/);
    expect(() => jdFromIsoUtc('3000-01-01T00:00:00Z')).toThrow(/out of supported range/);
    expect(() => jdFromIsoUtc('not-a-date')).toThrow(/ISO-8601/);
    expect(() =>
      assertDateInRange({ year: 2026, month: 13, day: 1, hour: 0, minute: 0, second: 0 }),
    ).toThrow(/month/);
    expect(() =>
      assertDateInRange({ year: 2026, month: 1, day: 32, hour: 0, minute: 0, second: 0 }),
    ).toThrow(/day/);
  });

  it('does not lose a day at end-of-day fractions', () => {
    // 23:59:59.9999 must stay on the same calendar day.
    const jd = julianDateFromCalendar({
      year: 2026,
      month: 5,
      day: 10,
      hour: 23,
      minute: 59,
      second: 59.9999,
    });
    const c = calendarFromJulianDate(jd);
    expect(c.day).toBe(10);
    expect(c.hour).toBe(23);
  });
});

describe('leap seconds and time scales', () => {
  it('knows TAI-UTC after the 2017 leap second', () => {
    expect(taiMinusUtc(jdFromIsoUtc('2026-11-18T00:00:00Z'))).toBe(37);
  });

  it('knows TAI-UTC before 1972 is the initial 10 s', () => {
    expect(taiMinusUtc(jdFromIsoUtc('1971-06-01T00:00:00Z'))).toBe(10);
  });

  it('applies the TT-UTC offset of 69.184 s in 2026', () => {
    const jdUtc = jdFromIsoUtc('2026-11-18T00:00:00Z');
    const offsetSeconds = (jdTtFromJdUtc(jdUtc) - jdUtc) * 86400;
    // Tolerance is set by double precision, not by the model: one ulp of a JD near
    // 2.46e6 is ~4.7e-5 s, so a subtler bound would be testing floating point.
    expect(offsetSeconds).toBeCloseTo(69.184, 3);
    expect(37 + TT_MINUS_TAI).toBeCloseTo(69.184, 9);
  });

  it('inverts TT <-> UTC to well under a microsecond', () => {
    for (const iso of ['2000-06-01T00:00:00Z', '2016-03-01T12:00:00Z', '2026-11-18T00:00:00Z']) {
      const jdUtc = jdFromIsoUtc(iso);
      const roundTrip = jdUtcFromJdTt(jdTtFromJdUtc(jdUtc));
      expect(Math.abs(roundTrip - jdUtc) * 86400).toBeLessThan(1e-6);
    }
  });
});

describe('sidereal time', () => {
  it('gives GMST 280.46 deg at J2000.0 (Meeus 12.a sanity)', () => {
    const gmst = gmstRadians(J2000_JD);
    const deg = (gmst * 180) / Math.PI;
    expect(deg).toBeCloseTo(280.46061837, 6);
  });

  it('advances by just under 360.9856 deg per day', () => {
    const a = gmstRadians(2460000.5);
    const b = gmstRadians(2460001.5);
    let delta = ((b - a) * 180) / Math.PI;
    if (delta < 0) delta += 360;
    expect(delta).toBeCloseTo(360.98564736629 % 360, 6);
  });

  it('stays within [0, 2π)', () => {
    for (let jd = 2451545; jd < 2451545 + 400; jd += 7.3) {
      const g = gmstRadians(jd);
      expect(g).toBeGreaterThanOrEqual(0);
      expect(g).toBeLessThan(2 * Math.PI);
    }
  });

  it('gives an Earth rotation angle consistent with GMST to within precession drift', () => {
    const jd = 2461362.5;
    const era = earthRotationAngle(jd);
    const gmst = gmstRadians(jd);
    let diff = Math.abs(era - gmst);
    if (diff > Math.PI) diff = 2 * Math.PI - diff;
    const diffDeg = (diff * 180) / Math.PI;
    // The two angles differ by the accumulated precession of the equinox since J2000.
    // General precession is ~50.29"/yr, so by 2026 (26.9 yr) that is ~0.375 deg; the
    // measured 0.344 deg is consistent. Bounds are 0.2-0.6 deg, i.e. a band around the
    // predicted value rather than an arbitrary pass threshold.
    expect(diffDeg).toBeGreaterThan(0.2);
    expect(diffDeg).toBeLessThan(0.6);
  });

  it('converts TT to GMST consistently', () => {
    const jdUtc = jdFromIsoUtc('2026-11-18T00:00:00Z');
    const viaTt = gmstFromJdTt(jdTtFromJdUtc(jdUtc));
    const direct = gmstRadians(jdUtc);
    let diff = Math.abs(viaTt - direct);
    if (diff > Math.PI) diff = 2 * Math.PI - diff;
    // 69 s of Earth rotation is about 0.29 deg.
    expect((diff * 180) / Math.PI).toBeLessThan(0.5);
  });
});
