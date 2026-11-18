/**
 * Built-in solar system: mean Keplerian elements and their secular rates.
 *
 * SOURCE: JPL Solar System Dynamics, "Approximate Positions of the Planets",
 * https://ssd.jpl.nasa.gov/planets/approx_pos.html — Table 1, "Keplerian elements and
 * their rates, with respect to the mean ecliptic and equinox of J2000, valid for the
 * time-interval 1800 AD - 2050 AD". Retrieved 2026-11-18, transcribed verbatim.
 *
 * These are APPROXIMATE MEAN ELEMENTS, not an ephemeris. JPL's own stated accuracy for
 * this formulation over 1800-2050 AD (heliocentric longitude / latitude / range):
 *   Mercury 15" / 1" / 1e3 km      Venus   20" / 1" / 4e3 km
 *   EM Bary 20" / 8" / 6e3 km      Mars    40" / 2" / 25e3 km
 *   Jupiter 400" / 10" / 600e3 km  Saturn  600" / 25" / 1500e3 km
 *   Uranus  50" / 2" / 1000e3 km   Neptune 10" / 1" / 200e3 km
 * Mars' 25,000 km range error is the largest, roughly 1.7e-4 AU; this matters for
 * interplanetary transfer design and is why PHYSICS.md warns that computed transfer
 * delta-v is indicative, not operational.
 *
 * The Moon is NOT in JPL Table 1. It uses a separate mean-element model documented in
 * ephemeris.ts (see ADR-0007) with an accuracy of about 0.5 deg in longitude.
 */

import { AU_M, GM, RADIUS } from '../constants.js';

/**
 * One body's elements. Angles are degrees at the J2000.0 epoch, with rates in
 * degrees per Julian century, except `a` (AU, AU/century) and `e` (dimensionless).
 * `L` is the mean longitude, `varpi` the longitude of perihelion, `node` the longitude
 * of the ascending node — exactly JPL's column meanings.
 */
export interface MeanElements {
  readonly a: number;
  readonly aDot: number;
  readonly e: number;
  readonly eDot: number;
  /** Inclination to the mean ecliptic of J2000, degrees. */
  readonly i: number;
  readonly iDot: number;
  /** Mean longitude, degrees. */
  readonly L: number;
  readonly LDot: number;
  /** Longitude of perihelion (ω + Ω), degrees. */
  readonly varpi: number;
  readonly varpiDot: number;
  /** Longitude of the ascending node, degrees. */
  readonly node: number;
  readonly nodeDot: number;
}

export type BodyId =
  | 'sun'
  | 'mercury'
  | 'venus'
  | 'earth'
  | 'moon'
  | 'mars'
  | 'jupiter'
  | 'saturn'
  | 'uranus'
  | 'neptune';

export interface BodyDefinition {
  readonly id: BodyId;
  readonly name: string;
  /** Gravitational parameter, m³/s². */
  readonly mu: number;
  /** Mean radius, m. */
  readonly radius: number;
  /** The body this one orbits, or null for the Sun. */
  readonly parent: BodyId | null;
  readonly elements: MeanElements | null;
  /** Display colour, chosen for legibility on the dark theme, roughly planet-like. */
  readonly color: number;
}

const el = (
  a: number,
  aDot: number,
  e: number,
  eDot: number,
  i: number,
  iDot: number,
  L: number,
  LDot: number,
  varpi: number,
  varpiDot: number,
  node: number,
  nodeDot: number,
): MeanElements => ({
  a,
  aDot,
  e,
  eDot,
  i,
  iDot,
  L,
  LDot,
  varpi,
  varpiDot,
  node,
  nodeDot,
});

/** JPL Table 1, transcribed verbatim. Order of arguments: a, ȧ, e, ė, I, İ, L, L̇, ϖ, ϖ̇, Ω, Ω̇. */
export const JPL_TABLE_1: Record<Exclude<BodyId, 'sun' | 'moon'>, MeanElements> = {
  mercury: el(
    0.38709927,
    0.00000037,
    0.20563593,
    0.00001906,
    7.00497902,
    -0.00594749,
    252.2503235,
    149472.67411175,
    77.45779628,
    0.16047689,
    48.33076593,
    -0.12534081,
  ),
  venus: el(
    0.72333566,
    0.0000039,
    0.00677672,
    -0.00004107,
    3.39467605,
    -0.0007889,
    181.9790995,
    58517.81538729,
    131.60246718,
    0.00268329,
    76.67984255,
    -0.27769418,
  ),
  earth: el(
    1.00000261,
    0.00000562,
    0.01671123,
    -0.00004392,
    -0.00001531,
    -0.01294668,
    100.46457166,
    35999.37244981,
    102.93768193,
    0.32327364,
    0.0,
    0.0,
  ),
  mars: el(
    1.52371034,
    0.00001847,
    0.0933941,
    0.00007882,
    1.84969142,
    -0.00813131,
    -4.55343205,
    19140.30268499,
    -23.94362959,
    0.44441088,
    49.55953891,
    -0.29257343,
  ),
  jupiter: el(
    5.202887,
    -0.00011607,
    0.04838624,
    -0.00013253,
    1.30439695,
    -0.00183714,
    34.39644051,
    3034.74612775,
    14.72847983,
    0.21252668,
    100.47390909,
    0.20469106,
  ),
  saturn: el(
    9.53667594,
    -0.0012506,
    0.05386179,
    -0.00050991,
    2.48599187,
    0.00193609,
    49.95424423,
    1222.49362201,
    92.59887831,
    -0.41897216,
    113.66242448,
    -0.28867794,
  ),
  uranus: el(
    19.18916464,
    -0.00196176,
    0.04725744,
    -0.00004397,
    0.77263783,
    -0.00242939,
    313.23810451,
    428.48202785,
    170.9542763,
    0.40805281,
    74.01692503,
    0.04240589,
  ),
  neptune: el(
    30.06992276,
    0.00026291,
    0.00859048,
    0.00005105,
    1.77004347,
    0.00035372,
    -55.12002969,
    218.45945325,
    44.96476227,
    -0.32241464,
    131.78422574,
    -0.00508664,
  ),
};

