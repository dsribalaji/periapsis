/**
 * Dwarf planets, asteroids and comets: a grouped list of buttons, plus a visibility toggle.
 *
 * Buttons rather than clickable rows for the same reason as the planet list: focus, Enter and
 * Space come from the element. Collapsed by default, because nineteen rows would push the rest
 * of the sidebar out of reach on a laptop screen.
 */

import { AU_M } from '../core/constants.js';
import { SMALL_BODIES, type SmallBodyKind } from '../core/ephemeris/smallBodies.js';
import { SMALL_BODY_KIND_LABEL, SMALL_BODY_SWATCH } from './targetView.js';

interface Props {
  readonly selected: string;
  readonly distances: ReadonlyMap<string, number>;
  readonly visible: boolean;
  readonly onVisible: (visible: boolean) => void;
  readonly onPick: (id: string) => void;
}

const ORDER: readonly SmallBodyKind[] = ['dwarf', 'asteroid', 'comet'];

export function SmallBodiesPanel({
  selected,
  distances,
  visible,
  onVisible,
  onPick,
}: Props): React.JSX.Element {
  return (
    <details className="section" data-testid="small-bodies">
      <summary>
        <h2>Dwarf planets, asteroids, comets</h2>
      </summary>
      <label className="toggle">
        <input type="checkbox" checked={visible} onChange={(e) => onVisible(e.target.checked)} />
        Show in the view
      </label>
      {ORDER.map((kind) => (
        <div key={kind}>
          <h3 className="subhead">{SMALL_BODY_KIND_LABEL[kind]}s</h3>
          <ul className="body-list">
            {SMALL_BODIES.filter((b) => b.kind === kind).map((b) => {
              const d = distances.get(b.id);
              const isCurrent = b.id === selected;
              return (
                <li key={b.id}>
                  <button
                    type="button"
                    className={`body-row${isCurrent ? ' selected' : ''}`}
                    aria-current={isCurrent ? 'true' : undefined}
                    onClick={() => onPick(b.id)}
                  >
                    <span
                      className="swatch"
                      style={{ background: SMALL_BODY_SWATCH[kind] }}
                      aria-hidden="true"
                    />
                    <span className="name">{b.name}</span>
                    <span className="dist">
                      {d === undefined ? '' : `${(d / AU_M).toFixed(3)} AU`}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      <p className="hint">
        Orbits from NASA/JPL&apos;s Small-Body Database, bundled with the app. They are drawn and
        measured, but have no gravity in the simulation.
      </p>
    </details>
  );
}
