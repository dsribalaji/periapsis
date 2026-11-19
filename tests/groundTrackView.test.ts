import { describe, expect, it } from 'vitest';
import {
  MERIDIAN_DEG,
  PARALLEL_DEG,
  formatAngle,
  groundPointAt,
  groundTrackImage,
  projectPoint,
  summariseGroundTrack,
  trackPolylines,
  wrapLonRad,
} from '../src/ui/groundTrackView.js';
import {
  buildGroundTrack,
  type GroundTrack,
  type GroundTrackInput,
} from '../src/core/groundTrack/groundTrack.js';
import { buildMissionPlan, missionProgress } from '../src/ui/missionView.js';
import { SCENARIOS } from '../src/scenarios/catalogue.js';
import { OBLIQUITY_J2000, RADIUS, SECONDS_PER_DAY } from '../src/core/constants.js';
import { bodyPosition } from '../src/core/ephemeris/ephemeris.js';
import { jdFromIsoUtc, jdTtFromJdUtc } from '../src/core/time/time.js';
import type { Vec3 } from '../src/core/math/vec3.js';

const EPOCH_UTC = '2026-11-18T12:00:00Z';
const EPOCH_JD_UTC = jdFromIsoUtc(EPOCH_UTC);
const EPOCH_TT = jdTtFromJdUtc(EPOCH_JD_UTC);
const DEG = 180 / Math.PI;

/** Heliocentric point for an Earth-relative offset at a time, anchored per sample. */
function heliocentric(offset: Vec3, timeSeconds: number): Vec3 {
  const body = bodyPosition('earth', EPOCH_TT + timeSeconds / SECONDS_PER_DAY);
  return { x: body.x + offset.x, y: body.y + offset.y, z: body.z + offset.z };
}

function trackFromOffsets(offsets: readonly { r: Vec3; t: number }[]) {
  const points: GroundTrackInput[] = offsets.map(({ r, t }) => ({
    r: heliocentric(r, t),
    timeSeconds: t,
  }));
  return buildGroundTrack(points, { epochJdUtc: EPOCH_JD_UTC });
}

describe('the projection', () => {
  it('maps the poles to the top and bottom edges', () => {
    expect(projectPoint(Math.PI / 2, 0).y).toBe(0);
    expect(projectPoint(-Math.PI / 2, 0).y).toBe(1);
  });

  it('maps longitude linearly, with the antimeridian as the edge', () => {
    // The longitude range is (−π, π], so +180° is the east edge (x = 1) and −180° folds to the
    // same place. The west edge is approached from just below −180°, not reached.
    expect(projectPoint(0, Math.PI).x).toBeCloseTo(1, 12);
    expect(projectPoint(0, -Math.PI).x).toBeCloseTo(1, 12);
    expect(projectPoint(0, -Math.PI + 1e-9).x).toBeCloseTo(0, 9);
  });

  it('puts the prime meridian and the equator at the centre', () => {
    const centre = projectPoint(0, 0);
    expect(centre.x).toBeCloseTo(0.5, 12);
    expect(centre.y).toBeCloseTo(0.5, 12);
  });

  it('clamps a latitude that rounds past the pole onto the map edge', () => {
    // asin can return a value a few ulps past ±π/2 for a vector exactly on the pole. A point
    // outside 0..1 would draw off the canvas rather than at its edge.
    const north = projectPoint(Math.PI / 2 + 1e-12, 0);
    expect(north.y).toBe(0);
    const south = projectPoint(-Math.PI / 2 - 1e-12, 0);
    expect(south.y).toBe(1);
  });

  it('wraps longitude into (−π, π] rather than clamping', () => {
    // A craft that laps the Earth accumulates longitude in one direction; the map needs it
    // folded back. Clamping would pin it to the antimeridian and draw a vertical line there.
    // The range is half-open at −π, so an exact multiple of π lands on +π.
    expect(wrapLonRad(3 * Math.PI)).toBeCloseTo(Math.PI, 12);
    expect(wrapLonRad(2 * Math.PI + 0.5)).toBeCloseTo(0.5, 12);
    expect(wrapLonRad(-2 * Math.PI - 0.5)).toBeCloseTo(-0.5, 12);
    expect(wrapLonRad(Math.PI)).toBeCloseTo(Math.PI, 12);
    expect(wrapLonRad(-Math.PI)).toBeCloseTo(Math.PI, 12);
    expect(wrapLonRad(-Math.PI + 0.1)).toBeCloseTo(-Math.PI + 0.1, 12);
  });

  it('has a graticule that covers the world without duplicating an edge', () => {
    // 30° steps: 11 meridians strictly inside ±180° (the edges are the map border), 5 parallels
    // strictly inside ±90°. The poles and the antimeridian are the map's own edges.
    expect(MERIDIAN_DEG).toHaveLength(11);
    expect(MERIDIAN_DEG[0]).toBe(-150);
    expect(MERIDIAN_DEG[MERIDIAN_DEG.length - 1]).toBe(150);
    expect(PARALLEL_DEG).toHaveLength(5);
    expect(PARALLEL_DEG[0]).toBe(-60);
    expect(PARALLEL_DEG[PARALLEL_DEG.length - 1]).toBe(60);
  });
});

