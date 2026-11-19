import { describe, expect, it } from 'vitest';
import {
  formatDistance,
  formatLightTime,
  summarizeTarget,
  SPEED_OF_LIGHT,
} from '../src/ui/targetView.js';
import { AU_M } from '../src/core/constants.js';
import { smallBodyById } from '../src/core/ephemeris/smallBodies.js';

const row = (summary: ReturnType<typeof summarizeTarget>, label: string) =>
  summary?.rows.find((r) => r.label === label)?.value;

describe('target summaries', () => {
  it('summarises a planet with distances, light time and radius', () => {
    const s = summarizeTarget('mars', {
      fromSun: 1.5 * AU_M,
      fromEarth: 0.5 * AU_M,
      jdTt: 2461000,
    });
    expect(s?.title).toBe('Mars');
    expect(row(s, 'Distance from Sun')).toBe('1.50000 AU');
    expect(row(s, 'Distance from Earth')).toBe('0.50000 AU');
    // 0.5 AU at the speed of light is 249.5 s.
    expect(row(s, 'Light time')).toBe('4 min 10 s');
    expect(row(s, 'Mean radius')).toBe('3,390 km');
    expect(s?.caveat).toBeNull();
  });

  it('does not report a distance of a body from itself', () => {
    expect(row(summarizeTarget('earth', { fromEarth: 0, jdTt: 0 }), 'Distance from Earth')).toBe(
      '--',
    );
    expect(row(summarizeTarget('sun', { fromSun: 0, jdTt: 0 }), 'Distance from Sun')).toBe('--');
  });

  it('summarises a small body with its orbit and an honest caveat about the element epoch', () => {
    const halley = smallBodyById('halley')!;
    const s = summarizeTarget('halley', { jdTt: halley.epochJdTdb + 40 * 365.25 });
    expect(s?.title).toBe('1P/Halley');
    expect(row(s, 'Type')).toBe('Comet');
    expect(row(s, 'Eccentricity')).toBe(halley.e.toFixed(4));
    expect(row(s, 'Period')).toMatch(/^7\d\.\d\d years$/);
    expect(s?.caveat).toMatch(/40 years before the date shown/);
    expect(s?.caveat).toMatch(/two-body/);
  });

  it('reports a short period in days', () => {
    expect(row(summarizeTarget('apophis', { jdTt: 2461000 }), 'Period')).toMatch(/^3\d\d days$/);
  });

  it('returns null for an unknown id', () => {
    expect(summarizeTarget('vulcan', { jdTt: 0 })).toBeNull();
  });
});

describe('formatting', () => {
  it('switches from km to AU at 0.01 AU', () => {
    expect(formatDistance(384_400_000)).toBe('384,400 km');
    expect(formatDistance(0.02 * AU_M)).toBe('0.02000 AU');
  });

  it('formats light time at each scale', () => {
    expect(formatLightTime(1.28)).toBe('1.28 s');
    expect(formatLightTime(AU_M / SPEED_OF_LIGHT)).toBe('8 min 19 s');
    expect(formatLightTime(4 * 3600 + 10 * 60)).toBe('4 h 10 min');
  });

  it('carries rounding into the next unit instead of printing 60', () => {
    expect(formatLightTime(299.7)).toBe('5 min 0 s');
    expect(formatLightTime(59.999)).toBe('1 min 0 s');
    expect(formatLightTime(3599.8)).toBe('1 h 0 min');
    expect(formatLightTime(7199)).toBe('2 h 0 min');
  });
});
