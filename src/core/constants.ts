/**
 * Physical and astronomical constants.
 *
 * Sources and dates are recorded in PHYSICS.md. Every value here is a published
 * constant; none is fitted by this project.
 */

/** Astronomical unit in metres (IAU 2012 definition, exact). */
export const AU_M = 1.495978707e11;

/** Julian date of the J2000.0 epoch (2000-01-01 12:00 TT). */
export const J2000_JD = 2451545.0;

/** Julian day length in seconds. */
export const SECONDS_PER_DAY = 86400;

/** Julian year in seconds (365.25 d), the time unit for GM-derived quantities. */
export const SECONDS_PER_YEAR = 365.25 * SECONDS_PER_DAY;

/** Kilometre in metres, for readable literals. */
export const KM = 1000;

/**
 * Gravitational parameters GM = G·M in m³/s².
 * Values: JPL/IAU system constants (DE440-era). See PHYSICS.md table.
 */
export const GM = {
  sun: 1.32712440018e20,
  mercury: 2.2032e13,
  venus: 3.24859e14,
  earth: 3.986004418e14,
  moon: 4.902800118e12,
  mars: 4.282837e13,
  jupiter: 1.26686534e17,
  saturn: 3.7931187e16,
  uranus: 5.793939e15,
  neptune: 6.836529e15,
} as const;

/** Mean equatorial radii in metres (IAU 2015 nominal values for the planets). */
export const RADIUS = {
  sun: 6.957e8,
  mercury: 2.4397e6,
  venus: 6.0518e6,
  earth: 6.371e6,
  moon: 1.7374e6,
  mars: 3.3895e6,
  jupiter: 6.9911e7,
  saturn: 5.8232e7,
  uranus: 2.5362e7,
  neptune: 2.4622e7,
} as const;

/** Earth sidereal rotation rate in rad/s (2π / 86164.0905 s). */
export const EARTH_SIDEREAL_RATE = (2 * Math.PI) / 86164.0905;

/** Earth obliquity at J2000.0, radians (23° 26' 21.448"). */
export const OBLIQUITY_J2000 = (23 + 26 / 60 + 21.448 / 3600) * (Math.PI / 180);
