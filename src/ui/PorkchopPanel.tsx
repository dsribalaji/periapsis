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
  /**
   * Called with a chosen cell's column and row when the user asks to plan a departure.
   *
   * The panel does not build the node itself: it knows the grid, not the craft. Handing the
   * cell back keeps the panel presentational and leaves the craft-specific arithmetic in
   * `App`, where the mission lives.
   */
  readonly onPlanDeparture?: (column: number, row: number) => void;
  /**
   * Why planning is not possible at all in this scenario, or null/absent when it is.
   *
   * Distinct from `departureIssue`, which reports the *last attempt*: this is a standing
   * condition (no spacecraft to burn from), so the control is disabled and the reason is shown
   * beside it rather than left for the user to discover by pressing a dead button.
   */
  readonly departureUnavailableReason?: string | null;
  /**
   * Called with the grid after every successful compute.
   *
   * The app needs the grid to turn a cell into a departure asymptote, and it must be the
   * *same* grid the user hovered: re-solving a cell against a different window would put the
   * node somewhere the plot never showed. Publishing the grid is how that is guaranteed
   * rather than hoped for.
   */
  readonly onGrid?: (grid: Porkchop) => void;
  /** Why the last attempt to plan a departure failed, or null. */
  readonly departureIssue?: string | null;
  /** A one-line summary of the node that was created, or null. */
  readonly departureNote?: string | null;
}

interface Result {
  readonly grid: Porkchop;
  readonly request: PorkchopRequest;
}

