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
  parentRelativeOffset,
  scalePosition,
  radialUnits,
  UNITS_PER_M,
  type RadialMode,
} from './scale.js';
import { generateClouds, generateRings, generateSurface, textureSize } from './bodyTextures.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
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
  readonly future: LineSegments2;
  readonly flown: LineSegments2;
  readonly marker: THREE.Mesh;
  /** Held explicitly so disposal does not have to narrow `Object3D.material`'s union type. */
  readonly materials: readonly THREE.Material[];
}

export interface SceneCallbacks {
  /** Called with the body under the pointer, or null when nothing is hovered. */
  readonly onHover?: (id: BodyId | null) => void;
  readonly onSelect?: (id: BodyId) => void;
}

/** Flat colour per body, used for orbit rings, labels and the inspector swatch. */
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

/** Rim-glow tint per body, chosen to match each atmosphere rather than its surface. */
const ATMOSPHERE_COLORS: Partial<Record<BodyId, number>> = {
  venus: 0xffe4a8,
  mars: 0xff9a6a,
  jupiter: 0xffd6a0,
  saturn: 0xffe9b8,
  uranus: 0xa8f0f4,
  neptune: 0x6f9bff,
  earth: 0x7fb4ff,
};

/**
 * Surface spin in radians per second of *wall* time.
 *
 * Ordered by real rotation rate so Jupiter visibly outruns Venus, but all far too slow to be
 * physically accurate — the point is legibility, not simulation. A body not listed turns at
 * the default.
 */
const SPIN_RATES: Partial<Record<BodyId, number>> = {
  sun: 0.012,
  mercury: 0.004,
  venus: 0.002,
  earth: 0.05,
  moon: 0.004,
  mars: 0.048,
  jupiter: 0.13,
  saturn: 0.11,
  uranus: 0.07,
  neptune: 0.068,
};

/**
 * A soft radial glow sprite: bright at the centre, fading to fully transparent at the edge.
 *
 * `BackSide` shells are the usual shortcut for a glow and they look wrong: a shell renders an
 * unlit surface whose inner face is visible as a hard-edged disc with a *dark* rim against the
 * background. A radial alpha ramp has no edge to see, so it reads as light rather than as a
 * second sphere. Used for the Sun's corona and the atmospheric halos.
 */
