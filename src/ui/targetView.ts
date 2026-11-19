/**
 * What the "Selected" panel says about a target: a planet, the Moon, the Sun or a small body.
 *
 * Pure, so the wording and the numbers are tested directly rather than through the DOM. The
 * panel only renders the rows this returns.
 */

import { AU_M } from '../core/constants.js';
import { BODIES, type BodyId } from '../core/ephemeris/solarSystem.js';
import {
  apsidesAu,
  epochAgeYears,
  smallBodyById,
  smallBodyPeriodDays,
  type SmallBodyKind,
} from '../core/ephemeris/smallBodies.js';
import { isoUtcFromJd, jdUtcFromJdTt } from '../core/time/time.js';
import { BODY_DISPLAY } from './bodyDisplay.js';

/** Metres per second. */
export const SPEED_OF_LIGHT = 299_792_458;

export interface TargetRow {
  readonly label: string;
  readonly value: string;
  readonly testid?: string;
}

export interface TargetSummary {
  readonly title: string;
  readonly color: string;
  readonly rows: readonly TargetRow[];
  /** A sentence about the limits of the numbers above, or null. */
  readonly caveat: string | null;
}

export interface TargetMeasurements {
  /** Distance from the Sun, metres, if known. */
  readonly fromSun?: number;
  /** Distance from Earth's centre, metres, if known. */
  readonly fromEarth?: number;
  /** Current TT Julian date. */
  readonly jdTt: number;
}

/** Colour of each small-body kind, matching the 3D markers. */
export const SMALL_BODY_SWATCH: Record<SmallBodyKind, string> = {
  dwarf: '#d9c7b0',
  asteroid: '#a4adb8',
  comet: '#8fd6ff',
};

export const SMALL_BODY_KIND_LABEL: Record<SmallBodyKind, string> = {
  dwarf: 'Dwarf planet',
  asteroid: 'Asteroid',
  comet: 'Comet',
};

/** A distance in km below 0.01 AU, in AU above. */
export function formatDistance(m: number): string {
  if (m < 0.01 * AU_M) {
    return `${(m / 1000).toLocaleString('en-US', { maximumFractionDigits: 0 })} km`;
  }
  return `${(m / AU_M).toFixed(5)} AU`;
}

/** One-way light time as seconds, or minutes and seconds, or hours and minutes. */
export function formatLightTime(seconds: number): string {
  if (seconds < 59.995) return `${seconds.toFixed(2)} s`;
  // Round the total before splitting it, or 299.7 s comes out as "4 min 60 s".
  const s = Math.round(seconds);
  if (s < 3600) return `${Math.floor(s / 60)} min ${s % 60} s`;
  const m = Math.round(seconds / 60);
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

const km = (m: number) => `${(m / 1000).toLocaleString('en-US', { maximumFractionDigits: 0 })} km`;

function distanceRows(id: string, m: TargetMeasurements): TargetRow[] {
  const rows: TargetRow[] = [];
  rows.push({
    label: 'Distance from Sun',
    value: m.fromSun === undefined || id === 'sun' ? '--' : `${(m.fromSun / AU_M).toFixed(5)} AU`,
  });
  const fromEarth = m.fromEarth === undefined || id === 'earth' ? undefined : m.fromEarth;
  rows.push({
    label: 'Distance from Earth',
    value: fromEarth === undefined ? '--' : formatDistance(fromEarth),
    testid: 'selected-from-earth',
  });
  rows.push({
    label: 'Light time',
    value: fromEarth === undefined ? '--' : formatLightTime(fromEarth / SPEED_OF_LIGHT),
  });
  return rows;
}

/** Summarises any selectable target, or returns null for an unknown id. */
export function summarizeTarget(id: string, m: TargetMeasurements): TargetSummary | null {
  if (id in BODIES) {
    const body = BODIES[id as BodyId];
    const display = BODY_DISPLAY.find((b) => b.id === id);
    return {
      title: display?.label ?? body.name,
      color: display?.color ?? '#dbe3ee',
      rows: [...distanceRows(id, m), { label: 'Mean radius', value: km(body.radius) }],
      caveat: null,
    };
  }

  const sb = smallBodyById(id);
  if (!sb) return null;
  const { q, Q } = apsidesAu(sb);
  const periodYears = smallBodyPeriodDays(sb) / 365.25;
  const age = epochAgeYears(sb, m.jdTt);
  const epochDate = isoUtcFromJd(jdUtcFromJdTt(sb.epochJdTdb)).slice(0, 10);
  const ageText =
    Math.abs(age) < 1
      ? 'within a year of the date shown'
      : `${Math.abs(age).toFixed(0)} years ${age > 0 ? 'before' : 'after'} the date shown`;

  return {
    title: sb.name,
    color: SMALL_BODY_SWATCH[sb.kind],
    rows: [
      { label: 'Type', value: SMALL_BODY_KIND_LABEL[sb.kind] },
      { label: 'Designation', value: sb.designation },
      ...distanceRows(id, m),
      {
        label: 'Diameter',
        value:
          sb.diameterKm === null
            ? 'unknown'
            : `${sb.diameterKm.toLocaleString('en-US', { maximumFractionDigits: 1 })} km`,
      },
      { label: 'Semi-major axis', value: `${sb.a.toFixed(3)} AU` },
      { label: 'Eccentricity', value: sb.e.toFixed(4) },
      { label: 'Inclination', value: `${sb.i.toFixed(2)}°` },
      { label: 'Perihelion', value: `${q.toFixed(3)} AU` },
      { label: 'Aphelion', value: `${Q.toFixed(3)} AU` },
      {
        label: 'Period',
        value:
          periodYears < 2
            ? `${(periodYears * 365.25).toFixed(0)} days`
            : `${periodYears.toFixed(2)} years`,
      },
    ],
    caveat:
      `Orbit from NASA/JPL's Small-Body Database, osculating at ${epochDate} (${ageText}). ` +
      'It is propagated as a pure two-body orbit, so it drifts with time from that date as the ' +
      'planets, Jupiter above all, perturb the real one.',
  };
}