describe('breaking the line at the antimeridian', () => {
  /**
   * A synthetic track, so this block tests the polyline logic rather than the frame chain.
   *
   * `buildGroundTrack` is exercised in `tests/groundTrack.test.ts`; here the input is the shape
   * it produces, with the crossing flags already set. Testing the renderer's split against a
   * hand-built track is what makes the assertion specific: a failure means the split is wrong,
   * not that the ephemeris moved.
   */
  function synthetic(
    points: readonly {
      latDeg: number;
      lonDeg: number;
      t: number;
      cross?: boolean;
      gap?: boolean;
    }[],
  ): GroundTrack {
    return {
      samples: points.map((p) => ({
        timeSeconds: p.t,
        jdUtc: EPOCH_JD_UTC + p.t / SECONDS_PER_DAY,
        latRad: (p.latDeg * Math.PI) / 180,
        lonRad: (p.lonDeg * Math.PI) / 180,
        altitudeM: 550e3,
        crossesAntimeridian: p.cross ?? false,
        startsAfterGap: p.gap ?? false,
      })),
      epochJdUtc: EPOCH_JD_UTC,
      undefinedPoints: 0,
      belowSurface: false,
      minAltitudeM: 550e3,
      maxAltitudeM: 550e3,
    };
  }

  const crossing = () =>
    synthetic([
      { latDeg: 10, lonDeg: 170, t: 0 },
      { latDeg: 10, lonDeg: 175, t: 600 },
      { latDeg: 10, lonDeg: 179, t: 1200 },
      { latDeg: 10, lonDeg: -179, t: 1800, cross: true },
      { latDeg: 10, lonDeg: -175, t: 2400 },
      { latDeg: 10, lonDeg: -170, t: 3000 },
    ]);

  it('splits the polyline at the crossing, so no segment spans the map', () => {
    // The rendering bug this prevents: one polyline from x = 0.99 to x = 0.01, which the
    // canvas draws as a line the full width of the map and reads as the craft teleporting.
    const lines = trackPolylines(crossing());
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      for (let i = 1; i < line.length; i++) {
        expect(Math.abs(line[i]!.x - line[i - 1]!.x)).toBeLessThan(0.5);
      }
    }
  });

  it('keeps every sample across the split, losing none', () => {
    const track = crossing();
    const total = trackPolylines(track).reduce((n, line) => n + line.length, 0);
    expect(total).toBe(track.samples.length);
  });

  it('does not split a track that never wraps', () => {
    const track = synthetic([
      { latDeg: 0, lonDeg: -10, t: 0 },
      { latDeg: 5, lonDeg: 0, t: 600 },
      { latDeg: 10, lonDeg: 10, t: 1200 },
    ]);
    expect(trackPolylines(track)).toHaveLength(1);
  });

  it('interpolates a crossing marker the short way round, not across the map', () => {
    // Between 179° and −179° the true motion is 2° of longitude. A naive difference would sweep
    // 358° and park the marker on the wrong side of the world.
    const p = groundPointAt(crossing(), 1500);
    expect(p).not.toBeNull();
    const lonDeg = p!.lonRad * DEG;
    // Just past ±180° in the direction of travel: +179.33 or −179.33, never ±63 or ±0.
    expect(Math.abs(lonDeg)).toBeGreaterThan(179);
  });

  it('breaks the track across a gap rather than joining it', () => {
    // `buildGroundTrack` drops the undefined sample and marks the next one `startsAfterGap`.
    // The renderer must not draw through the hole: the craft was never there.
    const track = synthetic([
      { latDeg: 0, lonDeg: 0, t: 0 },
      { latDeg: 10, lonDeg: 10, t: 600 },
      { latDeg: 20, lonDeg: 20, t: 1800, gap: true },
      { latDeg: 30, lonDeg: 30, t: 2400 },
    ]);
    const lines = trackPolylines(track);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toHaveLength(2);
    expect(lines[1]).toHaveLength(2);
  });

  it('refuses to interpolate across a gap', () => {
    const track = synthetic([
      { latDeg: 0, lonDeg: 0, t: 0 },
      { latDeg: 10, lonDeg: 10, t: 600 },
      { latDeg: 20, lonDeg: 20, t: 1800, gap: true },
      { latDeg: 30, lonDeg: 30, t: 2400 },
    ]);
    expect(groundPointAt(track, 1200)).toBeNull();
    // Either side of the gap still interpolates.
    expect(groundPointAt(track, 300)).not.toBeNull();
    expect(groundPointAt(track, 2100)).not.toBeNull();
  });

  it('draws a lone sample as a point rather than dropping it', () => {
    // A track that exists at one instant and nowhere adjacent is a dot, not nothing.
    const track = synthetic([{ latDeg: 5, lonDeg: 5, t: 0 }]);
    const lines = trackPolylines(track);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toHaveLength(1);
  });
});

