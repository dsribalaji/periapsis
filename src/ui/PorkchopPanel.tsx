/**
 * Porkchop panel: a heat-map of transfer cost over departure date and time of flight.
 *
 * Presentational work only. Every number, colour and cell mapping comes from
 * `porkchopView.ts`, which is unit tested; this file owns the canvas, the pointer and the
 * form. That split is what lets the orientation of the buffer, the colour ramp and the
 * pointer-to-cell arithmetic be asserted without a browser.
 *
 * Two deliberate UI choices:
 *
 * - **The grid is computed on a button, not on every keystroke.** A 100x100 plot is 10,000
 *   Lambert solves (~60 ms), which is a visible hitch if it runs while the user is still
 *   typing a year. It is also 10,000 solves per render otherwise, because a new request object
 *   is a new `useMemo` key.
 * - **The plot keeps the last successful grid while the form is edited.** A user comparing
 *   two windows should not lose the picture they were reading the moment they touch a field.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BODIES } from '../core/ephemeris/solarSystem.js';
import { computePorkchop, type Porkchop } from '../core/transfer/porkchop.js';
import {
  TRANSFER_BODIES,
  bestSummary,
  cellFromFraction,
  convergedFraction,
  defaultPorkchopRequest,
  departureTicks,
  epochYear,
  fractionOfCell,
  porkchopImage,
  readoutAt,
  requestToOptions,
  tofTicks,
  validatePorkchopRequest,
  windowWidthDays,
  type CellReadout,
  type PorkchopRequest,
} from './porkchopView.js';

export interface PorkchopPanelProps {
  /** Scenario epoch, used only to seed the default departure window. */
  readonly epochUtc: string;
}

interface Result {
  readonly grid: Porkchop;
  readonly request: PorkchopRequest;
}

