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

import { useState } from 'react';
import type { MissionPlan, MissionProgress } from './missionView.js';
import type { Maneuver } from '../sim/maneuver.js';
import { draftFromNode, newDraft, type DraftIssue, type NodeDraft } from './nodeEditor.js';

export interface MissionPanelProps {
  readonly plan: MissionPlan;
  readonly progress: MissionProgress | null;
  readonly testid?: string;
  /** The raw nodes, for pre-filling the editor. Omit to make the panel read-only. */
  readonly maneuvers?: readonly Maneuver[];
  /** Applies a draft; returns the problems, or an empty list when it was accepted. */
  readonly onApplyDraft?: (draft: NodeDraft) => readonly DraftIssue[];
  readonly onDeleteNode?: (id: string) => void;
  /** Simulation seconds now, so a new node defaults to "a little after now". */
  readonly nowSeconds?: number;
}

export function MissionPanel({
  plan,
  progress,
  testid,
  maneuvers,
  onApplyDraft,
  onDeleteNode,
  nowSeconds = 0,
}: MissionPanelProps): React.JSX.Element {
  const editable = Boolean(maneuvers && onApplyDraft && onDeleteNode);
  const [draft, setDraft] = useState<NodeDraft | null>(null);
  const [issues, setIssues] = useState<readonly DraftIssue[]>([]);
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
        <dd data-testid="mission-apoapsis">{(plan.maxRadius / 1000).toFixed(1)} km</dd>
        <dt>Periapsis</dt>
        <dd data-testid="mission-periapsis">{(plan.minRadius / 1000).toFixed(1)} km</dd>
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
      {plan.coastAliased && (
        <p className="caveat" data-testid="mission-aliased">
          The plan spans {(plan.horizonSeconds / 86400).toFixed(0)} days, so each drawn sample
          covers {plan.periodFractionPerSample.toFixed(2)} orbits. The states and the delta-v are
          exact, but the drawn coast is too coarse to read as an orbit: it is a star rather than a
          circle. Planned departures sit this far out on purpose.
        </p>
      )}

      <h2 style={{ marginTop: 6 }}>Nodes</h2>
      {plan.nodes.length === 0 ? (
        <p className="hint" data-testid="mission-no-nodes">
          No maneuver nodes. The path is a pure coast.
        </p>
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
                {editable && (
                  <span className="node-actions">
                    <button
                      type="button"
                      aria-label={`Edit ${n.label}`}
                      onClick={() => {
                        const m = maneuvers?.find((x) => x.id === n.id);
                        if (m) {
                          setDraft(draftFromNode(m));
                          setIssues([]);
                        }
                      }}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      aria-label={`Delete ${n.label}`}
                      onClick={() => {
                        onDeleteNode?.(n.id);
                        if (draft?.id === n.id) setDraft(null);
                      }}
                    >
                      Delete
                    </button>
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {editable && !draft && (
        <div className="row">
          <button
            type="button"
            data-testid="node-add"
            onClick={() => {
              // A round minute after now: a burn at exactly "now" would already be in the past
              // by the time the form is filled in on a running clock.
              setDraft(newDraft(Math.ceil((nowSeconds + 60) / 60) * 60));
              setIssues([]);
            }}
          >
            Add a burn
          </button>
        </div>
      )}

      {editable && draft && (
        <form
          className="node-form"
          data-testid="node-form"
          onSubmit={(e) => {
            e.preventDefault();
            const found = onApplyDraft?.(draft) ?? [];
            setIssues(found);
            if (found.length === 0) setDraft(null);
          }}
        >
          <h3 className="subhead">{draft.id ? 'Edit burn' : 'New burn'}</h3>
          <DraftField
            label="Label"
            field="label"
            draft={draft}
            issues={issues}
            onChange={setDraft}
            placeholder="optional"
          />
          <DraftField
            label="Time (T+)"
            field="time"
            draft={draft}
            issues={issues}
            onChange={setDraft}
            placeholder="h:mm:ss or 2d 03:00:00"
          />
          <label className="field">
            <span>Frame</span>
            <select
              value={draft.frame}
              onChange={(e) =>
                setDraft({ ...draft, frame: e.target.value === 'inertial' ? 'inertial' : 'local' })
              }
            >
              <option value="local">Local (prograde / normal / radial)</option>
              <option value="inertial">Inertial (x / y / z)</option>
            </select>
          </label>
          <div className="row">
            <DraftField
              label={draft.frame === 'local' ? 'Prograde m/s' : 'x m/s'}
              field="a"
              draft={draft}
              issues={issues}
              onChange={setDraft}
            />
            <DraftField
              label={draft.frame === 'local' ? 'Normal m/s' : 'y m/s'}
              field="b"
              draft={draft}
              issues={issues}
              onChange={setDraft}
            />
            <DraftField
              label={draft.frame === 'local' ? 'Radial m/s' : 'z m/s'}
              field="c"
              draft={draft}
              issues={issues}
              onChange={setDraft}
            />
          </div>
          {issues.some((i) => i.field === 'id') && (
            <p className="caveat" role="alert">
              That burn was deleted while you were editing it.
            </p>
          )}
          <div className="row">
            <button type="submit" className="active">
              {draft.id ? 'Save burn' : 'Add burn'}
            </button>
            <button type="button" onClick={() => setDraft(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      <p className="hint">
        Nodes are prograde/normal/radial in the craft&apos;s local frame, or inertial. A local burn
        direction depends on where on the orbit it happens, which is the point of defining it that
        way.{editable && ' Every change re-propagates the whole plan immediately.'}
      </p>
    </div>
  );
}

/** One labelled text input of the burn form, with its own error message under it. */
function DraftField({
  label,
  field,
  draft,
  issues,
  onChange,
  placeholder,
}: {
  label: string;
  field: 'label' | 'time' | 'a' | 'b' | 'c';
  draft: NodeDraft;
  issues: readonly DraftIssue[];
  onChange: (next: NodeDraft) => void;
  placeholder?: string;
}): React.JSX.Element {
  const issue = issues.find((i) => i.field === field);
  const errorId = `node-${field}-error`;
  return (
    <label className="field">
      <span>{label}</span>
      <input
        type="text"
        inputMode={field === 'label' || field === 'time' ? 'text' : 'decimal'}
        value={draft[field]}
        placeholder={placeholder}
        aria-invalid={issue ? 'true' : undefined}
        aria-describedby={issue ? errorId : undefined}
        data-testid={`node-${field}`}
        onChange={(e) => onChange({ ...draft, [field]: e.target.value })}
      />
      {issue && (
        <span className="field-error" id={errorId} role="alert">
          {label.replace(/ m\/s$/, '')} {issue.message}
        </span>
      )}
    </label>
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