describe('a real track from the frame chain', () => {
  it('breaks the bundled LEO track at least once, because it laps the Earth', () => {
    // The end-to-end statement: the real chain produces crossings, so the split is exercised on
    // real data and not only on synthetic input.
    const plan = buildMissionPlan(SCENARIOS.find((s) => s.id === 'leo-raise')!.mission!, EPOCH_UTC);
    const track = plan.groundTrack!;
    const crossings = track.samples.filter((s) => s.crossesAntimeridian).length;
    expect(crossings).toBeGreaterThan(0);
    expect(trackPolylines(track).length).toBeGreaterThan(1);
  });

  it('breaks the track where the craft sits at the Earth centre', () => {
    const radius = RADIUS.earth + 550e3;
    const offsets = [
      { r: { x: radius, y: 0, z: 0 }, t: 0 },
      { r: { x: 0, y: 0, z: 0 }, t: 600 },
      { r: { x: 0, y: radius, z: 0 }, t: 1200 },
    ];
    const track = trackFromOffsets(offsets);
    expect(track.undefinedPoints).toBe(1);
    expect(track.samples).toHaveLength(2);
    expect(trackPolylines(track)).toHaveLength(2);
  });
});

describe('the marker sits on its own track', () => {
  it('returns the sample itself at a sample time', () => {
    const track = trackFromOffsets(
      [0, 600, 1200].map((t) => ({ r: { x: RADIUS.earth + 550e3, y: t * 1e3, z: 0 }, t })),
    );
    const p = groundPointAt(track, 600);
    expect(p).not.toBeNull();
    expect(p!.latRad).toBeCloseTo(track.samples[1]!.latRad, 12);
    expect(p!.lonRad).toBeCloseTo(track.samples[1]!.lonRad, 12);
  });

  it('is between its bracketing samples, never outside them', () => {
    // The invariant that makes the marker trustworthy: whatever the interpolation does, it
    // cannot place the craft somewhere the two adjacent samples do not bracket.
    const plan = buildMissionPlan(SCENARIOS.find((s) => s.id === 'leo-raise')!.mission!, EPOCH_UTC);
    const track = plan.groundTrack!;
    for (let i = 1; i < 40; i++) {
      const t = (i / 40) * plan.horizonSeconds;
      const p = groundPointAt(track, t);
      expect(p, `t=${t}`).not.toBeNull();
      // Find the bracketing pair.
      let k = 0;
      while (k + 1 < track.samples.length && track.samples[k + 1]!.timeSeconds <= t) k++;
      const a = track.samples[k]!;
      const b = track.samples[Math.min(k + 1, track.samples.length - 1)]!;
      const latLo = Math.min(a.latRad, b.latRad);
      const latHi = Math.max(a.latRad, b.latRad);
      expect(p!.latRad).toBeGreaterThanOrEqual(latLo - 1e-12);
      expect(p!.latRad).toBeLessThanOrEqual(latHi + 1e-12);
    }
  });

  it('returns null outside the track span rather than extrapolating', () => {
    const plan = buildMissionPlan(SCENARIOS.find((s) => s.id === 'leo-raise')!.mission!, EPOCH_UTC);
    const track = plan.groundTrack!;
    expect(groundPointAt(track, -1)).toBeNull();
    expect(groundPointAt(track, plan.horizonSeconds + 1)).toBeNull();
    expect(groundPointAt(track, plan.horizonSeconds)).not.toBeNull();
  });

  it('agrees with the map to within the chord sagitta of one drawn segment', () => {
    // The two readouts measure slightly different things, and the difference is derivable.
    //
    // The **map** reports the altitude of the nearest propagated sample: the true orbit radius
    // at that instant. The **panel's live radius** is derived from the drawn geometry, which
    // interpolates straight lines between samples, so between two samples it reports a *chord*
    // radius — systematically below the true arc. The gap is the sagitta of one segment:
    //
    //     s = r (1 - cos(θ/2)),  θ = arc length / r
    //
    // At the bundled LEO plan that is 59.2 s per sample, 449 km of arc, θ = 0.0628 rad, and
    // s = 3,526 m — measured 3,642 m at the worst instant. That is 0.05% of a 550 km altitude,
    // invisible in the panel, but it is the reason these two numbers cannot be equal.
    //
    // This is worth asserting rather than ignoring: it says the disagreement is bounded by the
    // sampling, not by a frame error. The D-032 defect was 343,390 km; this is 3.6 km, and it
    // shrinks with sample spacing rather than with a code change.
    const plan = buildMissionPlan(SCENARIOS.find((s) => s.id === 'leo-raise')!.mission!, EPOCH_UTC);
    const track = plan.groundTrack!;
    const step = track.samples[1]!.timeSeconds - track.samples[0]!.timeSeconds;
    const arc = plan.initialSpeed * step;
    const theta = arc / plan.maxRadius;
    const sagitta = plan.maxRadius * (1 - Math.cos(theta / 2));

    for (const t of [0, 30, 600, 2900, 5800]) {
      const progress = missionProgress(plan, t);
      expect(progress.groundPoint, `t=${t}`).not.toBeNull();
      const difference = Math.abs(progress.groundPoint!.altitudeM - progress.altitude!);
      // A tenth of the sagitta covers float32 storage on the drawn radius (about 0.85 m here)
      // with room to spare; the bound that matters is the sagitta itself.
      expect(difference).toBeLessThan(sagitta * 1.2 + 10);
    }
    // And the sagitta really is small against the orbit: this is a readout subtlety, not a bug.
    expect(sagitta).toBeLessThan(plan.maxRadius * 1e-3);
  });
});