export function PorkchopPanel({
  epochUtc,
  onPlanDeparture,
  onGrid,
  departureIssue = null,
  departureNote = null,
  departureUnavailableReason = null,
}: PorkchopPanelProps): React.JSX.Element {
  const [request, setRequest] = useState<PorkchopRequest>(() => defaultPorkchopRequest(epochUtc));
  const [result, setResult] = useState<Result | null>(null);
  // The cell under the pointer, for the readout: transient.
  const [hovered, setHovered] = useState<CellReadout | null>(null);
  // The cell the user *clicked*, which persists. This exists because a pointer cannot both
  // rest on the plot and press a button below it: leaving the canvas clears the hover, which
  // would disable the departure action exactly as the user reached for it. A click is a
  // selection, and a selection outlives the pointer.
  const [chosen, setChosen] = useState<CellReadout | null>(null);
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
    setChosen(null);
  }, [epochUtc]);

  const issues = useMemo(() => validatePorkchopRequest(request), [request]);
  const canCompute = issues.length === 0;

  const compute = useCallback(() => {
    if (!canCompute) return;
    try {
      const grid = computePorkchop(requestToOptions(request));
      setResult({ grid, request });
      setHovered(null);
      setChosen(null);
      setError(null);
      onGrid?.(grid);
    } catch (err) {
      // The panel shows the message rather than throwing into React's error boundary: a bad
      // date window must not take down the whole app.
      setError(err instanceof Error ? err.message : String(err));
      setResult(null);
    }
  }, [canCompute, onGrid, request]);

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

  const handlePlotClick = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      if (!result) return;
      const box = event.currentTarget.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0) return;
      const point = cellFromFraction(
        result.grid,
        (event.clientX - box.left) / box.width,
        (event.clientY - box.top) / box.height,
      );
      setChosen(readoutAt(result.grid, point.column, point.row));
    },
    [result],
  );

  const clearHover = useCallback(() => setHovered(null), []);

  // While the pointer is on the plot the readout follows it; once it leaves, the readout falls
  // back to the clicked selection, so the numbers describing the cell being planned from do not
  // vanish the moment the pointer moves to the button.
  const active = hovered ?? chosen;

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
            {/*
              Each control is wrapped in a `label`, and also carries an `aria-label` that *starts
              with* the visible text. The wrapping label alone would name these "From", "To" and
              "to", which is not enough to tell two of them apart; a bare `aria-label` that
              replaced the visible text would break voice control, because a user saying what
              they can see ("From") would not match the name. Starting the name with the visible
              text satisfies both.
            */}
            <select
              aria-label="From: departure body"
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
              aria-label="To: arrival body"
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
              aria-label="Depart from: departure window start"
              value={request.departureStartIso}
              onChange={(e) => update('departureStartIso', e.target.value)}
            />
          </label>
          <label className="field">
            <span>to</span>
            <input
              type="text"
              aria-label="To: departure window end"
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
              aria-label="Flight time: shortest time of flight, days"
              value={String(request.minTofDays)}
              onChange={(e) => update('minTofDays', Number(e.target.value))}
            />
          </label>
          <label className="field">
            <span>to</span>
            <input
              type="text"
              aria-label="To: longest time of flight, days"
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
                {/* Keyed by position, not label: a narrow flight-time window can give two
                    ticks the same rounded label, and React rejects a duplicate key. */}
                {tofTicks(result.grid, 4).map((tick, i) => (
                  <span key={i} style={{ bottom: `${tick.fraction * 100}%` }}>
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
                  onClick={handlePlotClick}
                />
                {active && (
                  <div
                    className="porkchop-marker"
                    style={{
                      left: `${fractionOfCell(result.grid, active.column, active.row).x * 100}%`,
                      top: `${fractionOfCell(result.grid, active.column, active.row).y * 100}%`,
                    }}
                  />
                )}
              </div>
            </div>

            <div className="porkchop-xaxis" aria-hidden="true">
              {departureTicks(result.grid, 4).map((tick, i) => (
                <span key={i} style={{ left: `${tick.fraction * 100}%` }}>
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
              The departure action lives here rather than in a separate panel because the cell
              is what it acts on. Asking the user to retype a date into a different tool would
              lose the only information the plot produced.

              It acts on the *clicked* cell, not the hovered one. A pointer cannot rest on the
              plot and press this button at the same time: moving to the button raises
              `pointerleave`, which clears the hover and would disable the button exactly as it
              was being reached for. A click is a selection and survives the pointer leaving.
            */}
            <div className="row">
              <button
                onClick={() => {
                  if (!chosen || !onPlanDeparture) return;
                  onPlanDeparture(chosen.column, chosen.row);
                }}
                disabled={!chosen || !onPlanDeparture || departureUnavailableReason !== null}
                data-testid="porkchop-plan-departure"
                title={
                  departureUnavailableReason ??
                  (chosen
                    ? 'Turn the clicked cell into a manoeuvre node at the departure body'
                    : 'Click a cell in the plot first')
                }
              >
                Plan departure from this cell
              </button>
            </div>
            {departureUnavailableReason ? (
              <p className="caveat" data-testid="porkchop-departure-unavailable">
                {departureUnavailableReason}
              </p>
            ) : (
              <p className="hint">
                {chosen
                  ? 'The cell sets the departure date and the aim; the node is the burn from the ' +
                    "craft's parking orbit, which is not the same number as the cell's cost."
                  : 'Click a cell in the plot to choose it, then plan the departure from it.'}
              </p>
            )}

            {departureIssue && (
              <p className="caveat" role="alert" data-testid="porkchop-departure-issue">
                {departureIssue}
              </p>
            )}
            {departureNote && (
              <p className="hint" role="status" data-testid="porkchop-departure-note">
                {departureNote}
              </p>
            )}

            {/*
              The readout block keeps a fixed height and is always present, with dashes when
              nothing is hovered. This is not cosmetic: replacing a short hint with a tall list
              reflows the sidebar, which moves the plot out from under the pointer, which clears
              the hover, which reflows it back - the plot flickers and the readout is unusable.
              Reserving the space is what makes hovering stable.
            */}
            <dl className="readout porkchop-readout" data-testid="porkchop-readout">
              <dt>Depart</dt>
              <dd>{active ? active.departureIso : '--'}</dd>
              <dt>Arrive</dt>
              <dd>{active ? active.arrivalIso : '--'}</dd>
              <dt>Flight time</dt>
              <dd>{active ? `${active.timeOfFlightDays.toFixed(1)} d` : '--'}</dd>
              <dt>v-inf total</dt>
              <dd>{active ? `${(active.totalDeltaV / 1000).toFixed(2)} km/s` : '--'}</dd>
              <dt>Departure</dt>
              <dd>{active ? `${(active.vInfDeparture / 1000).toFixed(2)} km/s` : '--'}</dd>
              <dt>Arrival</dt>
              <dd>{active ? `${(active.vInfArrival / 1000).toFixed(2)} km/s` : '--'}</dd>
              <dt>C3</dt>
              <dd>{active ? `${active.c3.toFixed(1)} km²/s²` : '--'}</dd>
              <dt>Sweep angle</dt>
              <dd>{active ? `${active.transferAngleDeg.toFixed(1)}°` : '--'}</dd>
              <dt>Plane tilt</dt>
              <dd>{active ? `${active.planeTiltDeg.toFixed(1)}°` : '--'}</dd>
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
