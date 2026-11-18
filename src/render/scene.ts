/**
 * Three.js scene for the solar system view.
 *
 * This module owns every Three.js object and is the only place that touches WebGL. It has
 * no knowledge of React or of the simulation: `update()` is handed body positions and does
 * nothing but draw them. That separation is what lets the physics stay pure and the scene
 * be reasoned about on its own.
 *
 * Bodies are drawn with display radii (see scale.ts) while their positions stay linear in
 * real distance, so the layout is positionally honest and dimensionally compressed.
 */

import * as THREE from 'three';
import { BODIES, type BodyId } from '../core/ephemeris/solarSystem.js';
import { RADIUS } from '../core/constants.js';
import {
  displayRadiusFor,
  scalePosition,
  radialUnits,
  UNITS_PER_M,
  type RadialMode,
} from './scale.js';
import { AU_M } from '../core/constants.js';

export interface BodyVisual {
  readonly id: BodyId;
  readonly mesh: THREE.Mesh;
  readonly label: THREE.Sprite;
  readonly radiusUnits: number;
}

/**
 * A trajectory to draw, already converted to body-centred scene units.
 *
 * Conversion and interpolation happen in `trajectoryLines.ts` because they are pure
 * functions worth testing on their own; this module only owns the Three.js objects.
 * `centralBody` identifies which body's scene position the line hangs off, so it follows
 * that body as it moves.
 *
 * Points are drawn as disjoint vertex pairs in time order, so the flown part is always a
 * prefix and highlighting it is one `drawRange` call.
 */
export interface SceneTrajectory {
  readonly id: string;
  readonly centralBody: BodyId;
  /** Vertex pairs in body-centred scene units, six floats per segment. */
  readonly positions: Float32Array;
  readonly color: number;
  /** Segments ending at or before this many entries are drawn dimmer, as already flown. */
  readonly flownSegments: number;
}

/** One drawn trajectory: a single segment set plus the craft marker. */
interface TrajectoryVisual {
  readonly centralBody: BodyId;
  readonly group: THREE.Group;
  readonly future: THREE.LineSegments;
  readonly flown: THREE.LineSegments;
  readonly marker: THREE.Mesh;
  /** Held explicitly so disposal does not have to narrow `Object3D.material`'s union type. */
  readonly materials: readonly THREE.Material[];
}

export interface SceneCallbacks {
  /** Called with the body under the pointer, or null when nothing is hovered. */
  readonly onHover?: (id: BodyId | null) => void;
  readonly onSelect?: (id: BodyId) => void;
}

/** Flat colour per body, tuned for legibility against a dark background. */
const BODY_COLORS: Record<BodyId, number> = {
  sun: 0xffdd55,
  mercury: 0x9a8f88,
  venus: 0xd9b382,
  earth: 0x4c8fd6,
  moon: 0xbfbfbf,
  mars: 0xc1440e,
  jupiter: 0xd8a172,
  saturn: 0xe3cf9a,
  uranus: 0x7fd4d8,
  neptune: 0x4b6fd6,
};