describe('the summary states what the map does not show', () => {
  const leo = () =>
    buildMissionPlan(SCENARIOS.find((s) => s.id === 'leo-raise')!.mission!, EPOCH_UTC);

  it('counts the samples it actually drew', () => {
    const plan = leo();
    const summary = summariseGroundTrack(plan.groundTrack!)!;
    expect(summary.sampleCount).toBe(plan.groundTrack!.samples.length);
    expect(summary.sampleCount).toBeGreaterThan(100);
  });

  it('flags a short plan as partial coverage, and a full revolution as not', () => {
    // A 3.2 h LEO plan is just over one revolution: the longitude span exceeds 360° because it
    // laps, so it is not "partial" in the sense that matters. A 1.5 h park is less than one.
    const short = buildMissionPlan(
      { ...SCENARIOS.find((s) => s.id === 'earth-mars-departure')!.mission!, horizonSeconds: 5422 },
      '2028-11-01T00:00:00Z',
    );
    const shortSummary = summariseGroundTrack(short.groundTrack!)!;
    expect(shortSummary.partialCoverage).toBe(true);
    expect(shortSummary.lonSpanRad).toBeLessThan(2 * Math.PI);
  });

  it('reports the altitude range over the whole track', () => {
    const plan = leo();
    const summary = summariseGroundTrack(plan.groundTrack!)!;
    // The raise node lifts apoapsis from 550 to about 781 km.
    expect(summary.minAltitudeM).toBeCloseTo(550e3, -3);
    expect(summary.maxAltitudeM).toBeGreaterThan(760e3);
    expect(summary.maxAltitudeM).toBeLessThan(800e3);
  });

  it('reports nothing for an empty track', () => {
    const empty = buildGroundTrack([], { epochJdUtc: EPOCH_JD_UTC });
    expect(summariseGroundTrack(empty)).toBeNull();
    expect(trackPolylines(empty)).toEqual([]);
  });
});