/**
 * Earth's mean orbit, split into an explicit Earth rather than JPL's Earth-Moon
 * barycentre, so a spacecraft can be Earth-centred. The offset from the barycentre
 * (up to ~4700 km) is not modelled; see ADR-0007.
 */
export const MOON_ELEMENTS: MeanElements = el(
  // 384,400 km mean distance, expressed in AU.
  384400e3 / AU_M,
  0,
  0.0549,
  0,
  5.145,
  0,
  // Mean longitude at J2000. The Moon's mean longitude is 218.316 deg.
  218.316,
  481267.881,
  // Longitude of perigee at J2000 is 83.353 deg; it precesses at 40.69 deg/yr
  // = +8.85 deg/yr eastward, i.e. 4069 deg/century.
  83.353,
  4069.0137,
  // Longitude of the ascending node at J2000 is 125.045 deg; it regresses at
  // -19.34 deg/yr = -1934.14 deg/century.
  125.045,
  -1934.1362,
);

export const BODIES: Readonly<Record<BodyId, BodyDefinition>> = {
  sun: {
    id: 'sun',
    name: 'Sun',
    mu: GM.sun,
    radius: RADIUS.sun,
    parent: null,
    elements: null,
    color: 0xffd24a,
  },
  mercury: {
    id: 'mercury',
    name: 'Mercury',
    mu: GM.mercury,
    radius: RADIUS.mercury,
    parent: 'sun',
    elements: JPL_TABLE_1.mercury,
    color: 0x9c8b7a,
  },
  venus: {
    id: 'venus',
    name: 'Venus',
    mu: GM.venus,
    radius: RADIUS.venus,
    parent: 'sun',
    elements: JPL_TABLE_1.venus,
    color: 0xe4cf9a,
  },
  earth: {
    id: 'earth',
    name: 'Earth',
    mu: GM.earth,
    radius: RADIUS.earth,
    parent: 'sun',
    elements: JPL_TABLE_1.earth,
    color: 0x4a8fe0,
  },
  moon: {
    id: 'moon',
    name: 'Moon',
    mu: GM.moon,
    radius: RADIUS.moon,
    parent: 'earth',
    elements: MOON_ELEMENTS,
    color: 0xb9bcc4,
  },
  mars: {
    id: 'mars',
    name: 'Mars',
    mu: GM.mars,
    radius: RADIUS.mars,
    parent: 'sun',
    elements: JPL_TABLE_1.mars,
    color: 0xd1603d,
  },
  jupiter: {
    id: 'jupiter',
    name: 'Jupiter',
    mu: GM.jupiter,
    radius: RADIUS.jupiter,
    parent: 'sun',
    elements: JPL_TABLE_1.jupiter,
    color: 0xc9a578,
  },
  saturn: {
    id: 'saturn',
    name: 'Saturn',
    mu: GM.saturn,
    radius: RADIUS.saturn,
    parent: 'sun',
    elements: JPL_TABLE_1.saturn,
    color: 0xdcc98a,
  },
  uranus: {
    id: 'uranus',
    name: 'Uranus',
    mu: GM.uranus,
    radius: RADIUS.uranus,
    parent: 'sun',
    elements: JPL_TABLE_1.uranus,
    color: 0x8fd3d8,
  },
  neptune: {
    id: 'neptune',
    name: 'Neptune',
    mu: GM.neptune,
    radius: RADIUS.neptune,
    parent: 'sun',
    elements: JPL_TABLE_1.neptune,
    color: 0x5b7fd4,
  },
} as const;

/** Every body id, Sun first, in orbital order. */
export const BODY_IDS: readonly BodyId[] = [
  'sun',
  'mercury',
  'venus',
  'earth',
  'moon',
  'mars',
  'jupiter',
  'saturn',
  'uranus',
  'neptune',
];

/**
 * Sphere-of-influence (Laplace) radius in metres: r_soi = a (m/M)^(2/5).
 * The Sun's own value is taken as its Hill-sphere-like scale, returned as Infinity so
 * that interplanetary space belongs to the Sun. Values are computed from the elements
 * at the J2000 epoch; see PHYSICS.md §7.
 */
export function sphereOfInfluence(id: BodyId): number {
  const body = BODIES[id];
  if (!body.elements || !body.parent) return Infinity;
  const parent = BODIES[body.parent];
  const a = body.elements.a * AU_M;
  return a * Math.pow(body.mu / parent.mu, 0.4);
}