export class SolarSystemScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly bodies = new Map<BodyId, BodyVisual>();

  private readonly container: HTMLElement;
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly callbacks: SceneCallbacks;
  private readonly sunLight: THREE.PointLight;

  private frameId = 0;
  private disposed = false;
  private orbitTarget = new THREE.Vector3(0, 0, 0);
  private radialMode: RadialMode = 'linear';
  /** Latest scene-space position of each body, for framing and picking. */
  private readonly scenePositions = new Map<BodyId, THREE.Vector3>();
  private readonly orbitRings: THREE.Line[] = [];
  /** Drawn trajectories, keyed by id. */
  private readonly trajectories = new Map<string, TrajectoryVisual>();
  /** Visible trajectory marker geometry, shared by every craft. */
  private readonly craftGeometry = new THREE.SphereGeometry(1, 12, 8);
  /** Pointer-drag state, or null when not dragging. */
  private drag: { lastX: number; lastY: number; moved: number } | null = null;
  /** Set after a drag so the trailing click does not reselect. */
  private suppressNextClick = false;

  /** Camera orbit state, in spherical coordinates around `orbitTarget`. */
  private azimuth = 0.6;
  private elevation = 1.05;
  private distance = 260;

  constructor(container: HTMLElement, callbacks: SceneCallbacks = {}) {
    this.container = container;
    this.callbacks = callbacks;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x05060a, 1);
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 20000);

    // A single point light at the Sun plus a little ambient, so the night side is not pure
    // black and geometry stays readable without a full lighting rig.
    this.sunLight = new THREE.PointLight(0xffffff, 3.2, 0, 0.0);
    this.scene.add(this.sunLight);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.16));
    this.scene.add(new THREE.AxesHelper());

    this.buildBodies();
    this.buildStarfield();
    this.buildOrbitRings();
    this.resize();
    this.updateCamera();

    this.renderer.domElement.addEventListener('pointermove', this.handlePointerMove);
    this.renderer.domElement.addEventListener('pointerdown', this.handlePointerDown);
    this.renderer.domElement.addEventListener('pointerup', this.handlePointerUp);
    this.renderer.domElement.addEventListener('pointercancel', this.handlePointerUp);
    this.renderer.domElement.addEventListener('click', this.handleClick);
    this.renderer.domElement.addEventListener('wheel', this.handleWheel, { passive: false });
    window.addEventListener('resize', this.resize);
  }

  private buildBodies(): void {
    const sphereGeometry = new THREE.SphereGeometry(1, 32, 24);

    for (const [id, def] of Object.entries(BODIES) as [BodyId, (typeof BODIES)[BodyId]][]) {
      const radiusUnits = displayRadiusFor(id, RADIUS[id]);
      const material = new THREE.MeshStandardMaterial({
        color: BODY_COLORS[id],
        roughness: 0.85,
        metalness: 0.0,
        // The Sun supplies its own light.
        emissive: id === 'sun' ? 0xffcc44 : 0x000000,
        emissiveIntensity: id === 'sun' ? 1.0 : 0,
      });
      const mesh = new THREE.Mesh(sphereGeometry, material);
      mesh.scale.setScalar(radiusUnits);
      mesh.userData.bodyId = id;
      this.scene.add(mesh);

      const label = this.makeLabel(def.name);
      this.scene.add(label);

      this.bodies.set(id, { id, mesh, label, radiusUnits });
    }
  }

  private makeLabel(text: string): THREE.Sprite {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    canvas.width = 256;
    canvas.height = 64;
    if (ctx) {
      ctx.font = 'bold 30px system-ui, sans-serif';
      ctx.fillStyle = 'rgba(220,230,245,0.92)';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      // NOTE: fillText only. Imported or user-supplied strings are never interpolated into
      // markup anywhere in this app, and the canvas API is not an injection surface.
      ctx.fillText(text, 128, 32);
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      depthTest: false,
    });
    const sprite = new THREE.Sprite(material);
    sprite.scale.set(14, 3.5, 1);
    return sprite;
  }

  private buildStarfield(): void {
    // A deterministic point cloud: a fixed lattice hash, not Math.random, so the sky is
    // identical on every load and in every screenshot.
    const count = 1800;
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const u = hash01(i * 3 + 1);
      const v = hash01(i * 3 + 2);
      const w = hash01(i * 3 + 3);
      const theta = 2 * Math.PI * u;
      const phi = Math.acos(2 * v - 1);
      const r = 6000 + 1500 * w;
      positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = r * Math.cos(phi);
      positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const material = new THREE.PointsMaterial({
      color: 0xc8d4e8,
      size: 7,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.75,
    });
    this.scene.add(new THREE.Points(geometry, material));
  }

  /**
   * Orbit rings for the planets.
   *
   * A ring is rebuilt whenever the radial mapping changes, because its radius is the mapped
   * semi-major axis. Each ring is a circle in the ecliptic plane, which is exact for the
   * near-circular planetary orbits this view is for; eccentricity is visible in the body's
   * motion rather than in a wobbling ring.
   */
  private buildOrbitRings(): void {
    for (const ring of this.orbitRings) {
      this.scene.remove(ring);
      ring.geometry.dispose();
      (ring.material as THREE.Material).dispose();
    }
    this.orbitRings.length = 0;

    const planetData: { id: BodyId; a: number }[] = [
      { id: 'mercury', a: 0.387 * AU_M },
      { id: 'venus', a: 0.723 * AU_M },
      { id: 'earth', a: 1.0 * AU_M },
      { id: 'mars', a: 1.524 * AU_M },
      { id: 'jupiter', a: 5.203 * AU_M },
      { id: 'saturn', a: 9.537 * AU_M },
      { id: 'uranus', a: 19.19 * AU_M },
      { id: 'neptune', a: 30.07 * AU_M },
    ];

    for (const { id, a } of planetData) {
      const radius = radialUnits(a, this.radialMode);
      const points: THREE.Vector3[] = [];
      const segments = 160;
      for (let i = 0; i <= segments; i++) {
        const t = (i / segments) * Math.PI * 2;
        points.push(new THREE.Vector3(radius * Math.cos(t), 0, radius * Math.sin(t)));
      }
      const geometry = new THREE.BufferGeometry().setFromPoints(points);
      const material = new THREE.LineBasicMaterial({
        color: BODY_COLORS[id],
        transparent: true,
        opacity: 0.22,
      });
      const ring = new THREE.Line(geometry, material);
      ring.userData.orbitFor = id;
      this.scene.add(ring);
      this.orbitRings.push(ring);
    }
  }

  /** Shows or hides the planet orbit rings. */
  setOrbitsVisible(visible: boolean): void {
    for (const ring of this.orbitRings) ring.visible = visible;
  }

  /** Positions every body from physics-frame metres. */
  updatePositions(positions: ReadonlyMap<BodyId, { x: number; y: number; z: number }>): void {
    for (const [id, visual] of this.bodies) {
      const p = positions.get(id);
      if (!p) continue;
      const [x, y, z] = scalePosition(p.x, p.y, p.z, this.radialMode);
      visual.mesh.position.set(x, y, z);

      // Labels sit just above each body, offset in scene units scaled to the body size.
      const labelOffset = visual.radiusUnits + 2.2;
      visual.label.position.set(x, y + labelOffset, z);

      if (id === 'sun') this.sunLight.position.set(x, y, z);
      // Keep a body's scene position for framing.
      this.scenePositions.set(id, new THREE.Vector3(x, y, z));
    }
    // Trajectories hang off their central body's position, so they move when it does.
    this.syncTrajectoryPositions();
  }

  /**
   * Replaces the drawn set of trajectories.
   *
   * Geometry rebuilds on every call: a trajectory refresh follows a scenario switch or a UI
   * refresh, not a frame, and rebuilding is far simpler than diffing vertex counts.
   */
  setTrajectories(trajectories: readonly SceneTrajectory[]): void {
    const seen = new Set<string>();

    for (const t of trajectories) {
      seen.add(t.id);
      const existing = this.trajectories.get(t.id);
      if (existing) {
        this.disposeTrajectory(existing);
        this.trajectories.delete(t.id);
      }
      this.trajectories.set(t.id, this.buildTrajectory(t));
    }

    for (const [id, visual] of [...this.trajectories]) {
      if (seen.has(id)) continue;
      this.disposeTrajectory(visual);
      this.trajectories.delete(id);
    }
    this.syncTrajectoryPositions();
  }

  private buildTrajectory(t: SceneTrajectory): TrajectoryVisual {
    const group = new THREE.Group();
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(t.positions, 3));

    // Two objects sharing one geometry, split by drawRange: the flown part is drawn dimmer
    // so the craft's current position reads at a glance, and the split costs no extra vertex
    // data. Both must be transparent with depthWrite off, or the line hides the planets.
    const futureMaterial = new THREE.LineBasicMaterial({
      color: t.color,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
    });
    const flownMaterial = new THREE.LineBasicMaterial({
      color: new THREE.Color(t.color).multiplyScalar(0.42),
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
    });

    const future = new THREE.LineSegments(geometry, futureMaterial);
    const flown = new THREE.LineSegments(geometry, flownMaterial);
    // A trajectory is an overlay, not scenery: without this a line passing behind a planet
    // disappears, which reads as a gap rather than as occlusion.
    future.renderOrder = 2;
    flown.renderOrder = 2;
    group.add(flown);
    group.add(future);

    const markerMaterial = new THREE.MeshBasicMaterial({ color: t.color });
    const marker = new THREE.Mesh(this.craftGeometry, markerMaterial);
    // Fixed screen size for the craft: it is a symbol, not a body, and a 5 m satellite
    // scaled honestly would be invisible.
    marker.scale.setScalar(0.9);
    marker.renderOrder = 3;
    marker.visible = false;
    group.add(marker);

    this.scene.add(group);
    const visual: TrajectoryVisual = {
      centralBody: t.centralBody,
      group,
      future,
      flown,
      marker,
      materials: [futureMaterial, flownMaterial, markerMaterial],
    };
    this.applyFlownCount(visual, t.flownSegments);
    return visual;
  }

  /** Splits the shared geometry at a segment boundary: `drawRange` counts vertices. */
  private applyFlownCount(visual: TrajectoryVisual, flownSegments: number): void {
    const attribute = visual.future.geometry.getAttribute('position');
    const totalVertices = attribute.count;
    const flownVertices = Math.min(totalVertices, Math.max(0, flownSegments) * 2);
    visual.flown.geometry.setDrawRange(0, flownVertices);
    visual.future.geometry.setDrawRange(flownVertices, totalVertices - flownVertices);
  }

  /** Updates only the flown/future split, without rebuilding geometry. */
  setTrajectoryProgress(id: string, flownSegments: number): void {
    const visual = this.trajectories.get(id);
    if (visual) this.applyFlownCount(visual, flownSegments);
  }

  /**
   * Moves a trajectory's craft marker to a body-centred scene position, or hides it.
   *
   * Separate from `setTrajectories` because the marker moves every UI tick while the path
   * changes only when a node or the horizon changes.
   */
  setTrajectoryMarker(id: string, position: { x: number; y: number; z: number } | null): void {
    const marker = this.trajectories.get(id)?.marker;
    if (!marker) return;
    if (!position) {
      marker.visible = false;
      return;
    }
    marker.visible = true;
    marker.position.set(position.x, position.y, position.z);
  }

  /**
   * Places every trajectory at its central body's current scene position.
   *
   * One group per trajectory, positioned as a whole, so moving a body is a single
   * `position.set` rather than rewriting thousands of vertices per frame.
   */
  private syncTrajectoryPositions(): void {
    for (const visual of this.trajectories.values()) {
      const anchor = this.scenePositions.get(visual.centralBody);
      if (anchor) visual.group.position.copy(anchor);
    }
  }

  private disposeTrajectory(visual: TrajectoryVisual): void {
    this.scene.remove(visual.group);
    // Both line objects share one geometry, so it is disposed once. The marker geometry is
    // shared between crafts and outlives every trajectory.
    visual.future.geometry.dispose();
    for (const material of visual.materials) material.dispose();
  }

  /** Switches between the honest linear layout and the whole-system compressed one. */
  setRadialMode(mode: RadialMode): void {
    if (mode === this.radialMode) return;
    this.radialMode = mode;
    // Ring radii are the mapped semi-major axes, so they must be rebuilt.
    this.buildOrbitRings();
  }

  /**
   * Restores a stored camera framing.
   *
   * Camera only: the radial mode is applied by the caller before positions are pushed,
   * because it changes what a scene-unit distance means. Doing both here would either aim
   * the camera at a layout that has not been applied yet, or reposition bodies with the old
   * mapping.
   */
  setCamera(view: {
    readonly azimuthRad: number;
    readonly elevationRad: number;
    readonly distanceUnits: number;
  }): void {
    this.azimuth = view.azimuthRad;
    this.elevation = clamp(view.elevationRad, -1.5, 1.5);
    this.distance = clamp(view.distanceUnits, 0.5, 4000);
    this.updateCamera();
  }

  /** Points the camera at a body's current scene position, keeping the stored framing. */
  centerOn(id: BodyId): void {
    const pos = this.scenePositions.get(id);
    if (!pos) return;
    this.orbitTarget.copy(pos);
    this.updateCamera();
  }

  /** Current camera framing, so the UI can save it back into a scenario. */
  getCamera(): { azimuthRad: number; elevationRad: number; distanceUnits: number } {
    return {
      azimuthRad: this.azimuth,
      elevationRad: this.elevation,
      distanceUnits: this.distance,
    };
  }

  get scaleMode(): RadialMode {
    return this.radialMode;
  }

  /** Hides bodies below a display-size threshold, so labels do not crowd at wide zoom. */
  setLabelVisibility(visible: boolean): void {
    for (const visual of this.bodies.values()) visual.label.visible = visible;
  }

  setBodyVisibility(id: BodyId, visible: boolean): void {
    const visual = this.bodies.get(id);
    if (!visual) return;
    visual.mesh.visible = visible;
    visual.label.visible = visible;
  }

  /**
   * Bodies currently outside the camera frustum.
   *
   * True-scale layout cannot fit the outer system at any sane camera distance, so the UI
   * says which bodies are off screen instead of leaving the user to guess. A body counts as
   * visible when its centre projects inside the viewport; that is what the user can click.
   */
  offScreenBodies(): Set<BodyId> {
    const off = new Set<BodyId>();
    const v = new THREE.Vector3();
    for (const [id, visual] of this.bodies) {
      if (!visual.mesh.visible) continue;
      const p = this.scenePositions.get(id);
      if (!p) continue;
      v.copy(p).project(this.camera);
      if (!(Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1 && v.z <= 1 && v.z >= -1)) off.add(id);
    }
    return off;
  }

  /** Frames the whole system, at a distance that depends on the radial mapping. */
  frameAll(): void {
    this.orbitTarget.set(0, 0, 0);
    // Linear: the visible extent must cover the inner system. Compressed: everything fits
    // inside ~210 units, so pull back a little further.
    this.distance = this.radialMode === 'linear' ? 320 : 560;
    this.updateCamera();
  }

  /** Frames one body, keeping its surroundings visible. */
  frameBody(id: BodyId): void {
    const visual = this.bodies.get(id);
    const pos = this.scenePositions.get(id);
    if (!visual || !pos) return;
    this.orbitTarget.copy(pos);
    this.distance = Math.max(12, visual.radiusUnits * 14);
    this.updateCamera();
  }

  /** Camera orbit input, called from the UI layer. */
  orbit(deltaAzimuth: number, deltaElevation: number): void {
    this.azimuth += deltaAzimuth;
    this.elevation = clamp(this.elevation + deltaElevation, -1.5, 1.5);
    this.updateCamera();
  }

  zoom(factor: number): void {
    this.distance = clamp(this.distance * factor, 0.5, 4000);
    this.updateCamera();
  }

  private updateCamera(): void {
    const sinE = Math.sin(this.elevation);
    const cosE = Math.cos(this.elevation);
    this.camera.position.set(
      this.orbitTarget.x + this.distance * cosE * Math.cos(this.azimuth),
      this.orbitTarget.y + this.distance * sinE,
      this.orbitTarget.z + this.distance * cosE * Math.sin(this.azimuth),
    );
    this.camera.lookAt(this.orbitTarget);
  }

  private handlePointerMove = (event: PointerEvent): void => {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    // While dragging, orbit the camera instead of probing for a hover.
    if (this.drag) {
      const dx = event.clientX - this.drag.lastX;
      const dy = event.clientY - this.drag.lastY;
      this.drag.lastX = event.clientX;
      this.drag.lastY = event.clientY;
      this.drag.moved += Math.abs(dx) + Math.abs(dy);
      this.orbit(-dx * 0.006, dy * 0.006);
      return;
    }

    const hit = this.pick();
    this.callbacks.onHover?.(hit);
    this.renderer.domElement.style.cursor = hit ? 'pointer' : 'default';
  };

  private handlePointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    this.drag = { lastX: event.clientX, lastY: event.clientY, moved: 0 };
    this.renderer.domElement.setPointerCapture(event.pointerId);
  };

  private handlePointerUp = (event: PointerEvent): void => {
    if (!this.drag) return;
    const wasDrag = this.drag.moved > 4;
    this.drag = null;
    if (this.renderer.domElement.hasPointerCapture(event.pointerId)) {
      this.renderer.domElement.releasePointerCapture(event.pointerId);
    }
    // A drag must not also count as a click, or orbiting would constantly reselect.
    if (wasDrag) this.suppressNextClick = true;
  };

  private handleWheel = (event: WheelEvent): void => {
    event.preventDefault();
    // Exponential zoom: a constant number of scroll units gives a constant perceived change,
    // unlike a linear step which crawls when zoomed in and jumps when zoomed out.
    this.zoom(Math.exp(Math.sign(event.deltaY) * 0.12));
  };

  private handleClick = (): void => {
    if (this.suppressNextClick) {
      this.suppressNextClick = false;
      return;
    }
    const hit = this.pick();
    if (hit) this.callbacks.onSelect?.(hit);
  };

  private pick(): BodyId | null {
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const meshes = [...this.bodies.values()].filter((v) => v.mesh.visible).map((v) => v.mesh);
    const hits = this.raycaster.intersectObjects(meshes, false);
    const first = hits[0];
    if (!first) return null;
    const id = first.object.userData.bodyId;
    return typeof id === 'string' ? (id as BodyId) : null;
  }

  resize = (): void => {
    const width = this.container.clientWidth || 1;
    const height = this.container.clientHeight || 1;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  };

  /** Renders one frame. The caller owns timing; this only draws. */
  render(): void {
    if (this.disposed) return;
    this.renderer.render(this.scene, this.camera);
  }

  /** Runs a render loop, used only when the app is not driving frames itself. */
  start(): void {
    const loop = () => {
      if (this.disposed) return;
      this.renderer.render(this.scene, this.camera);
      this.frameId = requestAnimationFrame(loop);
    };
    this.frameId = requestAnimationFrame(loop);
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frameId);
    window.removeEventListener('resize', this.resize);
    this.renderer.domElement.removeEventListener('pointermove', this.handlePointerMove);
    this.renderer.domElement.removeEventListener('pointerdown', this.handlePointerDown);
    this.renderer.domElement.removeEventListener('pointerup', this.handlePointerUp);
    this.renderer.domElement.removeEventListener('pointercancel', this.handlePointerUp);
    this.renderer.domElement.removeEventListener('click', this.handleClick);
    this.renderer.domElement.removeEventListener('wheel', this.handleWheel);

    // Drawn trajectories own a line geometry and three materials that the mesh traversal below
    // would miss: `Line`/`LineSegments` are not `Mesh`, so they get their own pass.
    for (const visual of this.trajectories.values()) this.disposeTrajectory(visual);
    this.trajectories.clear();

    this.scene.traverse((obj) => {
      if (obj instanceof THREE.Mesh || obj instanceof THREE.Points) {
        obj.geometry.dispose();
        const material = obj.material;
        if (Array.isArray(material)) material.forEach((m) => m.dispose());
        else material.dispose();
      } else if (obj instanceof THREE.Sprite) {
        obj.material.map?.dispose();
        obj.material.dispose();
      }
    });
    this.craftGeometry.dispose();

    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  /** Exposes the scene-unit conversion for the UI's readouts. */
  static unitsPerMetre(): number {
    return UNITS_PER_M;
  }
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** Deterministic pseudo-random in [0,1) from an integer, for the starfield. */
function hash01(n: number): number {
  let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}