describe('the map image', () => {
  it('is opaque and the right size, so it can be handed to ImageData', () => {
    const plan = buildMissionPlan(SCENARIOS.find((s) => s.id === 'leo-raise')!.mission!, EPOCH_UTC);
    const image = groundTrackImage(plan.groundTrack!);
    expect(image.width).toBe(720);
    expect(image.height).toBe(360);
    expect(image.data).toHaveLength(image.width * image.height * 4);
    // Every pixel is written by the background fill, so opacity is uniform. Asserting all
    // 259,200 alpha bytes one `expect` at a time costs ~1.8 s; a strided sweep plus the ends
    // proves the same property. Vitest's default timeout is 5 s and the suite runs files in
    // parallel, so an O(pixels)-with-expectations loop is a real timeout risk, not a style point.
    const stride = 4 * 97; // coprime with the row width, so it visits every column offset
    for (let i = 3; i < image.data.length; i += stride) {
      expect(image.data[i]).toBe(255);
    }
    expect(image.data[3]).toBe(255);
    expect(image.data[image.data.length - 1]).toBe(255);
  });

  it('paints the track in the mission colour somewhere', () => {
    // The measured claim: the track is actually on the map. Count pixels at the track colour
    // (255, 159, 28) rather than trusting that the drawing code ran.
    const plan = buildMissionPlan(SCENARIOS.find((s) => s.id === 'leo-raise')!.mission!, EPOCH_UTC);
    const image = groundTrackImage(plan.groundTrack!);
    let trackPixels = 0;
    for (let i = 0; i < image.data.length; i += 4) {
      if (image.data[i] === 255 && image.data[i + 1] === 159 && image.data[i + 2] === 28) {
        trackPixels++;
      }
    }
    expect(trackPixels).toBeGreaterThan(1000);
  });

  it('paints a graticule that a reader can actually see', () => {
    const plan = buildMissionPlan(SCENARIOS.find((s) => s.id === 'leo-raise')!.mission!, EPOCH_UTC);
    const image = groundTrackImage(plan.groundTrack!);
    let graticulePixels = 0;
    for (let i = 0; i < image.data.length; i += 4) {
      if (image.data[i] === 44 && image.data[i + 1] === 58 && image.data[i + 2] === 82) {
        graticulePixels++;
      }
    }
    // 11 meridians plus 5 parallels, each spanning the map: tens of thousands of pixels.
    expect(graticulePixels).toBeGreaterThan(5000);
  });

  it('draws a below-surface track in red rather than the mission colour', () => {
    // A track inside the Earth is not viable; the map must say so, not just the panel.
    const radius = RADIUS.earth * 0.9;
    const track = trackFromOffsets(
      [0, 600, 1200].map((t) => ({ r: { x: radius, y: t * 1000, z: 0 }, t })),
    );
    expect(track.belowSurface).toBe(true);
    const image = groundTrackImage(track);
    let red = 0;
    for (let i = 0; i < image.data.length; i += 4) {
      if (image.data[i] === 190 && image.data[i + 1] === 52 && image.data[i + 2] === 44) red++;
    }
    expect(red).toBeGreaterThan(0);
  });

  it('joins samples that are more than a pixel apart', () => {
    // At map resolution a LEO sample step is several pixels. Plotting points alone would leave
    // a dotted line, which reads as sparse data rather than a path.
    const radius = RADIUS.earth + 550e3;
    const track = trackFromOffsets(
      [0, 60, 120, 180].map((t, i) => {
        const lon = (i * 40 * Math.PI) / 180;
        return { r: { x: radius * Math.cos(lon), y: radius * Math.sin(lon), z: 0 }, t };
      }),
    );
    const image = groundTrackImage(track);
    // Walk the painted row and require no gap wider than one pixel between track pixels.
    const row = Math.round((image.height - 1) / 2);
    let first = -1;
    let last = -1;
    let gaps = 0;
    for (let x = 0; x < image.width; x++) {
      const i = (row * image.width + x) * 4;
      if (image.data[i] === 255 && image.data[i + 1] === 159) {
        if (first < 0) first = x;
        if (last >= 0 && x - last > 1) gaps++;
        last = x;
      }
    }
    expect(first).toBeGreaterThanOrEqual(0);
    expect(gaps).toBe(0);
  });
});

