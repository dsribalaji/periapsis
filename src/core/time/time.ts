/**
 * Time systems.
 *
 * The simulation runs on a uniform continuous time scale expressed as Julian Date in
 * Terrestrial Time (TT). Civil input is UTC. See PHYSICS.md §2 and ADR-0006 for the
 * full discussion of what is implemented and what is deliberately omitted.
 *
 * This module has no ambient clock: callers pass dates in.
 */

import { J2000_JD, SECONDS_PER_DAY } from '../constants.js';

/** Leap-second table: [UTC instant, cumulative TAI-UTC seconds]. */
const LEAP_SECONDS: ReadonlyArray<readonly [string, number]> = [
  ['1972-01-01T00:00:00Z', 10],
  ['1972-07-01T00:00:00Z', 11],
  ['1973-01-01T00:00:00Z', 12],
  ['1974-01-01T00:00:00Z', 13],
  ['1975-01-01T00:00:00Z', 14],
  ['1976-01-01T00:00:00Z', 15],
  ['1977-01-01T00:00:00Z', 16],
  ['1978-01-01T00:00:00Z', 17],
  ['1979-01-01T00:00:00Z', 18],
  ['1980-01-01T00:00:00Z', 19],
  ['1981-07-01T00:00:00Z', 20],
  ['1982-07-01T00:00:00Z', 21],
  ['1983-07-01T00:00:00Z', 22],
  ['1985-07-01T00:00:00Z', 23],
  ['1988-01-01T00:00:00Z', 24],
  ['1990-01-01T00:00:00Z', 25],
  ['1991-01-01T00:00:00Z', 26],
  ['1992-07-01T00:00:00Z', 27],
  ['1993-07-01T00:00:00Z', 28],
  ['1994-07-01T00:00:00Z', 29],
  ['1996-01-01T00:00:00Z', 30],
  ['1997-07-01T00:00:00Z', 31],
  ['1999-01-01T00:00:00Z', 32],
  ['2006-01-01T00:00:00Z', 33],
  ['2009-01-01T00:00:00Z', 34],
  ['2012-07-01T00:00:00Z', 35],
  ['2015-07-01T00:00:00Z', 36],
  ['2017-01-01T00:00:00Z', 37],
];

/** TT - TAI in seconds, exact by definition. */
export const TT_MINUS_TAI = 32.184;

/** Smallest and largest civil years this app accepts as input (see PHYSICS.md §2). */
export const MIN_YEAR = 1800;
export const MAX_YEAR = 2100;

const MS_PER_DAY = 86400000;

/** Calendar fields for a UTC instant; month is 1-based. */
export interface CalendarDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

/**
 * Julian Date from a Gregorian calendar date (Meeus, *Astronomical Algorithms*, 2nd ed.,
 * ch. 7). Valid for the Gregorian calendar, which is what this app accepts.
 */
export function julianDateFromCalendar(d: CalendarDate): number {
  const { year, month, day, hour, minute, second } = d;
  let y = year;
  let m = month;
  if (m <= 2) {
    y -= 1;
    m += 12;
  }
  const a = Math.floor(y / 100);
  const b = 2 - a + Math.floor(a / 4);
  const dayFraction = (hour + minute / 60 + second / 3600) / 24;
  return (
    Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1)) + day + dayFraction + b - 1524.5
  );
}

/** Inverse of {@link julianDateFromCalendar} (Meeus ch. 7). */
export function calendarFromJulianDate(jd: number): CalendarDate {
  const z = Math.floor(jd + 0.5);
  const f = jd + 0.5 - z;
  let a = z;
  if (z >= 2299161) {
    const alpha = Math.floor((z - 1867216.25) / 36524.25);
    a = z + 1 + alpha - Math.floor(alpha / 4);
  }
  const b = a + 1524;
  const c = Math.floor((b - 122.1) / 365.25);
  const dd = Math.floor(365.25 * c);
  const e = Math.floor((b - dd) / 30.6001);

  const dayWithFraction = b - dd - Math.floor(30.6001 * e) + f;
  const dayInt = Math.floor(dayWithFraction);
  const month = e < 14 ? e - 1 : e - 13;
  const year = month > 2 ? c - 4716 : c - 4715;

  let fracSeconds = (dayWithFraction - dayInt) * SECONDS_PER_DAY;
  // Guard against 23:59:59.9999999 rounding up into the next day.
  fracSeconds = Math.max(0, Math.min(SECONDS_PER_DAY - 1e-6, fracSeconds));
  const hour = Math.floor(fracSeconds / 3600);
  const minute = Math.floor((fracSeconds - hour * 3600) / 60);
  const second = fracSeconds - hour * 3600 - minute * 60;

  return { year, month, day: dayInt, hour, minute, second };
}

/** Cumulative TAI-UTC seconds in force at the given UTC Julian Date. */
export function taiMinusUtc(jdUtc: number): number {
  let result = LEAP_SECONDS[0]![1];
  for (const [iso, secs] of LEAP_SECONDS) {
    const epoch = julianDateFromCalendar(isoToCalendar(iso));
    if (jdUtc >= epoch) result = secs;
    else break;
  }
  return result;
}

