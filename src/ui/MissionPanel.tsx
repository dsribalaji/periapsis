/**
 * Mission panel: the craft's plan and where it currently is.
 *
 * Presentational only — every number arrives already computed in `missionView.ts`. That keeps
 * the panel free of physics and makes the readouts testable at the view-model level instead of
 * through the DOM.
 *
 * The delta-v budget is shown as three numbers, not one, because they answer different
 * questions and conflating them hides the interesting failure: `planned` is what the mission
 * file asks for, `spent` is what the clock has actually passed, and `remaining` is budget
 * minus planned. A plan over its budget is visible before the craft has flown at all, which is
 * when it is still cheap to fix.
 */

import type { MissionPlan, MissionProgress } from './missionView.js';

export interface MissionPanelProps {
  readonly plan: MissionPlan;
  readonly progress: MissionProgress | null;
  readonly testid?: string;
}

export function MissionPanel({ plan, progress, testid }: MissionPanelProps): React.JSX.Element {
  const overBudget = plan.remainingDeltaV < 0;
  const radius = progress?.radius ?? null;
  const altitude = progress?.altitude ?? null;

  return (
    <div className="section" data-testid={testid}>
      <h2>Mission</h2>
      <dl className="readout">
        <dt>Craft</dt>
        <dd>{plan.craftName}</dd>
        <dt>Around</dt>
        <dd>{plan.centralBody}</dd>
        <dt>Orbit speed</dt>
        <dd>{plan.initialSpeed.toFixed(1)} m/s</dd>
        <dt>Period</dt>
        <dd>{formatMinutes(plan.initialPeriod)}</dd>
        <dt>Radius now</dt>
        <dd data-testid="mission-radius">
          {radius === null ? '--' : `${(radius / 1000).toFixed(1)} km`}
        </dd>
        <dt>Altitude now</dt>
        <dd data-testid="mission-altitude">
          {altitude === null ? '--' : `${(altitude / 1000).toFixed(1)} km`}
        </dd>
        <dt>Apoapsis</dt>
        <dd>{(plan.maxRadius / 1000).toFixed(1)} km</dd>
        <dt>Periapsis</dt>
        <dd>{(plan.minRadius / 1000).toFixed(1)} km</dd>
      </dl>

      <h2 style={{ marginTop: 6 }}>Delta-v</h2>
      <dl className="readout">
        <dt>Budget</dt>
        <dd>{plan.budget.toFixed(1)} m/s</dd>
        <dt>Planned</dt>
        <dd data-testid="mission-planned">{plan.plannedDeltaV.toFixed(1)} m/s</dd>
        <dt>Spent</dt>
        <dd data-testid="mission-spent">{(progress?.spentDeltaV ?? 0).toFixed(1)} m/s</dd>
        <dt>Remaining</dt>
        <dd
          data-testid="mission-remaining"
          style={overBudget ? { color: 'var(--danger)' } : undefined}
        >
          {plan.remainingDeltaV.toFixed(1)} m/s
        </dd>
      </dl>

      {overBudget && (
        <p className="caveat" data-testid="mission-over-budget">
          The plan spends {(plan.plannedDeltaV - plan.budget).toFixed(0)} m/s more than the budget.
          It cannot fly as written.
        </p>
      )}
      {plan.impacts && (
        <p className="caveat" data-testid="mission-impact">
          The path crosses the surface of {plan.centralBody}: the orbit is not viable.
        </p>
      )}
      {plan.truncated && (
        <p className="caveat">The propagator stopped early: the horizon was not reached.</p>
      )}

      <h2 style={{ marginTop: 6 }}>Nodes</h2>
      {plan.nodes.length === 0 ? (
        <p className="hint">No maneuver nodes. The path is a pure coast.</p>
      ) : (
        <div className="node-list" data-testid="mission-nodes">
          {plan.nodes.map((n) => {
            const applied = progress?.appliedNodeIds.includes(n.id) ?? false;
            return (
              <div key={n.id} className={`node-row${applied ? ' applied' : ''}`}>
                <span className="node-label">{n.label}</span>
                <span className="node-dv">{n.magnitude.toFixed(0)} m/s</span>
                <span className="node-time">{formatClock(n.timeSeconds)}</span>
                <span className="node-frame">{n.frame === 'local' ? 'local' : 'inertial'}</span>
              </div>
            );
          })}
        </div>
      )}
      <p className="hint">
        Nodes are prograde/normal/radial in the craft&apos;s local frame, or inertial. A local burn
        direction depends on where on the orbit it happens, which is the point of defining it that
        way.
      </p>
    </div>
  );
}

/** `1d 04:10:00` style duration, for a period or a horizon. */
function formatMinutes(seconds: number): string {
  if (!Number.isFinite(seconds)) return '--';
  const totalMinutes = seconds / 60;
  if (totalMinutes < 120) return `${totalMinutes.toFixed(1)} min`;
  const hours = seconds / 3600;
  if (hours < 48) return `${hours.toFixed(2)} h`;
  return `${(hours / 24).toFixed(2)} d`;
}

/** `T+01:23:45` style, so a node time reads as mission elapsed time rather than a duration. */
function formatClock(seconds: number): string {
  const sign = seconds < 0 ? '-' : '+';
  let s = Math.abs(Math.floor(seconds));
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `T${sign}${p2(h)}:${p2(m)}:${p2(s)}`;
}