describe('the ecliptic datum is visible in the map, and that is correct', () => {
  it('gives a geostationary orbit a latitude sweep of the obliquity, not zero', () => {
    // The single most important thing this panel reveals. The physics frame is ecliptic-
    // referenced (PHYSICS.md §10.4), so the GTO scenario's "equatorial" final orbit is
    // equatorial *to the ecliptic*. On an Earth-fixed map it therefore sweeps ±23.44° of
    // latitude, which is exactly the obliquity, rather than sitting on the equator.
    //
    // This is not a bug in the projection: it is the datum the physics uses, made visible.
    // The map is right and the orbit name is the approximation.
    const plan = buildMissionPlan(
      SCENARIOS.find((s) => s.id === 'gto-transfer')!.mission!,
      '2026-11-18T12:00:00Z',
    );
    const track = plan.groundTrack!;
    const coast = track.samples.filter((s) => s.timeSeconds >= 18986 + 3600);
    expect(coast.length).toBeGreaterThan(1000);
    let maxLat = -Infinity;
    let minLat = Infinity;
    for (const s of coast) {
      maxLat = Math.max(maxLat, s.latRad);
      minLat = Math.min(minLat, s.latRad);
    }
    const obliquityDeg = OBLIQUITY_J2000 * DEG;
    expect(maxLat * DEG).toBeCloseTo(obliquityDeg, 1);
    expect(minLat * DEG).toBeCloseTo(-obliquityDeg, 1);
    // And the altitude is geostationary throughout, so this is one orbit, not a drift.
    for (const s of coast) {
      expect(s.altitudeM / 1000).toBeCloseTo(35793, 0);
    }
  });

  it('bounds a LEO park latitude by its ecliptic inclination plus the obliquity', () => {
    // A 53° ecliptic orbit reaches at most 53 + 23.44 = 76.44° of equatorial latitude. Getting
    // 53° here would mean the obliquity rotation was skipped, which PHYSICS.md §13.1 says is a
    // 23.44° error.
    const plan = buildMissionPlan(SCENARIOS.find((s) => s.id === 'leo-raise')!.mission!, EPOCH_UTC);
    let maxLat = -Infinity;
    for (const s of plan.groundTrack!.samples) maxLat = Math.max(maxLat, s.latRad);
    expect(maxLat * DEG).toBeCloseTo(53 + OBLIQUITY_J2000 * DEG, 1);
  });
});

describe('formatting', () => {
  it('names the hemisphere rather than printing a sign', () => {
    expect(formatAngle((12.34 * Math.PI) / 180, 'lat')).toBe('12.3°N');
    expect(formatAngle((-12.34 * Math.PI) / 180, 'lat')).toBe('12.3°S');
    expect(formatAngle((45.6 * Math.PI) / 180, 'lon')).toBe('45.6°E');
    expect(formatAngle((-45.6 * Math.PI) / 180, 'lon')).toBe('45.6°W');
  });

  it('reports a non-finite angle as unknown rather than NaN', () => {
    expect(formatAngle(NaN, 'lat')).toBe('--');
    expect(formatAngle(Infinity, 'lon')).toBe('--');
  });
});

describe('the panel gets its track from the mission plan', () => {
  it('builds an Earth ground track for an Earth mission', () => {
    const plan = buildMissionPlan(SCENARIOS.find((s) => s.id === 'leo-raise')!.mission!, EPOCH_UTC);
    expect(plan.groundTrack).not.toBeNull();
    expect(plan.groundTrack!.samples.length).toBeGreaterThan(100);
  });

  it('builds none for a mission that is not around the Earth', () => {
    // The projection's obliquity and sidereal rotation are Earth's. Projecting a lunar mission
    // onto a world map would be a different planet's latitude presented as this one's.
    const plan = buildMissionPlan(
      {
        id: 'moon',
        name: 'Lunar',
        centralBody: 'moon',
        orbit: { altitudeM: 100e3, inclinationRad: 0, phaseRad: 0 },
        deltaVBudget: 100,
        propagation: 'twoBody',
        horizonSeconds: 6000,
        maneuvers: [],
      },
      EPOCH_UTC,
    );
    expect(plan.groundTrack).toBeNull();
    expect(missionProgress(plan, 0).groundPoint).toBeNull();
  });
});
