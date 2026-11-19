/**
 * The "Selected" panel: whatever `summarizeTarget` says about the current target.
 *
 * All wording and arithmetic live in `targetView.ts`; this only lays the rows out.
 */

import { summarizeTarget, type TargetMeasurements } from './targetView.js';

interface Props {
  readonly id: string;
  readonly measurements: TargetMeasurements;
  /** Copies a link to the current view, or null when the browser cannot. */
  readonly onShare: (() => void) | null;
  /** Shown after a share, e.g. "Link copied". */
  readonly shareNote: string | null;
}

export function SelectedPanel({ id, measurements, onShare, shareNote }: Props): React.JSX.Element {
  const summary = summarizeTarget(id, measurements);
  return (
    <div className="section">
      <h2>Selected</h2>
      <dl className="readout">
        <dt>Body</dt>
        <dd style={{ color: summary?.color }} data-testid="selected-name">
          {summary?.title ?? '--'}
        </dd>
        {summary?.rows.map((row) => (
          <Row key={row.label} label={row.label} value={row.value} testid={row.testid} />
        ))}
      </dl>
      {summary?.caveat && <p className="caveat">{summary.caveat}</p>}
      {onShare && (
        <div className="row">
          <button type="button" onClick={onShare} title="Copy a link that reopens this exact view">
            Copy link to this view
          </button>
          {shareNote && (
            <span className="hint" role="status" data-testid="share-note">
              {shareNote}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function Row({
  label,
  value,
  testid,
}: {
  label: string;
  value: string;
  testid: string | undefined;
}): React.JSX.Element {
  return (
    <>
      <dt>{label}</dt>
      <dd data-testid={testid}>{value}</dd>
    </>
  );
}