export function PorkchopPanel({ epochUtc }: PorkchopPanelProps): React.JSX.Element {
  const [request, setRequest] = useState<PorkchopRequest>(() => defaultPorkchopRequest(epochUtc));
  const [result, setResult] = useState<Result | null>(null);
  const [hovered, setHovered] = useState<CellReadout | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // A scenario switch moves the epoch, and a window centred on a date two years gone is a
  // confidently empty plot. Re-seeding only when the year changes keeps a hand-edited window
  // intact across a scenario that shares its epoch year.
  const seededYear = useRef(epochYear(epochUtc));
  useEffect(() => {
    const year = epochYear(epochUtc);
    if (year === seededYear.current) return;
    seededYear.current = year;
    setRequest(defaultPorkchopRequest(epochUtc));
    setResult(null);
    setHovered(null);
  }, [epochUtc]);

  const issues = useMemo(() => validatePorkchopRequest(request), [request]);
  const canCompute = issues.length === 0;

  const compute = useCallback(() => {
    if (!canCompute) return;
    try {
      const grid = computePorkchop(requestToOptions(request));
      setResult({ grid, request });
      setHovered(null);
      setError(null);
    } catch (err) {
      // The panel shows the message rather than throwing into React's error boundary: a bad
      // date window must not take down the whole app.
      setError(err instanceof Error ? err.message : String(err));
      setResult(null);
    }
  }, [canCompute, request]);

  // Paint whenever the grid changes. The buffer is built at cell resolution and stretched by
  // CSS, so the drawing code is a `putImageData` and the browser does the scaling.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !result) return;
    const image = porkchopImage(result.grid);
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.putImageData(new ImageData(image.data, image.width, image.height), 0, 0);
  }, [result]);

  const summary = result ? bestSummary(result.grid) : null;

  const handlePointer = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      if (!result) return;
      const box = event.currentTarget.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0) return;
      const point = cellFromFraction(
        result.grid,
        (event.clientX - box.left) / box.width,
        (event.clientY - box.top) / box.height,
      );
      setHovered(readoutAt(result.grid, point.column, point.row));
    },
    [result],
  );

  const clearHover = useCallback(() => setHovered(null), []);

  const update = <K extends keyof PorkchopRequest>(key: K, value: PorkchopRequest[K]) =>
    setRequest((previous) => ({ ...previous, [key]: value }));

  return (
    <div className="section" data-testid="porkchop">
      {/*
        Collapsed by default. The panel is a tool, not a readout: open, it adds roughly a
        thousand pixels of form and plot, which pushes the body list and the view controls off
        the bottom of the sidebar. A mission designer opens it deliberately and closes it
        again; someone watching the clock never needs it.
      */}
      <h2>
        <button
          className="section-toggle"
          aria-expanded={expanded}
          aria-controls="porkchop-body"
          onClick={() => setExpanded((open) => !open)}
          data-testid="porkchop-toggle"
        >
          <span className="chevron" aria-hidden="true">
            {expanded ? '\u25be' : '\u25b8'}
          </span>
          Porkchop plot
        </button>
      </h2>

      {!expanded && (
        <p className="hint">
          Transfer cost over departure date and flight time. Expand to plan a window.
        </p>
      )}

      <div id="porkchop-body" hidden={!expanded} className="section-body">
        <p className="hint">
          Cost of a heliocentric transfer for every departure date and time of flight. Pick a
          window, compute, then hover the plot.
        </p>

        <div className="row">
          <label className="field">
            <span>From</span>
            <select
              aria-label="Departure body"
              value={request.departureBody}
              onChange={(e) =>
                update('departureBody', e.target.value as PorkchopRequest['departureBody'])
              }
            >
              {TRANSFER_BODIES.map((id) => (
                <option key={id} value={id}>
                  {BODIES[id].name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>To</span>
            <select
              aria-label="Arrival body"
              value={request.arrivalBody}
              onChange={(e) =>
                update('arrivalBody', e.target.value as PorkchopRequest['arrivalBody'])
              }
            >
              {TRANSFER_BODIES.map((id) => (
                <option key={id} value={id}>
                  {BODIES[id].name}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="row">
          <label className="field">
            <span>Depart from</span>
            <input
              type="text"
              aria-label="Departure window start"
              value={request.departureStartIso}
              onChange={(e) => update('departureStartIso', e.target.value)}
            />
          </label>
          <label className="field">
            <span>to</span>
            <input
              type="text"
              aria-label="Departure window end"
              value={request.departureEndIso}
              onChange={(e) => update('departureEndIso', e.target.value)}
            />
          </label>
        </div>

        <div className="row">
          <label className="field">
            <span>Flight time</span>
            <input
              type="text"
              aria-label="Shortest time of flight, days"
              value={String(request.minTofDays)}
              onChange={(e) => update('minTofDays', Number(e.target.value))}
            />
          </label>
          <label className="field">
            <span>to</span>
            <input
              type="text"
              aria-label="Longest time of flight, days"
              value={String(request.maxTofDays)}
              onChange={(e) => update('maxTofDays', Number(e.target.value))}
            />
          </label>
          <label className="field">
            <span>Grid</span>
            <input
              type="text"
              aria-label="Grid size"
              value={String(request.size)}
              onChange={(e) => update('size', Number(e.target.value))}
            />
          </label>
        </div>

        <div className="row">
          <button onClick={compute} disabled={!canCompute} data-testid="porkchop-compute">
            Compute plot
          </button>
          {result && (
            <span className="hint" data-testid="porkchop-stats">
              {result.grid.columns}x{result.grid.rows} · {Math.round(windowWidthDays(result.grid))}{' '}
              d window · {(convergedFraction(result.grid) * 100).toFixed(0)}% solved
            </span>
          )}
        </div>

        {issues.length > 0 && (
          <ul className="issue-list" data-testid="porkchop-issues">
            {issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        )}
        {error && (
          <p className="caveat" data-testid="porkchop-error">
            {error}
          </p>
        )}

        {result && (
          <>
            <div className="porkchop-figure">
              <div className="porkchop-yaxis" aria-hidden="true">
                {tofTicks(result.grid, 4).map((tick) => (
                  <span key={`t${tick.label}`} style={{ bottom: `${tick.fraction * 100}%` }}>
                    {tick.label}
                  </span>
                ))}
              </div>
              <div className="porkchop-plot">
                <canvas
                  ref={canvasRef}
                  className="porkchop-canvas"
                  data-testid="porkchop-canvas"
                  role="img"
                  aria-label={summary ?? 'Porkchop plot: no transfer found in this window.'}
                  onPointerMove={handlePointer}
                  onPointerLeave={clearHover}
                />
                {hovered && (
                  <div
                    className="porkchop-marker"
                    style={{
                      left: `${fractionOfCell(result.grid, hovered.column, hovered.row).x * 100}%`,
                      top: `${fractionOfCell(result.grid, hovered.column, hovered.row).y * 100}%`,
                    }}
                  />
                )}
              </div>
            </div>

            <div className="porkchop-xaxis" aria-hidden="true">
              {departureTicks(result.grid, 4).map((tick) => (
                <span key={`d${tick.label}`} style={{ left: `${tick.fraction * 100}%` }}>
                  {tick.label}
                </span>
              ))}
            </div>
            <p className="hint porkchop-axis-note">
              departure date &middot; flight time vertical, cheapest dark
            </p>

            <p className="hint" data-testid="porkchop-summary">
              {summary ?? 'No single-revolution arc exists anywhere in this window.'}
            </p>

            {/*
              The readout block keeps a fixed height and is always present, with dashes when
              nothing is hovered. This is not cosmetic: replacing a short hint with a tall list
              reflows the sidebar, which moves the plot out from under the pointer, which clears
              the hover, which reflows it back - the plot flickers and the readout is unusable.
              Reserving the space is what makes hovering stable.
            */}
            <dl className="readout porkchop-readout" data-testid="porkchop-readout">
              <dt>Depart</dt>
              <dd>{hovered ? hovered.departureIso : '--'}</dd>
              <dt>Arrive</dt>
              <dd>{hovered ? hovered.arrivalIso : '--'}</dd>
              <dt>Flight time</dt>
              <dd>{hovered ? `${hovered.timeOfFlightDays.toFixed(1)} d` : '--'}</dd>
              <dt>v-inf total</dt>
              <dd>{hovered ? `${(hovered.totalDeltaV / 1000).toFixed(2)} km/s` : '--'}</dd>
              <dt>Departure</dt>
              <dd>{hovered ? `${(hovered.vInfDeparture / 1000).toFixed(2)} km/s` : '--'}</dd>
              <dt>Arrival</dt>
              <dd>{hovered ? `${(hovered.vInfArrival / 1000).toFixed(2)} km/s` : '--'}</dd>
              <dt>C3</dt>
              <dd>{hovered ? `${hovered.c3.toFixed(1)} km²/s²` : '--'}</dd>
              <dt>Sweep angle</dt>
              <dd>{hovered ? `${hovered.transferAngleDeg.toFixed(1)}°` : '--'}</dd>
              <dt>Plane tilt</dt>
              <dd>{hovered ? `${hovered.planeTiltDeg.toFixed(1)}°` : '--'}</dd>
            </dl>

            <p className="caveat">
              Cost is the sum of the two v-infinity speeds, not the delta-v from a parking orbit.
              The Oberth effect is omitted, so these numbers rank windows correctly but understate
              what a real mission spends leaving and entering a gravity well.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
