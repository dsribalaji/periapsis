/**
 * Ground-track panel: a 2D equirectangular map with a graticule and the sub-satellite track.
 *
 * Presentational only. The projection, the antimeridian breaks and the summary all arrive from
 * `groundTrackView.ts`, which is pure and unit tested; this file owns the canvas, the one
 * `putImageData`, and the readouts. The split is the same one the porkchop panel uses, for the
 * same reason: a line-coverage number on a canvas proves lines ran, not that anything was
 * drawn, so the geometry is asserted directly and the canvas is asserted by reading it back.
 *
 * The map is a graticule with no coastlines (D-004). That is a documented limitation, not an
 * oversight, and the panel says so in place rather than only in the docs — a world map without
 * continents invites a reader to assume a coastline is missing rather than deliberately absent.
 */

import { useEffect, useMemo, useRef } from 'react';
import { RADIUS } from '../core/constants.js';
import {
  formatAngle,
  groundTrackImage,
  projectPoint,
  summariseGroundTrack,
  type GroundPoint,
} from './groundTrackView.js';
import type { GroundTrack } from '../core/groundTrack/groundTrack.js';

export interface GroundTrackPanelProps {
  readonly track: GroundTrack | null;
  /** Where the craft is now, in the same geocentric frame as the track. Null when undefined. */
  readonly current: GroundPoint | null;
  readonly testid?: string;
}

export function GroundTrackPanel({
  track,
  current,
  testid,
}: GroundTrackPanelProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const summary = useMemo(() => (track ? summariseGroundTrack(track) : null), [track]);

  // Paint whenever the track changes. Built at map resolution and stretched by CSS, so the
  // drawing code is a single `putImageData` and the browser does the scaling.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !track) return;
    const image = groundTrackImage(track);
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.putImageData(new ImageData(image.data, image.width, image.height), 0, 0);
  }, [track]);

  const marker = current ? projectPoint(current.latRad, current.lonRad) : null;
  const altitudeKm = current ? current.altitudeM / 1000 : null;

  return (
    <div className="section" data-testid={testid}>
      <h2>Ground track</h2>

      {!track || !summary ? (
        <p className="hint" data-testid="ground-track-empty">
          No ground track: the craft is not orbiting a body with a defined latitude and longitude.
        </p>
      ) : (
        <>
          <div className="ground-track-map" data-testid="ground-track-map">
            {/*
              `role="img"` with a generated description, matching the porkchop plot. The canvas is
              a picture: its value is the shape of the path, and the numbers under it are the
              precise version. The label therefore describes what is drawn - how many samples,
              how much longitude - rather than repeating the readouts below.
            */}
            <canvas
              ref={canvasRef}
              className="ground-track-canvas"
              data-testid="ground-track-canvas"
              role="img"
              aria-label={
                `Ground track on an equirectangular map, ${summary.sampleCount} samples over ` +
                `${((summary.lonSpanRad * 180) / Math.PI / 360).toFixed(2)} revolutions of longitude` +
                (summary.belowSurface ? ', part of it below the surface' : '') +
                '. Latitude and longitude are read out below the map.'
              }
            />
            {/*
              The marker is an absolutely positioned element rather than a pixel in the buffer,
              so it can be styled and read back by an e2e test without decoding the canvas. It
              sits at the interpolated point the polylines are drawn through, so it cannot drift
              off its own track.
            */}
            {marker && (
              <span
                className="ground-track-marker"
                data-testid="ground-track-marker"
                style={{
                  left: `${(marker.x * 100).toFixed(3)}%`,
                  top: `${(marker.y * 100).toFixed(3)}%`,
                }}
              />
            )}
            <span className="ground-track-axis ground-track-axis-lat">90°N</span>
            <span className="ground-track-axis ground-track-axis-south">90°S</span>
            <span className="ground-track-axis ground-track-axis-west">180°W</span>
            <span className="ground-track-axis ground-track-axis-east">180°E</span>
          </div>

          <dl className="readout">
            <dt>Latitude now</dt>
            <dd data-testid="ground-track-lat">
              {current ? formatAngle(current.latRad, 'lat') : '--'}
            </dd>
            <dt>Longitude now</dt>
            <dd data-testid="ground-track-lon">
              {current ? formatAngle(current.lonRad, 'lon') : '--'}
            </dd>
            <dt>Altitude now</dt>
            <dd data-testid="ground-track-alt">
              {altitudeKm === null ? '--' : `${altitudeKm.toFixed(1)} km`}
            </dd>
            <dt>Samples</dt>
            <dd data-testid="ground-track-samples">{summary.sampleCount}</dd>
          </dl>

          {summary.belowSurface && (
            <p className="caveat" data-testid="ground-track-below-surface">
              Part of the track is inside the Earth: the lowest point is{' '}
              {((summary.minAltitudeM ?? 0) / 1000).toFixed(0)} km altitude. The path is not viable,
              and the track is drawn in red to say so.
            </p>
          )}
          {summary.undefinedPoints > 0 && (
            <p className="caveat" data-testid="ground-track-gaps">
              {summary.undefinedPoints} sample{summary.undefinedPoints === 1 ? ' is' : 's are'} at
              the Earth&apos;s centre, where latitude and longitude do not exist. The track breaks
              there rather than drawing a line across the gap.
            </p>
          )}
          {summary.partialCoverage && (
            <p className="hint" data-testid="ground-track-partial">
              This plan covers {((summary.lonSpanRad * 180) / Math.PI / 360).toFixed(2)} revolutions
              of longitude, so the map shows an arc rather than a full repeating track. A longer
              horizon fills it in.
            </p>
          )}
          {summary.crossesAntimeridian && (
            <p className="hint" data-testid="ground-track-antimeridian">
              The track crosses the antimeridian. The line breaks at ±180° instead of running across
              the map, which is why the path looks discontinuous there.
            </p>
          )}

          <p className="hint" data-testid="ground-track-caveat">
            Equirectangular projection on a 30° graticule with no coastlines (D-004). Latitude is
            geocentric, which differs from geodetic by up to 0.19° — about{' '}
            {((RADIUS.earth * 0.19 * Math.PI) / 180 / 1000).toFixed(0)} km. East-west distances are
            stretched by 1/cos(latitude), which is the projection, not an error.
          </p>
        </>
      )}
    </div>
  );
}