function isoToCalendar(iso: string): CalendarDate {
  const [datePart, timePart] = iso.split('T');
  const [y, mo, d] = datePart!.split('-').map(Number);
  const [h, mi, s] = (timePart ?? '00:00:00Z').replace('Z', '').split(':').map(Number);
  return {
    year: y!,
    month: mo!,
    day: d!,
    hour: h ?? 0,
    minute: mi ?? 0,
    second: s ?? 0,
  };
}

/** Parses an ISO-8601 UTC string such as `2026-11-18T00:00:00Z` into a Julian Date. */
export function jdFromIsoUtc(iso: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?)?Z?$/.exec(
    iso.trim(),
  );
  if (!m) throw new Error(`Not an ISO-8601 UTC date: ${iso}`);
  const cal: CalendarDate = {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: Number(m[4] ?? 0),
    minute: Number(m[5] ?? 0),
    second: Number(m[6] ?? 0),
  };
  assertDateInRange(cal);
  return julianDateFromCalendar(cal);
}

/** Formats a UTC Julian Date as `YYYY-MM-DDTHH:MM:SSZ`. */
export function isoUtcFromJd(jd: number): string {
  const c = calendarFromJulianDate(jd);
  const p2 = (n: number) => String(Math.floor(n)).padStart(2, '0');
  const whole = Math.floor(c.second);
  return `${String(c.year).padStart(4, '0')}-${p2(c.month)}-${p2(c.day)}T${p2(c.hour)}:${p2(
    c.minute,
  )}:${p2(whole)}Z`;
}

export function assertDateInRange(d: CalendarDate): void {
  if (d.year < MIN_YEAR || d.year > MAX_YEAR) {
    throw new Error(
      `Date out of supported range: year ${d.year} (supported ${MIN_YEAR}-${MAX_YEAR}). ` +
        'The built-in ephemerides are only meaningful in this window.',
    );
  }
  if (d.month < 1 || d.month > 12) throw new Error(`Invalid month: ${d.month}`);
  if (d.day < 1 || d.day > 31) throw new Error(`Invalid day: ${d.day}`);
}

/**
 * TT Julian Date from a UTC Julian Date: TT = UTC + (TAI-UTC) + 32.184 s.
 * The offset is ~69.184 s for dates after 2017-01-01.
 */
export function jdTtFromJdUtc(jdUtc: number): number {
  return jdUtc + (taiMinusUtc(jdUtc) + TT_MINUS_TAI) / SECONDS_PER_DAY;
}

/** UTC Julian Date from a TT Julian Date (inverse of {@link jdTtFromJdUtc}). */
export function jdUtcFromJdTt(jdTt: number): number {
  // The offset is piecewise constant; two passes converge because a 69 s shift cannot
  // cross a leap-second boundary except in astronomically improbable cases.
  let guess = jdTt - (37 + TT_MINUS_TAI) / SECONDS_PER_DAY;
  for (let i = 0; i < 3; i++) {
    guess = jdTt - (taiMinusUtc(guess) + TT_MINUS_TAI) / SECONDS_PER_DAY;
  }
  return guess;
}

/** Days since J2000.0 for a TT Julian Date. */
export const daysSinceJ2000 = (jdTt: number): number => jdTt - J2000_JD;

/** Julian centuries since J2000.0 (TT). */
export const centuriesSinceJ2000 = (jdTt: number): number => (jdTt - J2000_JD) / 36525;

/**
 * Greenwich Mean Sidereal Time in radians, IAU 1982 expression (Meeus eq. 12.4),
 * evaluated from a UT1 Julian Date. UT1 is approximated by UTC here; the resulting
 * longitude error is bounded in PHYSICS.md §2.
 */
export function gmstRadians(jdUt1: number): number {
  const t = (jdUt1 - J2000_JD) / 36525;
  let deg =
    280.46061837 +
    360.98564736629 * (jdUt1 - J2000_JD) +
    0.000387933 * t * t -
    (t * t * t) / 38710000;
  deg = ((deg % 360) + 360) % 360;
  return (deg * Math.PI) / 180;
}

/** Greenwich Mean Sidereal Time in radians for a TT Julian Date (UT1 ≈ UTC ≈ TT here). */
export const gmstFromJdTt = (jdTt: number): number => gmstRadians(jdUtcFromJdTt(jdTt));

/**
 * Earth rotation angle (IAU 2000) in radians, from a UT1 Julian Date. Used for the
 * Earth-fixed frame. Differs from GMST by the precession of the equinox, ~0.1" per
 * decade; either is adequate for a ground track and this uses the simpler ERA.
 */
export function earthRotationAngle(jdUt1: number): number {
  const d = jdUt1 - J2000_JD;
  const frac = 0.779057273264 + 0.00273781191135448 * d;
  const turns = (d + frac) % 1;
  return turns * 2 * Math.PI;
}

/** Milliseconds since the Unix epoch for a UT1/UTC Julian Date (used only by the UI). */
export const unixMsFromJd = (jd: number): number => (jd - 2440587.5) * MS_PER_DAY;
