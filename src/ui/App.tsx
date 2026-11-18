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

import { useCallback, useEffect, useRef, useState } from 'react';
import { Simulation } from '../sim/simulation.js';
import { formatDuration, WARP_STEPS, type Warp } from '../sim/clock.js';
import { SolarSystemScene } from '../render/scene.js';
import type { RadialMode } from '../render/scale.js';
import { BODY_DISPLAY } from './bodyDisplay.js';
import type { BodyId } from '../core/ephemeris/solarSystem.js';
import { AU_M } from '../core/constants.js';
import { SCENARIOS, defaultScenario } from '../scenarios/catalogue.js';
import type { Scenario } from '../scenarios/types.js';

const INITIAL_SCENARIO = defaultScenario();

interface DisplayState {
  readonly simSeconds: number;
  readonly isoUtc: string;
  readonly throttled: boolean;
  readonly distances: ReadonlyMap<BodyId, number>;
  /** Bodies whose centre is outside the camera frustum, so the user knows why they are missing. */
  readonly offscreen: ReadonlySet<BodyId>;
  /** Set when WebGL could not start; the app still runs, it just cannot draw. */
  readonly webglError: string | null;
}

const INITIAL_DISPLAY: DisplayState = {
  simSeconds: 0,
  isoUtc: INITIAL_SCENARIO.epochUtc,
  throttled: false,
  distances: new Map(),
  offscreen: new Set<BodyId>(),
  webglError: null,
};

export function App(): React.JSX.Element {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<SolarSystemScene | null>(null);
  // Created once. Never replaced, only mutated through event handlers.
  const [sim] = useState(
    () => new Simulation(INITIAL_SCENARIO.epochUtc, INITIAL_SCENARIO.startWarp),
  );

  const [scenario, setScenario] = useState<Scenario>(INITIAL_SCENARIO);
  const [selected, setSelected] = useState<BodyId>(INITIAL_SCENARIO.focus);
  const [warp, setWarpState] = useState<Warp>(INITIAL_SCENARIO.startWarp);
  const [scaleMode, setScaleMode] = useState<RadialMode>(INITIAL_SCENARIO.view.radialMode);
  const [display, setDisplay] = useState<DisplayState>(INITIAL_DISPLAY);

  // Last non-paused warp, so Play resumes at the speed the user was using. Updated only
  // from event handlers, never from an effect.
  const resumeWarpRef = useRef<Warp>(INITIAL_SCENARIO.startWarp);

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

      const scene = sceneRef.current;
      if (!scene) return;
      scene.setRadialMode(next.view.radialMode);
      scene.updatePositions(sim.positions());
      scene.setCamera(next.view);
      if (next.view.centeredOn === 'focus') scene.centerOn(next.focus);
    },
    [sim],
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
    },
    [sim],
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
    scene.setCamera(INITIAL_SCENARIO.view);
    if (INITIAL_SCENARIO.view.centeredOn === 'focus') scene.centerOn(INITIAL_SCENARIO.focus);
    scene.render();

    return () => {
      scene.dispose();
      sceneRef.current = null;
    };
  }, [sim]);

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

  return (
    <div className="app">
      <div className="viewport" ref={viewportRef} aria-label="Solar system 3D view">
        {display.webglError && (
          <div style={{ padding: 24, maxWidth: 520 }}>
            <p className="caveat">{display.webglError}</p>
          </div>
        )}
      </div>

      <aside className="sidebar">
        <div className="brand">
          <h1>Periapsis</h1>
          <span className="version">v0.1.0-dev</span>
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
        </div>

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

        <div className="section">
          <h2>Bodies</h2>
          <div className="body-list">
            {BODY_DISPLAY.map((b) => {
              const d = display.distances.get(b.id);
              const select = () => {
                setSelected(b.id);
                sceneRef.current?.frameBody(b.id);
              };
              return (
                <div
                  key={b.id}
                  className={`body-row${b.id === selected ? ' selected' : ''}`}
                  onClick={select}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      select();
                    }
                  }}
                >
                  <span className="swatch" style={{ background: b.color }} />
                  <span className="name">{b.label}</span>
                  <span className="dist">
                    {d === undefined || b.id === 'sun' ? '' : `${(d / AU_M).toFixed(3)} AU`}
                  </span>
                </div>
              );
            })}
          </div>
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
          </p>
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
