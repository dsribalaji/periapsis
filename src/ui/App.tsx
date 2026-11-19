/**
 * Application shell: a 3D viewport, a time bar, and an inspector sidebar.
 *
 * Responsibilities are deliberately narrow. This component owns React state and the frame
 * loop; all orbital mechanics live in `src/core` and all drawing in `src/render`. The clock
 * is advanced once per animation frame with the measured frame time, then the scene is
 * updated from a snapshot.
 *
 * Two structural notes:
 *
 * - The `Simulation` is a mutable object created once via a lazy state initialiser, not a
 *   ref mutated during render. It is not React state in the "replace me" sense; it is an
 *   external system that React only ever mutates through callbacks.
 *
 * - Nothing is pushed into React state synchronously from an effect. Text readouts are
 *   published at ~10 Hz from inside the animation-frame callback, which is where updates
 *   from an external system belong. At 60 Hz, refreshing labels every frame would cost
 *   reconciliation for numbers no one can read that fast.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Simulation } from '../sim/simulation.js';
import { formatDuration, WARP_STEPS, type Warp } from '../sim/clock.js';
import { SolarSystemScene } from '../render/scene.js';
import type { RadialMode } from '../render/scale.js';
import { BODY_DISPLAY } from './bodyDisplay.js';
import type { BodyId } from '../core/ephemeris/solarSystem.js';
import { AU_M, SECONDS_PER_DAY } from '../core/constants.js';
import { SCENARIOS } from '../scenarios/catalogue.js';
import {
  browserStore,
  clearScenario,
  saveScenario,
  type KeyValueStore,
} from '../scenarios/persist.js';
import { bootScenario, type BootState } from './boot.js';
import { ScenarioFilePanel } from './ScenarioFilePanel.js';
import type { Scenario } from '../scenarios/types.js';
import type { CraftSpec } from '../sim/craft.js';
import {
  buildMissionPlan,
  missionProgress,
  type MissionPlan,
  type MissionProgress,
} from './missionView.js';
import { GroundTrackPanel } from './GroundTrackPanel.js';
import { MissionPanel } from './MissionPanel.js';
import { PorkchopPanel } from './PorkchopPanel.js';
import { departureAsymptote, type Porkchop } from '../core/transfer/porkchop.js';
import { applyDepartureNode, buildTransferNode, departureSummary } from './transferView.js';

/**
 * Runs before the first render, once per mount, and decodes what the store remembers.
 *
 * A module-level constant would be wrong here: `bootScenario` reads `localStorage`, and a module
 * that reads the DOM at import time makes the file awkward to test and impossible to re-run.
 * `useState` initialisers are called in an order React guarantees, so the lazy state below all
 * reads this one object rather than each of them calling boot separately.
 */
function bootOnce(): BootState {
  return bootScenario();
}

/** Colour of the craft's path, distinct from every body colour. */
const MISSION_COLOR = 0xff9f1c;

function progressFor(plan: MissionPlan | null, simSeconds: number): MissionProgress | null {
  return plan ? missionProgress(plan, simSeconds) : null;
}

interface DisplayState {
  readonly simSeconds: number;
  readonly isoUtc: string;
  readonly throttled: boolean;
  readonly distances: ReadonlyMap<BodyId, number>;
  /** Bodies whose centre is outside the camera frustum, so the user knows why they are missing. */
  readonly offscreen: ReadonlySet<BodyId>;
  /** Set when WebGL could not start; the app still runs, it just cannot draw. */
  readonly webglError: string | null;
  /** Where the craft is and what the plan has spent. Null without a mission. */
  readonly progress: MissionProgress | null;
}

function initialDisplay(isoUtc: string): DisplayState {
  return {
    simSeconds: 0,
    isoUtc,
    throttled: false,
    distances: new Map(),
    offscreen: new Set<BodyId>(),
    webglError: null,
    progress: null,
  };
}