function makeGlowTexture(): THREE.DataTexture {
  const size = 128;
  const data = new Uint8ClampedArray(size * size * 4);
  const centre = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - centre) / centre;
      const dy = (y - centre) / centre;
      const r = Math.sqrt(dx * dx + dy * dy);
      // Cubic falloff: solid in the middle, and gone before the square's corners.
      const t = Math.max(0, 1 - r);
      const alpha = t * t * t;
      const offset = (y * size + x) * 4;
      data[offset] = 255;
      data[offset + 1] = 255;
      data[offset + 2] = 255;
      data[offset + 3] = alpha * 255;
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

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
  /** Cloud shells, halos, the corona and Saturn's rings, keyed by body or role. */
  private readonly atmospheres = new Map<string, THREE.Object3D>();
  /** One shared radial glow texture, generated once and reused by every halo. */
  private readonly glowTexture = makeGlowTexture();
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
    const sphereGeometry = new THREE.SphereGeometry(1, 64, 48);

    for (const [id, def] of Object.entries(BODIES) as [BodyId, (typeof BODIES)[BodyId]][]) {
      const radiusUnits = displayRadiusFor(id, RADIUS[id]);
      const size = textureSize(id, radiusUnits);
      const map = generateSurface(id, size);

      const material = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        map,
        // A flat colour multiplied over the map would dull it; the texture carries the colour.
        roughness: id === 'sun' ? 1 : 0.92,
        metalness: 0.0,
        // The Sun supplies its own light.
        emissive: id === 'sun' ? 0xfff0d0 : 0x000000,
        emissiveMap: id === 'sun' ? map : null,
        emissiveIntensity: id === 'sun' ? 1.35 : 0,
      });
      const mesh = new THREE.Mesh(sphereGeometry, material);
      mesh.scale.setScalar(radiusUnits);
      mesh.userData.bodyId = id;
      this.scene.add(mesh);

      // Earth gets a separate, slightly larger cloud shell that rotates a little faster.
      if (id === 'earth') {
        const cloudMap = generateClouds(size);
        const cloudMaterial = new THREE.MeshStandardMaterial({
          map: cloudMap,
          transparent: true,
          opacity: 0.85,
          depthWrite: false,
          roughness: 1,
        });
        const clouds = new THREE.Mesh(sphereGeometry, cloudMaterial);
        clouds.scale.setScalar(radiusUnits * 1.012);
        clouds.userData.cloudShell = true;
        this.atmospheres.set(id, clouds);
        this.scene.add(clouds);
      } else if (id === 'venus' || id === 'mars' || id === 'jupiter' || id === 'saturn' || id === 'uranus' || id === 'neptune') {
        // A soft additive halo, drawn as a billboard sprite rather than a sphere shell. The
        // shell version showed a hard dark rim that made every planet look like it had a hole
        // punched around it; a radial alpha ramp has no edge.
        const glowMaterial = new THREE.SpriteMaterial({
          map: this.glowTexture,
          color: ATMOSPHERE_COLORS[id],
          transparent: true,
          opacity: 0.35,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        });
        const glow = new THREE.Sprite(glowMaterial);
        glow.scale.setScalar(radiusUnits * 3.2);
        this.atmospheres.set(id, glow);
        this.scene.add(glow);
      }

      if (id === 'sun') {
        // A corona: a large radial ramp, so the disc bleeds light into space instead of
        // sitting inside a visible darker sphere.
        const coronaMaterial = new THREE.SpriteMaterial({
          map: this.glowTexture,
          color: 0xffe0b0,
          transparent: true,
          opacity: 0.55,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        });
        const corona = new THREE.Sprite(coronaMaterial);
        corona.scale.setScalar(radiusUnits * 3.4);
        this.atmospheres.set('sun', corona);
        this.scene.add(corona);
      }

      if (id === 'saturn') {
        const ringTexture = generateRings(512);
        const ringGeometry = new THREE.RingGeometry(radiusUnits * 1.4, radiusUnits * 2.3, 128, 1);
        const ringMaterial = new THREE.MeshBasicMaterial({
          map: ringTexture,
          transparent: true,
          side: THREE.DoubleSide,
          depthWrite: false,
          opacity: 0.9,
        });
        const ring = new THREE.Mesh(ringGeometry, ringMaterial);
        // Lying in the planet's equatorial plane, which in this model is the ecliptic.
        ring.rotation.x = -Math.PI / 2;
        ring.userData.ringFor = id;
        this.atmospheres.set('saturn-ring', ring);
        this.scene.add(ring);
      }

      const label = this.makeLabel(def.name);
      this.scene.add(label);

      this.bodies.set(id, { id, mesh, label, radiusUnits });
    }
  }

  private makeLabel(text: string): THREE.Sprite {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    canvas.width = 512;
    canvas.height = 128;
    if (ctx) {
      ctx.font = 'bold 56px system-ui, sans-serif';
      ctx.fillStyle = 'rgba(220,230,245,0.92)';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      // NOTE: fillText only. Imported or user-supplied strings are never interpolated into
      // markup anywhere in this app, and the canvas API is not an injection surface.
      ctx.fillText(text, 256, 64);
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      // Constant apparent size. A world-sized label is enormous when the camera closes in and
      // unreadable when it pulls back, which is what made "Earth" dwarf the planet it names.
      sizeAttenuation: false,
    });
    const sprite = new THREE.Sprite(material);
    // In the non-attenuated path the scale is in screen-height fractions.
    sprite.scale.set(0.1, 0.025, 1);
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

  /**
   * Positions every body from physics-frame metres.
   *
   * Heliocentric bodies (the Sun and the planets) are placed by the radial mapping, which is
   * honest about the layout. A satellite is placed **relative to its parent's drawn position**
   * at the parent's own exaggeration (`parentRelativeOffset`), for the reason stated there: at
   * the linear scale the Moon is 0.257 units from Earth while Earth is drawn at radius 1.2, so
   * a heliocentric placement buries it inside the planet and disagrees with every trajectory,
   * which is already drawn at the body-relative scale.
   *
   * The offset is derived from the *physics* difference between the body and its parent, so the
   * Moon still moves correctly around the Earth — but at a scale the camera can see. In the
   * compressed whole-system layout the separation is a fixed few parent radii instead, because
   * a logarithmic radius map has no room for a true satellite distance.
   */
  updatePositions(positions: ReadonlyMap<BodyId, { x: number; y: number; z: number }>): void {
    // Parents first: a satellite's scene position depends on its parent's.
    const order: BodyId[] = [];
    const visit = (id: BodyId): void => {
      const parent = BODIES[id].parent;
      if (parent) visit(parent);
      if (!order.includes(id)) order.push(id);
    };
    for (const id of this.bodies.keys()) visit(id);

    for (const id of order) {
      const visual = this.bodies.get(id);
      const p = positions.get(id);
      if (!visual || !p) continue;

      const def = BODIES[id];
      const parent = def.parent;
      // The parent-relative rule is for *satellites only*. A planet's parent is the Sun, and
      // applying `parentRelativeOffset` to it would place Earth at 1233 units from the Sun
      // (the Sun's 5.7-unit drawn radius divided by its true one, times a real AU) instead of
      // the 100 units the linear layout gives — pushing every planet off the camera. Planets
      // stay on the radial mapping; see `displayRadiusFor` for the matching radius rule.
      const isSatellite = parent !== null && parent !== 'sun';

      let x: number;
      let y: number;
      let z: number;
      if (isSatellite && parent && positions.has(parent)) {
        // Offset from the parent in physics metres, then converted at the parent's scale.
        const pp = positions.get(parent)!;
        const offsetM = Math.hypot(p.x - pp.x, p.y - pp.y, p.z - pp.z);
        const parentScene = this.scenePositions.get(parent) ?? new THREE.Vector3();
        if (offsetM > 0) {
          const drawn =
            this.radialMode === 'linear'
              ? // Linear layout: the true separation at the parent's own exaggeration, which
                // is what makes the Moon agree with the trajectory flying to it.
                parentRelativeOffset(parent, BODIES[parent].radius, offsetM)
              : // Compressed layout: distances are logarithmic, so a satellite's true 72-unit
                // separation would fling it onto its own ring far outside its planet. The map's
                // job is body *ordering*, so a satellite is drawn hugging its parent, at a few
                // parent radii, and reads as a system rather than a stray dot.
                displayRadiusFor(parent, BODIES[parent].radius) * 3;
          const k = drawn / offsetM;
          const sx = (p.x - pp.x) * k;
          const sy = (p.z - pp.z) * k;
          const sz = -(p.y - pp.y) * k;
          x = parentScene.x + sx;
          y = parentScene.y + sy;
          z = parentScene.z + sz;
        } else {
          x = parentScene.x;
          y = parentScene.y;
          z = parentScene.z;
        }
      } else {
        [x, y, z] = scalePosition(p.x, p.y, p.z, this.radialMode);
      }

      visual.mesh.position.set(x, y, z);

      // Cloud shells, glows and rings follow their body exactly.
      this.atmospheres.get(id)?.position.set(x, y, z);
      if (id === 'saturn') this.atmospheres.get('saturn-ring')?.position.set(x, y, z);

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

    // A widened line, not `THREE.Line`. WebGL ignores `linewidth` on a plain line, so a
    // trajectory was always exactly one pixel however close the camera got — the single
    // biggest reason the view read as a wireframe diagram. `LineSegments2` draws real
    // quads and its width is in screen pixels, which stays legible at every zoom.
    //
    // It is built from the same flat position array: `setPositions` takes consecutive pairs,
    // which is what a `LineSegments` arrangement already is.
    const makeGeometry = (): LineSegmentsGeometry => {
      const g = new LineSegmentsGeometry();
      g.setPositions(t.positions as unknown as number[]);
      return g;
    };

    const futureMaterial = new LineMaterial({
      color: t.color,
      linewidth: 2.2,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      // Needed because the trajectory is an overlay: a line passing behind a planet must still
      // be visible, or the path reads as broken rather than occluded.
      depthTest: false,
    });
    const flownMaterial = new LineMaterial({
      color: new THREE.Color(t.color).multiplyScalar(0.42).getHex(),
      linewidth: 2.2,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      depthTest: false,
    });
    this.applyLineResolution(futureMaterial);
    this.applyLineResolution(flownMaterial);

    // Two objects over two geometries, each holding the same positions and a different
    // `instanceCount` (a segment count): the flown part is dimmer so the craft's position
    // reads at a glance. They cannot share one geometry — `instanceCount` lives on the
    // geometry, so a shared one would let one half overwrite the other's split. The old
    // `drawRange` version had exactly that latent bug.
    const future = new LineSegments2(makeGeometry(), futureMaterial);
    const flown = new LineSegments2(makeGeometry(), flownMaterial);
    future.renderOrder = 2;
    flown.renderOrder = 2;
    group.add(flown);
    group.add(future);

    const markerMaterial = new THREE.MeshBasicMaterial({ color: t.color });
    const marker = new THREE.Mesh(this.craftGeometry, markerMaterial);
    // A craft is a symbol, not a body: a 5 m satellite scaled honestly is invisible, and a
    // fixed world size is either a dot at system zoom or a planet-sized blob up close — which
    // is exactly what it was. It is rescaled every frame from the camera distance instead
    // (`updateMarkerScales`), so it holds a constant apparent size.
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

  /**
   * Splits the shared geometry at a segment boundary.
   *
   * `LineSegments2` draws instanced quads, so the split is an `instanceCount` — one per
   * segment — rather than the vertex `drawRange` a plain `LineSegments` would need. Storing
   * both counts means a resize or a re-split can restore them without re-reading geometry.
   */
  private applyFlownCount(visual: TrajectoryVisual, flownSegments: number): void {
    const total = visual.future.geometry.instanceCount;
    const flown = Math.min(total, Math.max(0, Math.floor(flownSegments)));
    visual.flown.geometry.instanceCount = flown;
    visual.future.geometry.instanceCount = total - flown;
  }

  /** Keeps a line material's pixel width correct for the current drawing-buffer size. */
  private applyLineResolution(material: LineMaterial): void {
    const size = this.renderer.getSize(new THREE.Vector2());
    material.resolution.set(size.x, size.y);
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
    // Each line object owns its own geometry now (see `buildTrajectory`), so both are
    // disposed. The marker geometry is shared between crafts and outlives every trajectory.
    visual.future.geometry.dispose();
    visual.flown.geometry.dispose();
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
   * Rotates every body's surface by wall time. Called once per rendered frame.
   *
   * Bodies rotating is the single cheapest thing that stops the view reading as a static
   * diagram. The rates are illustrative rather than physical — a real 24-hour rotation is
   * invisible at warp 1 and a blur at warp 1e7 — so each body turns slowly enough to see its
   * surface move, and the *relative* speeds keep the ranking right (Jupiter fast, Venus slow).
   * Using wall time rather than simulation time is deliberate: a paused planet stays alive.
   */
  private updateSpin(wallSeconds: number): void {
    for (const [id, visual] of this.bodies) {
      // Radians per second of wall time. Slow enough to read, fast enough to notice.
      const rate = SPIN_RATES[id] ?? 0.02;
      visual.mesh.rotation.y = wallSeconds * rate;
      const clouds = id === 'earth' ? this.atmospheres.get('earth') : undefined;
      if (clouds) clouds.rotation.y = wallSeconds * rate * 1.18;
    }
  }

  /**
   * Holds every craft marker at a constant apparent size.
   *
   * The marker is a symbol for "the spacecraft is here", so what matters is that it is always
   * legible and never mistaken for a body. Scaling it per frame by the camera distance is the
   * standard billboard trick; a fixed world size is either invisible or, as it was, a blob
   * bigger than the Earth it orbits.
   */
  private updateMarkerScales(): void {
    // A marker about 1.8% of the viewport height, expressed as a world diameter and halved
    // back to the sphere's radius. Getting this wrong by the radius/diameter factor is what
    // left a blob half the size of Earth: the old code multiplied the *radius* by the
    // viewport fraction, drawing a marker 2x its intended apparent size.
    const worldPerUnit = this.distance * Math.tan((this.camera.fov * Math.PI) / 360) * 2;
    const scale = (worldPerUnit * 0.018) / 2;
    for (const visual of this.trajectories.values()) {
      visual.marker.scale.setScalar(scale);
    }
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

  /**
   * Points the camera at the midpoint between a body and its parent.
   *
   * Necessary for the Earth-Moon pair. They are drawn 72.4 units apart, so a camera centred on
   * Earth puts the Moon off the edge and one centred on the Moon puts Earth off the edge. The
   * midpoint is the only target that keeps both in frame, and the distance is widened to fit
   * the separation rather than reusing a single-body value tuned for one of them.
   */
  centerOnPair(id: BodyId): void {
    const pos = this.scenePositions.get(id);
    const parent = BODIES[id].parent;
    if (!pos || !parent) return;
    const parentPos = this.scenePositions.get(parent);
    if (!parentPos) return;

    this.orbitTarget.copy(pos).add(parentPos).multiplyScalar(0.5);
    // Fit the separation: the pair spans `sep` units, and a 45-degree vertical FOV holds about
    // 0.83 scene units of width per unit of distance. 1.6x margin keeps both discs clear of
    // the edges, and the floor stops a tight pair from putting the camera inside a body.
    const sep = pos.distanceTo(parentPos);
    const childRadius = this.bodies.get(id)?.radiusUnits ?? 0;
    const parentRadius = this.bodies.get(parent)?.radiusUnits ?? 0;
    const span = Math.max(sep + childRadius + parentRadius, 1);
    this.distance = clamp(span * 1.6, 0.5, 4000);
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
    // Line widths are specified in pixels, which the shader converts using the drawing
    // buffer's size. Without this the line is drawn at the wrong width after any resize.
    for (const visual of this.trajectories.values()) {
      for (const material of visual.materials) {
        if (material instanceof LineMaterial) this.applyLineResolution(material);
      }
    }
  };

  /** Renders one frame. The caller owns timing; this only draws. */
  render(): void {
    if (this.disposed) return;
    this.updateSpin(performance.now() / 1000);
    this.updateMarkerScales();
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