export function App(): React.JSX.Element {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<SolarSystemScene | null>(null);
  // Boot runs once, in a lazy initialiser, so a StrictMode double mount does not cost a second
  // storage read and the first render already knows which scenario it is showing.
  const [boot] = useState(bootOnce);
  const initial = boot.scenario;
  // The store, resolved once per mount. Null when the browser will not give us one, which is a
  // normal condition (private mode, blocked cookies) rather than an error: the app simply does
  // not remember anything, and nothing in the UI claims it does.
  const [store] = useState<KeyValueStore | null>(() => browserStore());
  // Created once. Never replaced, only mutated through event handlers.
  const [sim] = useState(() => new Simulation(initial.epochUtc, initial.startWarp));

  const [scenario, setScenario] = useState<Scenario>(initial);
  // The mission is state, not derived from the scenario, because a planned departure writes a
  // node into it. It is seeded from the scenario and replaced wholesale on a scenario switch,
  // so a node planned in one scenario can never leak into another.
  const [mission, setMission] = useState<CraftSpec | undefined>(initial.mission);
  const [selected, setSelected] = useState<BodyId>(initial.focus);
  const [warp, setWarpState] = useState<Warp>(initial.startWarp);
  const [scaleMode, setScaleMode] = useState<RadialMode>(initial.view.radialMode);
  const [display, setDisplay] = useState<DisplayState>(() => initialDisplay(initial.epochUtc));
  // Feedback from the last "plan departure" attempt. Null means nothing has been attempted.
  const [departureIssue, setDepartureIssue] = useState<string | null>(null);
  const [departureNote, setDepartureNote] = useState<string | null>(null);
  // The last porkchop grid, kept so a departure can be planned from a cell without the panel
  // and the app having to share React state for the whole grid.
  const lastGridRef = useRef<Porkchop | null>(null);

  // The plan depends only on the mission and the epoch, so it is derived rather than stored:
  // one propagation per mission change, not per frame. The epoch is a dependency because node
  // times are measured from it.
  const plan = useMemo(
    () => (mission ? buildMissionPlan(mission, scenario.epochUtc) : null),
    [mission, scenario.epochUtc],
  );

  // Read inside the frame loop, which must not restart when the plan changes. Synced in an
  // effect because a ref written during render is exactly what the linter forbids: it can
  // leave the ref and the committed tree disagreeing if React discards a render.
  const planRef = useRef<MissionPlan | null>(plan);
  useEffect(() => {
    planRef.current = plan;
  }, [plan]);

  // Last non-paused warp, so Play resumes at the speed the user was using. Updated only
  // from event handlers, never from an effect.
  const resumeWarpRef = useRef<Warp>(initial.startWarp);

  // Set once the first save has been made. Rendering must not write storage, and a save that
  // fires on the initial render would rewrite a just-restored scenario with itself.
  const savedRef = useRef(false);

  // Set when WebGL fails to start, read by the frame loop and published with the readouts.
  const webglErrorRef = useRef<string | null>(null);

  /**
   * Puts the scene into a scenario's framing.
   *
   * Positions must be pushed before the camera is aimed, because framing a body reads its
   * scene position; doing it the other way round aims the camera at where the body was.
   */
  const applyScenario = useCallback(
    (next: Scenario) => {
      sim.reset(next.epochUtc, next.startWarp);
      resumeWarpRef.current = next.startWarp;
      setWarpState(next.startWarp);
      setSelected(next.focus);
      setScaleMode(next.view.radialMode);
      setScenario(next);
      // The mission travels with the scenario. Leaving the old one in place would draw a
      // satellite around the Sun under a scenario that has no craft in it.
      setMission(next.mission);
      setDepartureIssue(null);
      setDepartureNote(null);
      lastGridRef.current = null;

      const scene = sceneRef.current;
      if (!scene) return;
      scene.setRadialMode(next.view.radialMode);
      scene.updatePositions(sim.positions());
      scene.setCamera(next.view);
      if (next.view.centeredOn === 'focus') scene.centerOn(next.focus);
      else if (next.view.centeredOn === 'pair') scene.centerOnPair(next.focus);
    },
    [sim],
  );

  /**
   * Remembers the scenario, so a reload puts the user back where they were.
   *
   * Saves only the *scenario*, not the clock or a mission node added since. A planned departure
   * is something the user asked the app to compute from a scenario plus a porkchop cell;
   * restoring the scenario and asking them to click again is honest, whereas restoring a node
   * would mean persisting a derived trajectory input whose epoch assumptions are no longer in
   * front of them.
   *
   * Never writes on the first commit, and never writes at all when the store holds a newer entry
   * this build cannot read (`boot.preserveStored`).
   */
  useEffect(() => {
    // A newer entry is never overwritten, for the whole session, not just the first render.
    if (store === null || boot.preserveStored) return;
    // The first run is the boot scenario being written back to itself. Skipping it keeps the
    // `savedAt` of a restored scenario honest: it still says when the user actually saved.
    if (!savedRef.current) {
      savedRef.current = true;
      return;
    }
    saveScenario(store, scenario, new Date().toISOString());
  }, [scenario, store, boot.preserveStored]);

  /**
   * Pushes the mission's path into the scene.
   *
   * Runs when the plan changes (scenario switch, node edit) and again after a radial-mode
   * change, because both move the anchor. Progress is pushed separately, every UI tick.
   */
  const applyPlan = useCallback((next: MissionPlan | null) => {
    const scene = sceneRef.current;
    if (!scene) return;
    if (!next) {
      scene.setTrajectories([]);
      return;
    }
    scene.setTrajectories([
      {
        id: next.craftId,
        centralBody: next.centralBody,
        positions: next.frame.positions,
        color: MISSION_COLOR,
        flownSegments: 0,
      },
    ]);
  }, []);

  // Keep the scene's path in step with the plan. The stored camera wins: a mission scenario
  // says how it wants to be framed, and re-framing here would override that on every switch.
  useEffect(() => {
    applyPlan(plan);
  }, [applyPlan, plan]);

  /**
   * Turns the hovered porkchop cell into a manoeuvre node on the craft.
   *
   * Three things are being joined here and each has a failure mode the user must be told
   * about rather than shown a silently empty plot: the cell may have no asymptote (a hole in
   * the grid), the departure may be impossible from this park (wrong body, no solution), or
   * the departure may lie past the end of the mission's plan. Only the last one changes the
   * mission's span, and it says so.
   */
  const handlePlanDeparture = useCallback(
    (column: number, row: number) => {
      const grid = lastGridRef.current;
      if (!grid) {
        setDepartureIssue('Compute a plot first, then pick a cell in it.');
        setDepartureNote(null);
        return;
      }
      if (!mission) {
        setDepartureIssue(
          'This scenario has no spacecraft. A departure node needs a craft to burn from.',
        );
        setDepartureNote(null);
        return;
      }

      const asymptote = departureAsymptote(grid, column, row);
      if (!asymptote) {
        setDepartureIssue(
          'That cell has no single-revolution solution, so there is no departure direction to ' +
            'aim at. Pick a cell inside the coloured region.',
        );
        setDepartureNote(null);
        return;
      }

      const result = buildTransferNode({
        asymptote,
        centralBody: mission.centralBody,
        orbit: mission.orbit,
        epochUtc: scenario.epochUtc,
      });
      if (!result.ok) {
        setDepartureIssue(result.issues.map((i) => i.message).join(' '));
        setDepartureNote(null);
        return;
      }

      const applied = applyDepartureNode(mission, result.node);
      if (!applied.ok) {
        setDepartureIssue(applied.reason);
        setDepartureNote(null);
        return;
      }

      setMission(applied.craft);
      setDepartureIssue(null);
      const extended = applied.horizonSeconds - mission.horizonSeconds;
      setDepartureNote(
        departureSummary(result.node) +
          (extended > 0
            ? ` The plan now runs ${(extended / SECONDS_PER_DAY).toFixed(0)} days further to ` +
              'cover it.'
            : ''),
      );
    },
    [mission, scenario.epochUtc],
  );

  const handleWarp = useCallback(
    (next: Warp) => {
      if (next !== 0) resumeWarpRef.current = next;
      setWarpState(next);
      sim.setWarp(next);
    },
    [sim],
  );

  const togglePause = useCallback(() => {
    handleWarp(sim.paused ? resumeWarpRef.current : 0);
  }, [handleWarp, sim]);

  const handleScaleMode = useCallback(
    (mode: RadialMode) => {
      setScaleMode(mode);
      const scene = sceneRef.current;
      if (!scene) return;
      scene.setRadialMode(mode);
      // Reposition immediately and reframe, so the toggle takes effect without waiting for
      // the next simulation step.
      scene.updatePositions(sim.positions());
      scene.frameAll();
      // The path is anchored to a body whose scene position just moved, and its own scale is
      // unaffected by the radial mode, so only the anchor needs refreshing.
      applyPlan(planRef.current);
    },
    [applyPlan, sim],
  );

  // Scene lifecycle. StrictMode mounts twice in development, so dispose must be complete.
  useEffect(() => {
    const container = viewportRef.current;
    if (!container) return;

    let scene: SolarSystemScene;
    try {
      scene = new SolarSystemScene(container, { onSelect: setSelected });
    } catch (err) {
      // Published through the frame loop rather than set here, so that this effect only
      // ever talks to the external system and never causes a cascading render.
      sceneRef.current = null;
      webglErrorRef.current =
        `Could not start WebGL: ${err instanceof Error ? err.message : String(err)}. ` +
        'The 3D view needs WebGL; everything else in the app works without it.';
      return;
    }
    sceneRef.current = scene;
    scene.updatePositions(sim.positions());
    scene.setCamera(initial.view);
    if (initial.view.centeredOn === 'focus') scene.centerOn(initial.focus);
    else if (initial.view.centeredOn === 'pair') scene.centerOnPair(initial.focus);
    scene.render();

    return () => {
      scene.dispose();
      sceneRef.current = null;
    };
    // `initial` is the boot scenario and never changes for the life of the component, so these
    // dependencies are stable; they are listed because the effect reads them and the lint rule
    // is right to want that stated rather than inferred from a variable's name.
  }, [sim, initial]);

  // Frame loop: advance the clock, then draw.
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let sinceUiUpdate = 0;

    const frame = (now: number) => {
      // Clamp: a backgrounded tab can report an enormous gap on return.
      const elapsedMs = Math.min(Math.max(now - last, 0), 250);
      last = now;

      const result = sim.advance(elapsedMs);
      const positions = sim.positions();
      const scene = sceneRef.current;
      scene?.updatePositions(positions);
      scene?.render();

      // The craft advances every frame, not only on the UI tick: at warp 1000 a 10 Hz readout
      // would leave the marker visibly stepping behind the clock.
      const mission = planRef.current;
      if (scene && mission) {
        const p = missionProgress(mission, sim.simSeconds);
        scene.setTrajectoryMarker(mission.craftId, p.position);
        scene.setTrajectoryProgress(mission.craftId, p.flownSegments);
      }

      sinceUiUpdate += elapsedMs;
      if (sinceUiUpdate >= 100) {
        sinceUiUpdate = 0;
        const distances = new Map<BodyId, number>();
        const sun = positions.get('sun') ?? { x: 0, y: 0, z: 0 };
        for (const [id, p] of positions) {
          distances.set(id, Math.hypot(p.x - sun.x, p.y - sun.y, p.z - sun.z));
        }
        setDisplay({
          simSeconds: sim.simSeconds,
          isoUtc: sim.snapshot().isoUtc,
          throttled: result.throttled,
          distances,
          offscreen: scene ? scene.offScreenBodies() : new Set<BodyId>(),
          webglError: webglErrorRef.current,
          progress: progressFor(mission, sim.simSeconds),
        });
      }

      raf = requestAnimationFrame(frame);
    };

    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [sim]);

  // Keyboard shortcuts. Registered once; all handlers read the live simulation.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)) return;

      /*
       * A focused control has its own keys. Without this, Space on a focused button would both
       * press the button and toggle pause: the button's activation and this handler would fire
       * for the same keystroke. Arrow keys are the same problem for a focused select or radio
       * group. The shortcut still works from anywhere else, including after clicking a button
       * with the mouse, because that leaves focus on the button but a subsequent Space is
       * precisely the user asking to press it.
       */
      if (target && (target.tagName === 'BUTTON' || target.tagName === 'A')) {
        if (e.code === 'Space' || e.key === 'Enter') return;
      }

      if (e.code === 'Space') {
        e.preventDefault();
        togglePause();
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        const idx = WARP_STEPS.indexOf(sim.warp);
        const delta = e.key === 'ArrowRight' ? 1 : -1;
        const next = Math.max(0, Math.min(WARP_STEPS.length - 1, idx + delta));
        handleWarp(WARP_STEPS[next]!);
      } else if (e.key === '+' || e.key === '=') {
        sceneRef.current?.zoom(0.85);
      } else if (e.key === '-' || e.key === '_') {
        sceneRef.current?.zoom(1.18);
      } else if (e.key === 'f' || e.key === 'F') {
        sceneRef.current?.frameBody(selected);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleWarp, togglePause, sim, selected]);

  const selectedInfo = BODY_DISPLAY.find((b) => b.id === selected);
  const selectedDistance = display.distances.get(selected);
  const offScreenNames = BODY_DISPLAY.filter((b) => display.offscreen.has(b.id)).map(
    (b) => b.label,
  );
  const progress = display.progress;

  // True when the current scenario came from the store or a file rather than the catalogue,
  // which is what tells the select to list it as its own option.
  const isBundled = SCENARIOS.some((s) => s.id === scenario.id);

  /**
   * The one line under the scenario picker that explains what the app opened with.
   *
   * Null for a normal first visit and for a browser with no storage: neither is worth a note,
   * and an empty first launch that announces "nothing restored" is noise. Every other outcome is
   * something the user could otherwise mistake for the app losing their work.
   */
  let restoreNote: string | null = null;
  const restore = boot.restore;
  if (restore && !restore.ok) {
    if (restore.reason === 'corrupt') {
      restoreNote =
        'The scenario saved in this browser no longer loaded, so it was discarded and the ' +
        'default opened. The detail was: ' +
        restore.detail.replace(/^the /, '').replace(/; it has been discarded$/, '') +
        '.';
    } else if (restore.reason === 'newer') {
      restoreNote =
        'This browser holds a scenario from a newer build of Periapsis. It has been left ' +
        'untouched and is not being shown or overwritten; the default is open instead.';
    }
  } else if (restore?.ok) {
    restoreNote = 'Opened the scenario saved in this browser. Choosing another replaces it.';
  }

  const handleClearStored = useCallback(() => {
    if (store !== null) clearScenario(store);
  }, [store]);

  return (
    <div className="app">
      {/*
        The first thing in the document and the first thing a keyboard reaches. Without it, a
        keyboard user tabs through a scenario picker, a file panel, a body list, a mission panel
        and a porkchop form before reaching the same controls they could have reached at the
        start: the canvas itself is not a tab stop, and the scene is controlled by keys that work
        from anywhere.
      */}
      <a className="skip-link" href="#sidebar">
        Skip to controls
      </a>
      {/*
        `role="img"` with a label rather than `role="application"`: the canvas is a picture of the
        system, and the same information is in the panels beside it. Announcing it as an
        application would trap screen-reader users in a key-swallowing region with no way out.
        The camera keys are global, so nothing here needs to take focus.
      */}
      <div
        className="viewport"
        ref={viewportRef}
        role="img"
        aria-label="Solar system 3D view. Drag to orbit, scroll to zoom, or use the controls in the sidebar."
      >
        {display.webglError && (
          <div style={{ padding: 24, maxWidth: 520 }}>
            <p className="caveat">{display.webglError}</p>
          </div>
        )}
      </div>

      {/*
        `tabIndex={-1}` so the skip link can actually move focus here. A fragment link only
        moves the *sequential focus starting point* in most browsers, leaving `document.activeElement`
        on the body; with `-1` the browser focuses the region itself, so the next Tab continues
        from the controls rather than from the top of the page. It is not in the tab order, so
        nobody lands here by tabbing past it.
      */}
      <aside className="sidebar" id="sidebar" aria-label="Controls" tabIndex={-1}>
        <div className="brand">
          <h1>Periapsis</h1>
          {/*
            The version comes from `package.json` through a compile-time constant, so the badge
            cannot disagree with the release tag. `v1.0.0` here is the same string the build
            injects - see `vite.config.ts` and `tests/version.test.ts`.
          */}
          <span className="version">v{__APP_VERSION__}</span>
        </div>

        <div className="section">
          <h2>Scenario</h2>
          <select
            aria-label="Scenario"
            value={scenario.id}
            onChange={(e) => {
              const next = SCENARIOS.find((s) => s.id === e.target.value);
              if (next) applyScenario(next);
            }}
          >
            {/*
              A restored or imported scenario can have any id the validator accepts, so it will
              not match an option. React would then render the select with no selection, which
              reads as "the app forgot" while the scenario panel below names the file. The
              current scenario is therefore listed first when it is not one of the bundled ones.
            */}
            {!isBundled && <option value={scenario.id}>{scenario.name} (opened file)</option>}
            {SCENARIOS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <p className="hint">{scenario.description}</p>
          <p className="hint" data-testid="scenario-epoch">
            Epoch {scenario.epochUtc.replace('T', ' ').replace('Z', ' UTC')}
          </p>
          {/*
            The restore notice. A first visit says nothing; a restored scenario says where it
            came from, because an app that opens somewhere other than its default without
            explaining is confusing. A discarded or preserved entry is reported for the same
            reason: silence would look like the save never happened.
          */}
          {restoreNote && (
            <p className="hint" data-testid="scenario-restore">
              {restoreNote}
            </p>
          )}
        </div>

        <ScenarioFilePanel
          scenario={scenario}
          onImport={applyScenario}
          store={store}
          onClear={handleClearStored}
        />

        <div className="section">
          <h2>Selected</h2>
          <dl className="readout">
            <dt>Body</dt>
            <dd style={{ color: selectedInfo?.color }}>{selectedInfo?.label ?? '--'}</dd>
            <dt>Distance from Sun</dt>
            <dd>
              {selectedDistance === undefined || selected === 'sun'
                ? '--'
                : `${(selectedDistance / AU_M).toFixed(5)} AU`}
            </dd>
          </dl>
        </div>

        {plan && <MissionPanel plan={plan} progress={progress} testid="mission" />}

        {plan?.groundTrack && (
          <GroundTrackPanel
            track={plan.groundTrack}
            current={progress?.groundPoint ?? null}
            testid="ground-track"
          />
        )}

        <PorkchopPanel
          epochUtc={scenario.epochUtc}
          onPlanDeparture={handlePlanDeparture}
          onGrid={(grid) => {
            lastGridRef.current = grid;
          }}
          departureUnavailableReason={
            mission
              ? null
              : 'This scenario has no spacecraft, so there is nothing to plan a departure from. ' +
                'Switch to a mission scenario to use this.'
          }
          departureIssue={departureIssue}
          departureNote={departureNote}
        />

        <div className="section">
          <h2>Bodies</h2>
          {/*
            A list of real buttons rather than `div role="button"` with a keydown handler: Enter,
            Space, focus order and the focus ring all come from the element, so none of them can
            drift out of sync with the app's own idea of what a button is. `aria-current` marks
            the body on screen; it is "which one is being shown", not "which one is pressed", and
            there is exactly one at a time.
          */}
          <ul className="body-list">
            {BODY_DISPLAY.map((b) => {
              const d = display.distances.get(b.id);
              const isCurrent = b.id === selected;
              return (
                <li key={b.id}>
                  <button
                    type="button"
                    className={`body-row${isCurrent ? ' selected' : ''}`}
                    aria-current={isCurrent ? 'true' : undefined}
                    onClick={() => {
                      setSelected(b.id);
                      sceneRef.current?.frameBody(b.id);
                    }}
                  >
                    <span className="swatch" style={{ background: b.color }} aria-hidden="true" />
                    <span className="name">{b.label}</span>
                    <span className="dist">
                      {d === undefined || b.id === 'sun' ? '' : `${(d / AU_M).toFixed(3)} AU`}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>

        <div className="section">
          <h2>View</h2>
          <div className="row">
            <button onClick={() => sceneRef.current?.frameAll()} title="Reset the camera">
              Reset view
            </button>
            <button onClick={() => sceneRef.current?.frameBody(selected)}>Frame selection</button>
          </div>
          <div className="row" style={{ marginTop: 6 }}>
            <button
              className={scaleMode === 'linear' ? 'active' : ''}
              onClick={() => handleScaleMode('linear')}
              title="True distances. Only the inner system fits on screen."
            >
              True scale
            </button>
            <button
              className={scaleMode === 'compressed' ? 'active' : ''}
              onClick={() => handleScaleMode('compressed')}
              title="Logarithmic radius: the whole system on screen, not to scale."
            >
              Whole system
            </button>
          </div>
          <p className="hint">
            Drag to orbit, scroll to zoom. Space pauses, arrow keys change speed, F frames the
            selected body.
          </p>{' '}
          <p className="hint" data-testid="offscreen-note">
            {offScreenNames.length === 0
              ? 'Every body is on screen.'
              : `Off screen at this zoom: ${offScreenNames.join(', ')}.`}
          </p>
        </div>

        <div className="section">
          <h2>Accuracy</h2>
          <p className="caveat">
            Body positions use JPL's approximate Keplerian elements, not a full ephemeris. Mars
            carries up to ~25,000 km of error, so transfer delta-v derived from this view is
            indicative, not operational.
          </p>
          <p className="caveat">
            Distances between bodies are drawn to scale only in True scale mode, which fits the
            inner solar system. Whole system mode uses a logarithmic radius: ordering and angles
            stay exact, sizes and distances do not. Body radii are cube-root compressed in both
            modes so every planet stays visible.
          </p>
        </div>
      </aside>

      <div className="timebar">
        <span className="sim-time">{display.isoUtc.replace('T', ' ').replace('Z', ' UTC')}</span>
        <span className="speed-readout">
          {formatDuration(display.simSeconds)}
          {warp === 0 && <span className="paused-badge">paused</span>}
        </span>
        <span className="row">
          <button onClick={togglePause} title="Pause or resume (Space)">
            {warp === 0 ? 'Play' : 'Pause'}
          </button>
          {WARP_STEPS.filter((w) => w !== 0).map((w) => (
            <button
              key={w}
              className={warp === w ? 'active' : ''}
              onClick={() => handleWarp(w)}
              title={`${w} simulated seconds per real second`}
            >
              {formatWarp(w)}
            </button>
          ))}
        </span>
        {display.throttled && (
          <span className="throttle-badge" title="Step size coarsened to fit the frame budget">
            coarse steps
          </span>
        )}
        {/*
          Polite, because the clock changes constantly and an assertive region would interrupt a
          screen reader mid-sentence on every tick. It reports only the pause state and the warp
          step, not the simulated time: a time that updates ten times a second is noise, and a
          user who wants the time can read the visible readout. Changing warp is a deliberate
          action, so it is worth announcing.
        */}
        <span
          className="visually-hidden"
          role="status"
          aria-live="polite"
          data-testid="clock-status"
        >
          {warp === 0 ? 'Paused' : `Running at ${formatWarp(warp)} times real time`}
        </span>
        <span className="hint" style={{ marginLeft: 'auto' }}>
          offline · no data leaves this machine
        </span>
      </div>
    </div>
  );
}

/** Compact warp label: 1, 10, 100, 1k, 10k, 100k, 1M, 10M. */
function formatWarp(w: number): string {
  if (w >= 1e6) return `${w / 1e6}M`;
  if (w >= 1e3) return `${w / 1e3}k`;
  return String(w);
}
