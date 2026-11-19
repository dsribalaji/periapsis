/**
 * Three.js scene for the solar system view.
 *
 * This module owns every Three.js object and is the only place that touches WebGL. It has
 * no knowledge of React or of the simulation: it is handed body positions and draws them.
 *
 * **Scale.** Everything - positions, body radii, the Moon's offset, spacecraft paths - is drawn
 * at one true scale (see `scale.ts`). Bodies too small to see are drawn at a minimum size in
 * *pixels*, recomputed every frame from the camera distance, so they stay visible and clickable
 * without anything being moved. When zoomed in, a body is exactly its real size.
 *
 * **Range.** True scale spans a 400 km orbit to Neptune at 30 AU, a ratio of 1e7. Three things
 * make that work: a logarithmic depth buffer (so near and far share precision), a camera that
 * *follows* its target body (Earth moves 0.2 units per second at warp 10k, which would carry it
 * out of a close-up frame in under a second), and a starfield that is re-centred on the camera
 * every frame so it is always "at infinity".
 */

import * as THREE from 'three';
import { BODIES, type BodyId } from '../core/ephemeris/solarSystem.js';
import { RADIUS } from '../core/constants.js';
import {
  MIN_PIXEL_RADIUS,
  UNITS_PER_M,
  drawnRadiusUnits,
  localUnitsPerMetre,
  satelliteResolvable,
  scalePosition,
  trueRadiusUnits,
  unitsPerPixelAt,
  type RadialMode,
} from './scale.js';
import { orbitPathPoints } from './orbitPaths.js';
import { smallBodyOrbit, type SmallBodyRecord } from '../core/ephemeris/smallBodies.js';
import { poleEcliptic, SPIN_SENSE } from './poles.js';
import { generateClouds, generateRings, generateSurface, textureSize } from './bodyTextures.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';

/** Everything drawn for one body. */
interface BodyVisual {
  readonly id: BodyId;
  /** Positioned at the body's centre; carries the glow sprites. Never scaled. */
  readonly root: THREE.Group;
  /** Oriented along the spin axis and scaled to the drawn radius; carries the surface. */
  readonly axis: THREE.Group;
  readonly mesh: THREE.Mesh;
  readonly label: THREE.Sprite;
  /** Label width over height, so a constant pixel height gives the right width. */
  readonly labelAspect: number;
  readonly trueRadius: number;
  /** Glow sprites, each with its size as a multiple of the drawn radius. */
  readonly glows: readonly { readonly sprite: THREE.Sprite; readonly factor: number }[];
  /** Radius drawn this frame, scene units. */
  drawnRadius: number;
  /** Radius drawn this frame, pixels. */
  drawnRadiusPx: number;
  /** Hidden by the user or by the satellite rule. */
  shown: boolean;
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
 * prefix and highlighting it is one `instanceCount`.
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
  readonly onHover?: (id: string | null) => void;
  /** A planet or Moon `BodyId`, or a small-body id from `smallBodies.ts`. */
  readonly onSelect?: (id: string) => void;
}

/** A dwarf planet, asteroid or comet: drawn and pickable, but with no gravity. */
interface SmallVisual {
  readonly id: string;
  readonly mesh: THREE.Mesh;
  readonly label: THREE.Sprite;
  readonly labelAspect: number;
  readonly orbit: THREE.Line;
  /** The record the orbit was built from, kept to rebuild it on a radial-mode change. */
  readonly record: SmallBodyRecord;
  readonly trueRadius: number;
  /** Heliocentric distance in metres, for the compressed layout's local scale. */
  helioDistance: number;
  drawnRadius: number;
  drawnRadiusPx: number;
  shown: boolean;
}

/** Marker colour per small-body kind, distinct from every planet's. */
const SMALL_BODY_COLORS: Record<SmallBodyRecord['kind'], number> = {
  dwarf: 0xd9c7b0,
  asteroid: 0xa4adb8,
  comet: 0x8fd6ff,
};

/** Small bodies sit below the faintest planet marker, so they never outrank one. */
const SMALL_BODY_MIN_PX = 2.2;

/** A stored camera framing, as a scenario carries it. */
export interface SceneView {
  readonly azimuthRad: number;
  readonly elevationRad: number;
  readonly distanceUnits: number;
  readonly centeredOn: 'sun' | 'focus' | 'pair';
}

/** What the camera keeps centred as bodies move. */
type Follow =
  | { readonly kind: 'origin' }
  | { readonly kind: 'body'; readonly id: BodyId }
  | { readonly kind: 'pair'; readonly id: BodyId }
  | { readonly kind: 'small'; readonly id: string };

/** Flat colour per body, used for orbit paths and the selection reticle. */
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
 * Surface spin in radians per second of *wall* time, before the sense from `SPIN_SENSE`.
 *
 * Ordered by real rotation rate so Jupiter visibly outruns Venus, but all far too slow to be
 * physically accurate - the point is legibility, not simulation.
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

/** Label height on screen, pixels. */
const LABEL_HEIGHT_PX = 22;
/** Camera limits, scene units. 4000 units is 40 AU: all of Neptune's orbit and some margin. */
const MAX_DISTANCE = 4000;
const MIN_DISTANCE = 1e-6;
/** How long a fly-to takes, ms. */
const FLY_MS = 900;

/**
 * A soft radial glow sprite: bright at the centre, fading to fully transparent at the edge.
 *
 * `BackSide` shells are the usual shortcut for a glow and they look wrong: a shell renders an
 * unlit surface whose inner face is visible as a hard-edged disc. A radial alpha ramp has no
 * edge to see, so it reads as light rather than as a second sphere.
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

/** A thin ring outline, for marking the selected body. */
function makeReticleTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.strokeStyle = 'rgba(150, 205, 255, 0.95)';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(64, 64, 58, 0, Math.PI * 2);
    ctx.stroke();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Whether the user has asked for less motion. Read once per fly-to, not cached. */
function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;
}

export class SolarSystemScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;

  private readonly bodies = new Map<BodyId, BodyVisual>();
  private readonly container: HTMLElement;
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly callbacks: SceneCallbacks;
  private readonly sunLight: THREE.PointLight;
  private readonly stars: THREE.Points;
  private readonly reticle: THREE.Sprite;

  private frameId = 0;
  private disposed = false;
  private radialMode: RadialMode = 'linear';
  /** Latest scene-space position of each body, for framing and picking. */
  private readonly scenePositions = new Map<BodyId, THREE.Vector3>();
  /** Latest heliocentric distance of each body, metres, for the local scale. */
  private readonly helioDistance = new Map<BodyId, number>();

  /** Orbit paths, keyed by body. The Moon's hangs off Earth. */
  private readonly orbitLines = new Map<BodyId, THREE.Line>();
  /** TT Julian date the orbit paths were built for, or NaN before the first build. */
  private orbitEpoch = Number.NaN;
  private orbitsVisible = true;
  private labelsVisible = true;
  private selected: string | null = null;
  /** Dwarf planets, asteroids and comets, keyed by their small-body id. */
  private readonly smallBodies = new Map<string, SmallVisual>();
  private smallBodiesVisible = true;

  private readonly trajectories = new Map<string, TrajectoryVisual>();
  /** Craft marker geometry, shared by every craft. */
  private readonly craftGeometry = new THREE.SphereGeometry(1, 12, 8);
  /** One shared radial glow texture, generated once and reused by every halo. */
  private readonly glowTexture = makeGlowTexture();
  /** Pointer-drag state, or null when not dragging. */
  private drag: { lastX: number; lastY: number; moved: number } | null = null;
  /** Set after a drag so the trailing click does not reselect. */
  private suppressNextClick = false;
  /** Active pointers, for pinch-to-zoom. */
  private readonly touches = new Map<number, { x: number; y: number }>();
  /** Finger separation at the previous pinch move, px; 0 when no pinch is in progress. */
  private pinchSpan = 0;

  /** Camera orbit state, in spherical coordinates around `target`. */
  private azimuth = 0.6;
  private elevation = 1.05;
  private distance = 260;
  private readonly target = new THREE.Vector3();
  private follow: Follow = { kind: 'origin' };
  /** An in-flight camera move, or null. */
  private flight: {
    readonly from: THREE.Vector3;
    readonly fromDistance: number;
    readonly toDistance: number;
    readonly start: number;
  } | null = null;

  constructor(container: HTMLElement, callbacks: SceneCallbacks = {}) {
    this.container = container;
    this.callbacks = callbacks;

    // No logarithmic depth buffer: it writes gl_FragDepth, which disables early depth rejection,
    // and measured at 1280x800 it made every frame 2-4x slower. The near and far planes follow
    // the camera distance instead (`updateCamera`), which keeps a 1e5 depth ratio around
    // whatever the camera is looking at - ample for a 550 km orbit and for Neptune alike.
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x05060a, 1);
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(45, 1, 1e-7, 1e5);

    // A single point light at the Sun plus a little ambient, so the night side is not pure
    // black. Decay 0: at true scale the inverse square would leave Neptune unlit.
    this.sunLight = new THREE.PointLight(0xffffff, 3.2, 0, 0.0);
    this.scene.add(this.sunLight);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.14));

    this.stars = this.buildStarfield();
    this.buildBodies();

    this.reticle = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: makeReticleTexture(),
        transparent: true,
        depthTest: false,
        depthWrite: false,
        sizeAttenuation: false,
      }),
    );
    this.reticle.renderOrder = 5;
    this.reticle.visible = false;
    this.scene.add(this.reticle);

    this.resize();
    this.updateCamera();

    this.renderer.domElement.addEventListener('pointermove', this.handlePointerMove);
    this.renderer.domElement.addEventListener('pointerdown', this.handlePointerDown);
    this.renderer.domElement.addEventListener('pointerup', this.handlePointerUp);
    this.renderer.domElement.addEventListener('pointercancel', this.handlePointerUp);
    this.renderer.domElement.addEventListener('click', this.handleClick);
    this.renderer.domElement.addEventListener('dblclick', this.handleDoubleClick);
    this.renderer.domElement.addEventListener('wheel', this.handleWheel, { passive: false });
    window.addEventListener('resize', this.resize);
  }

  // --------------------------------------------------------------------------------------
  // Construction
  // --------------------------------------------------------------------------------------

  private buildBodies(): void {
    const sphereGeometry = new THREE.SphereGeometry(1, 64, 48);
    const up = new THREE.Vector3(0, 1, 0);

    for (const [id, def] of Object.entries(BODIES) as [BodyId, (typeof BODIES)[BodyId]][]) {
      const trueRadius = trueRadiusUnits(RADIUS[id]);
      const size = textureSize(id);
      const map = generateSurface(id, size);

      const root = new THREE.Group();
      const axis = new THREE.Group();
      // Physics pole -> scene axes (x, z, -y), then rotate the mesh's +y onto it.
      const pole = poleEcliptic(id);
      axis.quaternion.setFromUnitVectors(up, new THREE.Vector3(pole.x, pole.z, -pole.y));
      root.add(axis);

      const material = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        map,
        roughness: id === 'sun' ? 1 : 0.92,
        metalness: 0.0,
        emissive: id === 'sun' ? 0xfff0d0 : 0x000000,
        emissiveMap: id === 'sun' ? map : null,
        emissiveIntensity: id === 'sun' ? 1.35 : 0,
      });
      const mesh = new THREE.Mesh(sphereGeometry, material);
      mesh.userData.bodyId = id;
      axis.add(mesh);

      const glows: { sprite: THREE.Sprite; factor: number }[] = [];

      if (id === 'earth') {
        const cloudMaterial = new THREE.MeshStandardMaterial({
          map: generateClouds(size),
          transparent: true,
          opacity: 0.85,
          depthWrite: false,
          roughness: 1,
        });
        const clouds = new THREE.Mesh(sphereGeometry, cloudMaterial);
        clouds.scale.setScalar(1.012);
        clouds.userData.cloudShell = true;
        mesh.add(clouds);
      }

      const tint = ATMOSPHERE_COLORS[id];
      if (tint !== undefined) {
        // A soft additive halo. At marker size it reads as the planet's glow, which is also
        // what makes a 4-pixel disc findable against the starfield. Earth's is kept tight to
        // the limb: it is the body the camera sits closest to, and a wide haze there would
        // wash out the orbits drawn around it.
        const glow = new THREE.Sprite(
          new THREE.SpriteMaterial({
            map: this.glowTexture,
            color: tint,
            transparent: true,
            opacity: 0.35,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
          }),
        );
        root.add(glow);
        glows.push({ sprite: glow, factor: id === 'earth' ? 1.7 : 3.2 });
      }

      if (id === 'sun') {
        const corona = new THREE.Sprite(
          new THREE.SpriteMaterial({
            map: this.glowTexture,
            color: 0xffe0b0,
            transparent: true,
            opacity: 0.6,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
          }),
        );
        root.add(corona);
        glows.push({ sprite: corona, factor: 4 });
      }

      if (id === 'saturn') {
        // Unit geometry in planet radii (the C ring to the outer A ring), scaled with the
        // planet. It is a child of the spin axis, so it lies in Saturn's real equator - 26.7
        // degrees from its orbit - rather than flat in the ecliptic.
        const inner = 1.24;
        const outer = 2.27;
        const ringGeometry = new THREE.RingGeometry(inner, outer, 128, 1);
        // RingGeometry's UVs are a planar projection, which draws a 1D band texture as
        // parallel stripes across the ring. Radial UVs make each band a concentric circle.
        const pos = ringGeometry.attributes.position!;
        const uv = ringGeometry.attributes.uv!;
        for (let k = 0; k < pos.count; k++) {
          uv.setXY(k, (Math.hypot(pos.getX(k), pos.getY(k)) - inner) / (outer - inner), 0.5);
        }
        const ring = new THREE.Mesh(
          ringGeometry,
          new THREE.MeshBasicMaterial({
            map: generateRings(512),
            transparent: true,
            side: THREE.DoubleSide,
            depthWrite: false,
            opacity: 0.9,
          }),
        );
        ring.rotation.x = -Math.PI / 2;
        ring.userData.ringFor = id;
        axis.add(ring);
      }

      const { sprite: label, aspect } = this.makeLabel(def.name);
      this.scene.add(label);
      this.scene.add(root);

      this.bodies.set(id, {
        id,
        root,
        axis,
        mesh,
        label,
        labelAspect: aspect,
        trueRadius,
        glows,
        drawnRadius: trueRadius,
        drawnRadiusPx: 0,
        shown: true,
      });
    }
  }

  /**
   * A text label as a screen-space sprite.
   *
   * The canvas is sized to the text, so the sprite's aspect is the text's and its rectangle is
   * exactly what the decluttering pass needs to test for overlaps.
   */
  private makeLabel(text: string): { sprite: THREE.Sprite; aspect: number } {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const fontPx = 40;
    const font = `600 ${fontPx}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    let width = 160;
    if (ctx) {
      ctx.font = font;
      width = Math.ceil(ctx.measureText(text).width) + 24;
    }
    canvas.width = width;
    canvas.height = 64;
    if (ctx) {
      // Resizing a canvas resets its state, so the font is set again.
      ctx.font = font;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      // A dark halo keeps the text legible over a bright planet or an orbit line.
      ctx.lineWidth = 8;
      ctx.strokeStyle = 'rgba(5, 6, 10, 0.85)';
      ctx.lineJoin = 'round';
      // NOTE: canvas text only. Imported or user-supplied strings are never interpolated into
      // markup anywhere in this app, and the canvas API is not an injection surface.
      ctx.strokeText(text, width / 2, 33);
      ctx.fillStyle = 'rgba(225, 233, 246, 0.95)';
      ctx.fillText(text, width / 2, 33);
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      // Constant apparent size; the scale is set per frame from the viewport height.
      sizeAttenuation: false,
    });
    const sprite = new THREE.Sprite(material);
    // Anchored at its bottom centre, a little above the point it is placed at.
    sprite.center.set(0.5, -0.15);
    sprite.renderOrder = 6;
    return { sprite, aspect: width / 64 };
  }

  private buildStarfield(): THREE.Points {
    // A deterministic point cloud: a fixed lattice hash, not Math.random, so the sky is
    // identical on every load and in every screenshot. Brightness varies per star.
    const count = 2600;
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const u = hash01(i * 4 + 1);
      const v = hash01(i * 4 + 2);
      const w = hash01(i * 4 + 3);
      const theta = 2 * Math.PI * u;
      const phi = Math.acos(2 * v - 1);
      const r = 20000;
      positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = r * Math.cos(phi);
      positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
      // Mostly faint, a few bright; a slight blue/orange spread like real star colours.
      const b = 0.25 + 0.75 * w * w * w;
      const warm = hash01(i * 4 + 4) - 0.5;
      colors[i * 3] = b * (0.9 + 0.1 * warm);
      colors[i * 3 + 1] = b * 0.93;
      colors[i * 3 + 2] = b * (0.95 - 0.1 * warm);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const material = new THREE.PointsMaterial({
      size: 1.6,
      sizeAttenuation: false,
      vertexColors: true,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    });
    const points = new THREE.Points(geometry, material);
    points.renderOrder = -1;
    points.frustumCulled = false;
    this.scene.add(points);
    return points;
  }

  /**
   * Builds every orbit path for an instant.
   *
   * Each path is the osculating ellipse of the same elements the ephemeris evaluates, so a
   * body is on its drawn orbit by construction. Planet paths are mapped point by point through
   * the active radial mode (so they stay correct under the logarithmic layout too); the Moon's
   * is built about Earth in metres and scaled with Earth's local scale every frame.
   */
  private buildOrbitPaths(jdTt: number): void {
    for (const line of this.orbitLines.values()) {
      line.parent?.remove(line);
      line.geometry.dispose();
      (line.material as THREE.Material).dispose();
    }
    this.orbitLines.clear();
    this.orbitEpoch = jdTt;

    for (const [id, def] of Object.entries(BODIES) as [BodyId, (typeof BODIES)[BodyId]][]) {
      if (!def.elements || !def.parent) continue;
      const isSatellite = def.parent !== 'sun';
      const pts = orbitPathPoints(def.elements, jdTt, 360);
      const flat = new Float32Array(pts.length * 3);
      pts.forEach((p, k) => {
        const [x, y, z] = isSatellite
          ? [p.x * UNITS_PER_M, p.z * UNITS_PER_M, -p.y * UNITS_PER_M]
          : scalePosition(p.x, p.y, p.z, this.radialMode);
        flat[k * 3] = x;
        flat[k * 3 + 1] = y;
        flat[k * 3 + 2] = z;
      });
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(flat, 3));
      const line = new THREE.Line(
        geometry,
        new THREE.LineBasicMaterial({
          color: BODY_COLORS[id],
          transparent: true,
          opacity: isSatellite ? 0.4 : 0.42,
          depthWrite: false,
        }),
      );
      line.userData.orbitFor = id;
      line.visible = this.orbitsVisible;
      // The Moon's orbit hangs off Earth, so it travels with it.
      if (isSatellite) this.bodies.get(def.parent)?.root.add(line);
      else this.scene.add(line);
      this.orbitLines.set(id, line);
    }
  }

  // --------------------------------------------------------------------------------------
  // Per-tick inputs
  // --------------------------------------------------------------------------------------

  /**
   * Tells the scene what instant it is drawing, so the orbit paths match it.
   *
   * Elements drift slowly - the Moon's perigee turns once in 8.85 years, its node once in 18.6 -
   * so paths are rebuilt only after ten days of simulated drift, which is invisible on screen
   * and costs one rebuild every few seconds at the highest warp.
   */
  setTime(jdTt: number): void {
    if (Number.isNaN(this.orbitEpoch) || Math.abs(jdTt - this.orbitEpoch) > 10) {
      this.buildOrbitPaths(jdTt);
    }
  }

  /**
   * Positions every body from physics-frame metres.
   *
   * Planets go through the radial mapping. A satellite is placed at its parent's scene position
   * plus its true offset, at the parent's *local* scale: under the linear layout that is the
   * same true scale as everything else, and under the compressed layout it is the map's slope
   * at the parent's distance, so the Earth-Moon system stays a correctly proportioned system
   * rather than being flung onto its own ring.
   */
  updatePositions(positions: ReadonlyMap<BodyId, { x: number; y: number; z: number }>): void {
    for (const [id, p] of positions) this.helioDistance.set(id, Math.hypot(p.x, p.y, p.z));

    // Parents first: a satellite's scene position depends on its parent's.
    const order = [...this.bodies.keys()].sort(
      (a, b) =>
        Number(BODIES[a].parent !== null && BODIES[a].parent !== 'sun') -
        Number(BODIES[b].parent !== null && BODIES[b].parent !== 'sun'),
    );

    for (const id of order) {
      const visual = this.bodies.get(id);
      const p = positions.get(id);
      if (!visual || !p) continue;
      const parent = BODIES[id].parent;
      const isSatellite = parent !== null && parent !== 'sun';

      let x: number;
      let y: number;
      let z: number;
      const pp = isSatellite && parent ? positions.get(parent) : undefined;
      const parentScene = isSatellite && parent ? this.scenePositions.get(parent) : undefined;
      if (pp && parentScene && parent) {
        const k = localUnitsPerMetre(this.helioDistance.get(parent) ?? 0, this.radialMode);
        x = parentScene.x + (p.x - pp.x) * k;
        y = parentScene.y + (p.z - pp.z) * k;
        z = parentScene.z - (p.y - pp.y) * k;
      } else {
        [x, y, z] = scalePosition(p.x, p.y, p.z, this.radialMode);
      }

      visual.root.position.set(x, y, z);
      if (id === 'sun') this.sunLight.position.set(x, y, z);
      const stored = this.scenePositions.get(id);
      if (stored) stored.set(x, y, z);
      else this.scenePositions.set(id, new THREE.Vector3(x, y, z));
    }

    // The Moon's orbit path is in true metres-scale units about Earth; under the compressed
    // layout it takes Earth's local scale like the Moon itself does.
    const moonOrbit = this.orbitLines.get('moon');
    if (moonOrbit) moonOrbit.scale.setScalar(this.localScaleFactor('earth'));

    this.syncTrajectoryPositions();
    // Keep the followed body centred: this is what makes a close-up survive a running clock.
    this.applyFollow();
  }

  /** The local scale around a body, relative to the true scale (1 under the linear layout). */
  private localScaleFactor(id: BodyId): number {
    return localUnitsPerMetre(this.helioDistance.get(id) ?? 0, this.radialMode) / UNITS_PER_M;
  }

  // --------------------------------------------------------------------------------------
  // Trajectories
  // --------------------------------------------------------------------------------------

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

    // A widened line, not `THREE.Line`: WebGL ignores `linewidth` on a plain line, so the path
    // would be one pixel at every zoom. `LineSegments2` draws quads with a width in pixels.
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
      // The trajectory is an overlay: a line passing behind a planet must still be visible,
      // or the path reads as broken rather than occluded.
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

    // Two objects over two geometries holding the same positions and different instance
    // counts: `instanceCount` lives on the geometry, so a shared one would let one half
    // overwrite the other's split.
    const future = new LineSegments2(makeGeometry(), futureMaterial);
    const flown = new LineSegments2(makeGeometry(), flownMaterial);
    future.renderOrder = 2;
    flown.renderOrder = 2;
    group.add(flown);
    group.add(future);

    const markerMaterial = new THREE.MeshBasicMaterial({ color: t.color, depthTest: false });
    const marker = new THREE.Mesh(this.craftGeometry, markerMaterial);
    // A craft is a symbol, not a body: it is rescaled every frame to a constant apparent size.
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

  /** Splits the drawn path at a segment boundary: one instance per segment. */
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

  /** Moves a trajectory's craft marker to a body-centred scene position, or hides it. */
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

  /** Anchors every trajectory at its central body and gives it that body's local scale. */
  private syncTrajectoryPositions(): void {
    for (const visual of this.trajectories.values()) {
      const anchor = this.scenePositions.get(visual.centralBody);
      if (anchor) visual.group.position.copy(anchor);
      visual.group.scale.setScalar(this.localScaleFactor(visual.centralBody));
    }
  }

  private disposeTrajectory(visual: TrajectoryVisual): void {
    this.scene.remove(visual.group);
    visual.future.geometry.dispose();
    visual.flown.geometry.dispose();
    for (const material of visual.materials) material.dispose();
  }

  // --------------------------------------------------------------------------------------
  // Modes and visibility
  // --------------------------------------------------------------------------------------

  /** Switches between the true-scale layout and the whole-system compressed one. */
  setRadialMode(mode: RadialMode): void {
    if (mode === this.radialMode) return;
    this.radialMode = mode;
    // Path points are mapped through the radial mode, so they must be rebuilt.
    if (!Number.isNaN(this.orbitEpoch)) this.buildOrbitPaths(this.orbitEpoch);
    for (const visual of this.smallBodies.values()) this.fillSmallOrbit(visual);
  }

  // --------------------------------------------------------------------------------------
  // Small bodies
  // --------------------------------------------------------------------------------------

  /** Creates the drawn dwarf planets, asteroids and comets. Call once. */
  setSmallBodies(records: readonly SmallBodyRecord[]): void {
    const geometry = new THREE.SphereGeometry(1, 16, 12);
    for (const record of records) {
      if (this.smallBodies.has(record.id)) continue;
      const color = SMALL_BODY_COLORS[record.kind];
      const mesh = new THREE.Mesh(
        geometry,
        new THREE.MeshStandardMaterial({ color, roughness: 1 }),
      );
      mesh.userData.smallBodyId = record.id;
      const orbit = new THREE.Line(
        new THREE.BufferGeometry(),
        new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.22, depthWrite: false }),
      );
      const { sprite: label, aspect } = this.makeLabel(record.name);
      this.scene.add(mesh, orbit, label);
      const visual: SmallVisual = {
        id: record.id,
        mesh,
        label,
        labelAspect: aspect,
        orbit,
        record,
        // An unknown diameter is drawn as 1 km: a body that small is a marker at every zoom.
        trueRadius: trueRadiusUnits(((record.diameterKm ?? 2) * 1000) / 2),
        helioDistance: 0,
        drawnRadius: 0,
        drawnRadiusPx: 0,
        shown: this.smallBodiesVisible,
      };
      this.fillSmallOrbit(visual);
      this.smallBodies.set(record.id, visual);
    }
  }

  /** Builds a small body's orbit path through the active radial mapping. */
  private fillSmallOrbit(visual: SmallVisual): void {
    const pts = smallBodyOrbit(visual.record, 360);
    const flat = new Float32Array(pts.length * 3);
    pts.forEach((p, k) => {
      const [x, y, z] = scalePosition(p.x, p.y, p.z, this.radialMode);
      flat[k * 3] = x;
      flat[k * 3 + 1] = y;
      flat[k * 3 + 2] = z;
    });
    visual.orbit.geometry.setAttribute('position', new THREE.BufferAttribute(flat, 3));
    visual.orbit.geometry.computeBoundingSphere();
  }

  /** Moves the small bodies to heliocentric positions in metres, keyed by small-body id. */
  updateSmallBodyPositions(
    positions: ReadonlyMap<string, { x: number; y: number; z: number }>,
  ): void {
    for (const [id, p] of positions) {
      const visual = this.smallBodies.get(id);
      if (!visual) continue;
      const [x, y, z] = scalePosition(p.x, p.y, p.z, this.radialMode);
      visual.mesh.position.set(x, y, z);
      visual.helioDistance = Math.hypot(p.x, p.y, p.z);
    }
    if (this.follow.kind === 'small') this.applyFollow();
  }

  /** Shows or hides every small body, its orbit and its label. */
  setSmallBodiesVisible(visible: boolean): void {
    this.smallBodiesVisible = visible;
  }

  /** Frames any target: a planet, the Moon, the Sun or a small body. */
  frameTarget(id: string, animate = true): void {
    if (id in BODIES) {
      this.frameBody(id as BodyId, animate);
      return;
    }
    const visual = this.smallBodies.get(id);
    if (!visual) return;
    // Small bodies are kilometres across, so filling the view with one says nothing. Frame it as
    // a marker in its neighbourhood instead: a third of its distance from the Sun, so its orbit
    // and the nearest planets are in shot.
    const fromSun = visual.mesh.position.length();
    this.flyTo({ kind: 'small', id }, Math.max(fromSun * 0.35, 1), animate);
  }

  get scaleMode(): RadialMode {
    return this.radialMode;
  }

  /** Shows or hides the orbit paths. */
  setOrbitsVisible(visible: boolean): void {
    this.orbitsVisible = visible;
    for (const line of this.orbitLines.values()) line.visible = visible;
  }

  /** Shows or hides every body label. */
  setLabelVisibility(visible: boolean): void {
    this.labelsVisible = visible;
  }

  /** Marks a body as selected: it gets a reticle and its label always wins a collision. */
  setSelected(id: string | null): void {
    this.selected = id;
  }

  /** Hides or shows one body entirely. */
  setBodyVisibility(id: BodyId, visible: boolean): void {
    const visual = this.bodies.get(id);
    if (visual) visual.root.userData.userHidden = !visible;
  }

  /**
   * Bodies currently outside the camera frustum.
   *
   * True-scale layout cannot fit the outer system at a camera distance that also shows the
   * inner planets, so the UI says which bodies are off screen instead of leaving the user to
   * guess. A body hidden by the satellite rule is not "off screen"; it is on screen, merged
   * with its parent, and is not reported.
   */
  offScreenBodies(): Set<BodyId> {
    const off = new Set<BodyId>();
    const v = new THREE.Vector3();
    this.camera.updateMatrixWorld();
    for (const [id, visual] of this.bodies) {
      if (!visual.shown) continue;
      const p = this.scenePositions.get(id);
      if (!p) continue;
      v.copy(p).project(this.camera);
      if (!(Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1 && v.z <= 1 && v.z >= -1)) off.add(id);
    }
    return off;
  }

  // --------------------------------------------------------------------------------------
  // Camera
  // --------------------------------------------------------------------------------------

  /**
   * Applies a scenario's stored framing in one step: angles, distance and what to follow.
   *
   * Positions must already have been pushed, because framing a body reads its scene position.
   */
  applyView(view: SceneView, focus: BodyId): void {
    this.flight = null;
    this.azimuth = view.azimuthRad;
    this.elevation = clamp(view.elevationRad, -1.5, 1.5);
    this.distance = clamp(view.distanceUnits, MIN_DISTANCE, MAX_DISTANCE);
    if (view.centeredOn === 'focus') this.follow = { kind: 'body', id: focus };
    else if (view.centeredOn === 'pair' && BODIES[focus].parent) {
      this.follow = { kind: 'pair', id: focus };
      this.distance = this.pairDistance(focus) ?? this.distance;
    } else this.follow = { kind: 'origin' };
    this.applyFollow();
  }

  /** Current camera framing, so the UI can save it back into a scenario. */
  getCamera(): { azimuthRad: number; elevationRad: number; distanceUnits: number } {
    return { azimuthRad: this.azimuth, elevationRad: this.elevation, distanceUnits: this.distance };
  }

  /** What the camera follows: a target id, or null for the Sun-centred view. */
  getFollow(): string | null {
    const f = this.follow;
    return f.kind === 'origin' ? null : f.id;
  }

  /**
   * Restores an exact camera from a share link: angles, distance and what it follows.
   *
   * A pair follow is not stored in links, so following the Moon from a link follows the Moon
   * itself; the framing is the same, the anchor is a few thousand km different.
   */
  restoreView(view: {
    readonly azimuthRad: number;
    readonly elevationRad: number;
    readonly distanceUnits: number;
    readonly follow: string | null;
  }): void {
    this.flight = null;
    this.azimuth = view.azimuthRad;
    this.elevation = clamp(view.elevationRad, -1.5, 1.5);
    this.distance = clamp(view.distanceUnits, MIN_DISTANCE, MAX_DISTANCE);
    const id = view.follow;
    if (id === null) this.follow = { kind: 'origin' };
    else if (id in BODIES) this.follow = { kind: 'body', id: id as BodyId };
    else if (this.smallBodies.has(id)) this.follow = { kind: 'small', id };
    this.applyFollow();
  }

  /** Frames the whole layout around the Sun. */
  frameAll(animate = true): void {
    const distance = this.radialMode === 'linear' ? 320 : 560;
    this.flyTo({ kind: 'origin' }, distance, animate);
  }

  /**
   * Frames one body so it fills a comfortable part of the view, and follows it.
   *
   * A body is framed to about a fifth of the viewport height. Earth with a craft in flight is
   * framed wider, because the point of looking at it is then what is around it.
   */
  frameBody(id: BodyId, animate = true): void {
    const visual = this.bodies.get(id);
    if (!visual) return;
    let distance = visual.trueRadius * 12 * this.localScaleFactor(id);
    if (id === 'earth' && this.trajectories.size > 0) distance *= 2;
    this.flyTo({ kind: 'body', id }, distance, animate);
  }

  /** Points the camera at a body's current scene position, keeping the stored distance. */
  centerOn(id: BodyId): void {
    this.flight = null;
    this.follow = { kind: 'body', id };
    this.applyFollow();
  }

  /** Points the camera at the midpoint of a body and its parent, sized to fit both. */
  centerOnPair(id: BodyId): void {
    if (!BODIES[id].parent) return;
    this.flight = null;
    this.follow = { kind: 'pair', id };
    this.distance = this.pairDistance(id) ?? this.distance;
    this.applyFollow();
  }

  /** A distance that fits a body and its parent with margin, or null if either is unplaced. */
  private pairDistance(id: BodyId): number | null {
    const parent = BODIES[id].parent;
    const a = this.scenePositions.get(id);
    const b = parent ? this.scenePositions.get(parent) : undefined;
    if (!a || !b) return null;
    // A 45-degree vertical field holds ~0.83 units of height per unit of distance; 1.7x the
    // separation keeps both clear of the edges at any orbit angle.
    return clamp(a.distanceTo(b) * 1.7, MIN_DISTANCE, MAX_DISTANCE);
  }

  /** Camera orbit input, called from the UI layer. */
  orbit(deltaAzimuth: number, deltaElevation: number): void {
    this.azimuth += deltaAzimuth;
    this.elevation = clamp(this.elevation + deltaElevation, -1.5, 1.5);
    this.updateCamera();
  }

  zoom(factor: number): void {
    const flight = this.flight;
    if (flight) {
      // Mid-flight, zoom rescales the flight rather than cancelling it: cancelling would snap
      // the camera onto the target in one frame.
      this.flight = {
        ...flight,
        fromDistance: flight.fromDistance * factor,
        toDistance: clamp(flight.toDistance * factor, MIN_DISTANCE, MAX_DISTANCE),
      };
      return;
    }
    this.distance = clamp(this.distance * factor, this.minDistance(), MAX_DISTANCE);
    this.updateCamera();
  }

  /** Never inside the followed body: a little above its true surface. */
  private minDistance(): number {
    if (this.follow.kind === 'small') {
      const small = this.smallBodies.get(this.follow.id);
      return small ? Math.max(MIN_DISTANCE, small.trueRadius * 1.15) : MIN_DISTANCE;
    }
    if (this.follow.kind !== 'body') return MIN_DISTANCE;
    const visual = this.bodies.get(this.follow.id);
    if (!visual) return MIN_DISTANCE;
    return Math.max(MIN_DISTANCE, visual.trueRadius * 1.15 * this.localScaleFactor(visual.id));
  }

  /** Starts a camera move to a new follow target and distance. */
  private flyTo(follow: Follow, distance: number, animate: boolean): void {
    const toDistance = clamp(distance, MIN_DISTANCE, MAX_DISTANCE);
    this.follow = follow;
    if (!animate || prefersReducedMotion()) {
      this.flight = null;
      this.distance = toDistance;
      this.applyFollow();
      return;
    }
    this.flight = {
      from: this.target.clone(),
      fromDistance: this.distance,
      toDistance,
      start: performance.now(),
    };
  }

  /** Where the follow target currently is. */
  private followPoint(out: THREE.Vector3): THREE.Vector3 {
    const f = this.follow;
    if (f.kind === 'origin') return out.set(0, 0, 0);
    if (f.kind === 'small') {
      const small = this.smallBodies.get(f.id);
      return small ? out.copy(small.mesh.position) : out.copy(this.target);
    }
    const p = this.scenePositions.get(f.id);
    if (!p) return out.copy(this.target);
    if (f.kind === 'body') return out.copy(p);
    const parent = BODIES[f.id].parent;
    const q = parent ? this.scenePositions.get(parent) : undefined;
    return q ? out.copy(p).add(q).multiplyScalar(0.5) : out.copy(p);
  }

  /** Re-aims the camera at the follow target, mid-flight or settled. */
  private applyFollow(): void {
    const goal = this.followPoint(new THREE.Vector3());
    const flight = this.flight;
    if (flight) {
      const t = Math.min(1, (performance.now() - flight.start) / FLY_MS);
      // Smoothstep: no jolt at either end.
      const s = t * t * (3 - 2 * t);
      this.target.copy(flight.from).lerp(goal, s);
      // Distance interpolates in log space, so a 1e5x zoom feels even rather than all at once.
      this.distance = Math.exp(
        Math.log(flight.fromDistance) +
          (Math.log(flight.toDistance) - Math.log(flight.fromDistance)) * s,
      );
      if (t >= 1) this.flight = null;
    } else {
      this.target.copy(goal);
    }
    this.updateCamera();
  }

  private updateCamera(): void {
    const sinE = Math.sin(this.elevation);
    const cosE = Math.cos(this.elevation);
    this.camera.position.set(
      this.target.x + this.distance * cosE * Math.cos(this.azimuth),
      this.target.y + this.distance * sinE,
      this.target.z + this.distance * cosE * Math.sin(this.azimuth),
    );
    this.camera.lookAt(this.target);
    // Depth range tied to the camera distance: near well inside the target, far enough to hold
    // the whole system (Neptune is 3,000 units out) from any close-up. Worst case is the LEO
    // view: near 5e-4, far 5e3, so depth resolves ~3e-7 units at Earth against a cloud shell
    // 5e-5 units above the surface.
    this.camera.near = Math.max(1e-8, this.distance * 1e-2);
    this.camera.far = Math.max(this.distance * 1e5, 5e3);
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
  }

  // --------------------------------------------------------------------------------------
  // Per-frame screen-space work
  // --------------------------------------------------------------------------------------

  /**
   * Sizes every body for this frame and applies the satellite rule.
   *
   * Each body is drawn at `max(true radius, minimum pixels)` for its own distance from the
   * camera, so a body you can resolve is its real size and one you cannot is a marker.
   */
  private updateBodySizes(): void {
    const height = this.viewportHeight();
    const fov = (this.camera.fov * Math.PI) / 180;
    for (const visual of this.bodies.values()) {
      const local = this.localScaleFactor(visual.id);
      const trueRadius = visual.trueRadius * local;
      const d = this.camera.position.distanceTo(visual.root.position);
      const upp = unitsPerPixelAt(d, fov, height);
      visual.drawnRadius = drawnRadiusUnits(trueRadius, upp, MIN_PIXEL_RADIUS[visual.id]);
      visual.drawnRadiusPx = upp > 0 ? visual.drawnRadius / upp : 0;
      visual.axis.scale.setScalar(visual.drawnRadius);
      for (const { sprite, factor } of visual.glows)
        sprite.scale.setScalar(visual.drawnRadius * factor);
    }

    for (const visual of this.bodies.values()) {
      const parent = BODIES[visual.id].parent;
      let shown = visual.root.userData.userHidden !== true;
      if (shown && parent && parent !== 'sun') {
        const pv = this.bodies.get(parent);
        if (pv) {
          const sepPx = this.screenDistancePx(visual.root.position, pv.root.position);
          shown = satelliteResolvable(sepPx, pv.drawnRadiusPx, visual.drawnRadiusPx);
        }
      }
      visual.shown = shown;
      visual.root.visible = shown;
    }

    // The Moon's path is drawn exactly when the Moon is.
    const moonPath = this.orbitLines.get('moon');
    if (moonPath)
      moonPath.visible = this.orbitsVisible && (this.bodies.get('moon')?.shown ?? false);

    // Planet orbits fade out in a close-up. From a few hundred thousand km a 1 AU orbit is a
    // straight line through the frame that carries no information, and the one passing the
    // camera is clipped mid-screen by the near plane, which reads as a rendering fault.
    const fade = smoothstep(0.12, 1.5, this.distance);
    for (const [id, line] of this.orbitLines) {
      if (id === 'moon') continue;
      (line.material as THREE.LineBasicMaterial).opacity = 0.42 * fade;
      line.visible = this.orbitsVisible && fade > 0.01;
    }

    // Small bodies: the same pixel-minimum rule. Only the selected one draws its orbit: nineteen
    // extra ellipses across the inner system bury the planets' orbits, which are the reference
    // everything else is read against.
    for (const visual of this.smallBodies.values()) {
      const local = localUnitsPerMetre(visual.helioDistance, this.radialMode) / UNITS_PER_M;
      const d = this.camera.position.distanceTo(visual.mesh.position);
      const upp = unitsPerPixelAt(d, fov, height);
      visual.drawnRadius = drawnRadiusUnits(visual.trueRadius * local, upp, SMALL_BODY_MIN_PX);
      visual.drawnRadiusPx = upp > 0 ? visual.drawnRadius / upp : 0;
      visual.mesh.scale.setScalar(visual.drawnRadius);
      const isSelected = visual.id === this.selected;
      visual.shown = this.smallBodiesVisible || isSelected;
      visual.mesh.visible = visual.shown;
      (visual.orbit.material as THREE.LineBasicMaterial).opacity = 0.65;
      visual.orbit.visible = isSelected && this.orbitsVisible;
    }
  }

  /**
   * Places labels just above each drawn disc and drops the ones that would overlap.
   *
   * Priority: the selected body, then the Sun, then by real size. At whole-system zoom the
   * inner planets are a few pixels apart, and overlapping names are unreadable; keeping the
   * more important one is better than printing both on top of each other.
   */
  private updateLabels(): void {
    const height = this.viewportHeight();
    const width = this.viewportWidth();
    const tanHalf = Math.tan((this.camera.fov * Math.PI) / 360);
    // Sprite scale that renders `LABEL_HEIGHT_PX` tall with `sizeAttenuation: false`.
    const scaleY = (LABEL_HEIGHT_PX * 2 * tanHalf) / height;
    const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);

    // Selected first, then the Sun, then planets by size, then small bodies by size. A small
    // body's name never pushes a planet's off the screen.
    const ranked = [...this.labelItems()].sort(
      (a, b) => b.priority - a.priority || b.trueRadius - a.trueRadius,
    );

    const placed: { x0: number; x1: number; y0: number; y1: number }[] = [];
    const ndc = new THREE.Vector3();
    for (const visual of ranked) {
      const label = visual.label;
      label.scale.set(scaleY * visual.labelAspect, scaleY, 1);
      label.position.copy(visual.position).addScaledVector(up, visual.drawnRadius);
      if (!this.labelsVisible || !visual.shown) {
        label.visible = false;
        continue;
      }
      ndc.copy(label.position).project(this.camera);
      if (ndc.z > 1 || ndc.z < -1) {
        label.visible = false;
        continue;
      }
      const cx = ((ndc.x + 1) / 2) * width;
      const by = ((1 - ndc.y) / 2) * height - LABEL_HEIGHT_PX * 0.15;
      const w = LABEL_HEIGHT_PX * visual.labelAspect;
      // The canvas has padding around the glyphs; shrink the box to the text itself.
      const rect = {
        x0: cx - w * 0.42,
        x1: cx + w * 0.42,
        y0: by - LABEL_HEIGHT_PX * 0.8,
        y1: by - LABEL_HEIGHT_PX * 0.2,
      };
      const clash = placed.some(
        (r) => rect.x0 < r.x1 && rect.x1 > r.x0 && rect.y0 < r.y1 && rect.y1 > r.y0,
      );
      label.visible = !clash;
      if (!clash) placed.push(rect);
    }
  }

  /** Everything that carries a label, in one shape for the decluttering pass. */
  private *labelItems(): Generator<{
    readonly label: THREE.Sprite;
    readonly labelAspect: number;
    readonly position: THREE.Vector3;
    readonly drawnRadius: number;
    readonly shown: boolean;
    readonly trueRadius: number;
    readonly priority: number;
  }> {
    for (const v of this.bodies.values()) {
      yield {
        label: v.label,
        labelAspect: v.labelAspect,
        position: v.root.position,
        drawnRadius: v.drawnRadius,
        shown: v.shown,
        trueRadius: v.trueRadius,
        priority: v.id === this.selected ? 3 : v.id === 'sun' ? 2 : 1,
      };
    }
    for (const v of this.smallBodies.values()) {
      yield {
        label: v.label,
        labelAspect: v.labelAspect,
        position: v.mesh.position,
        drawnRadius: v.drawnRadius,
        shown: v.shown,
        trueRadius: v.trueRadius,
        priority: v.id === this.selected ? 3 : 0,
      };
    }
  }

  /** The selected target's position and drawn size, planet or small body. */
  private selectedMarker(): { position: THREE.Vector3; drawnRadiusPx: number } | null {
    if (!this.selected) return null;
    const body = this.bodies.get(this.selected as BodyId);
    if (body)
      return body.shown
        ? { position: body.root.position, drawnRadiusPx: body.drawnRadiusPx }
        : null;
    const small = this.smallBodies.get(this.selected);
    return small?.shown
      ? { position: small.mesh.position, drawnRadiusPx: small.drawnRadiusPx }
      : null;
  }

  /** Holds the selection reticle around the selected body at a constant margin. */
  private updateReticle(): void {
    const visual = this.selectedMarker();
    if (!visual) {
      this.reticle.visible = false;
      return;
    }
    const height = this.viewportHeight();
    const tanHalf = Math.tan((this.camera.fov * Math.PI) / 360);
    const px = Math.min(visual.drawnRadiusPx + 7, height * 0.6) * 2;
    const s = (px * 2 * tanHalf) / height;
    // A body big enough to see plainly needs no marker around it.
    this.reticle.visible = visual.drawnRadiusPx < 18;
    this.reticle.scale.set(s, s, 1);
    this.reticle.position.copy(visual.position);
  }

  /** Holds every craft marker at a constant apparent size, about 5 px in radius. */
  private updateMarkerScales(): void {
    const height = this.viewportHeight();
    const fov = (this.camera.fov * Math.PI) / 180;
    const world = new THREE.Vector3();
    for (const visual of this.trajectories.values()) {
      visual.marker.getWorldPosition(world);
      const upp = unitsPerPixelAt(this.camera.position.distanceTo(world), fov, height);
      const groupScale = visual.group.scale.x || 1;
      visual.marker.scale.setScalar((5 * upp) / groupScale);
    }
  }

  /** Rotates every body's surface by wall time, so a paused planet stays alive. */
  private updateSpin(wallSeconds: number): void {
    for (const [id, visual] of this.bodies) {
      const rate = (SPIN_RATES[id] ?? 0.02) * SPIN_SENSE[id];
      visual.mesh.rotation.y = wallSeconds * rate;
      const clouds = visual.mesh.children[0];
      if (clouds?.userData.cloudShell) clouds.rotation.y = wallSeconds * rate * 0.18;
    }
  }

  private screenDistancePx(a: THREE.Vector3, b: THREE.Vector3): number {
    const pa = a.clone().project(this.camera);
    const pb = b.clone().project(this.camera);
    const dx = ((pa.x - pb.x) / 2) * this.viewportWidth();
    const dy = ((pa.y - pb.y) / 2) * this.viewportHeight();
    return Math.hypot(dx, dy);
  }

  private viewportHeight(): number {
    return this.container.clientHeight || 1;
  }

  private viewportWidth(): number {
    return this.container.clientWidth || 1;
  }

  // --------------------------------------------------------------------------------------
  // Input
  // --------------------------------------------------------------------------------------

  private handlePointerMove = (event: PointerEvent): void => {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    // Two fingers: pinch to zoom by the change in their separation. Checked before the drag,
    // so a pinch never also orbits.
    if (this.touches.has(event.pointerId)) {
      this.touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (this.touches.size === 2) {
        const [a, b] = [...this.touches.values()];
        const span = Math.hypot(a!.x - b!.x, a!.y - b!.y);
        if (this.pinchSpan > 0 && span > 0) this.zoom(this.pinchSpan / span);
        this.pinchSpan = span;
        return;
      }
    }

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
    this.renderer.domElement.style.cursor = hit ? 'pointer' : 'grab';
  };

  private handlePointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    this.touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
    this.renderer.domElement.setPointerCapture(event.pointerId);
    if (this.touches.size >= 2) {
      // A second finger turns the gesture into a pinch; it is never a click.
      this.drag = null;
      this.pinchSpan = 0;
      this.suppressNextClick = true;
      return;
    }
    this.drag = { lastX: event.clientX, lastY: event.clientY, moved: 0 };
  };

  private handlePointerUp = (event: PointerEvent): void => {
    this.touches.delete(event.pointerId);
    if (this.touches.size < 2) this.pinchSpan = 0;
    if (!this.drag) {
      if (this.renderer.domElement.hasPointerCapture(event.pointerId)) {
        this.renderer.domElement.releasePointerCapture(event.pointerId);
      }
      return;
    }
    const wasDrag = this.drag.moved > 4;
    this.drag = null;
    if (this.renderer.domElement.hasPointerCapture(event.pointerId)) {
      this.renderer.domElement.releasePointerCapture(event.pointerId);
    }
    if (wasDrag) this.suppressNextClick = true;
  };

  private handleWheel = (event: WheelEvent): void => {
    event.preventDefault();
    // Exponential zoom: a constant number of scroll units gives a constant perceived change.
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

  /** Double-click flies to a body, the gesture every map and planetarium uses. */
  private handleDoubleClick = (): void => {
    const hit = this.pick();
    if (hit) this.frameTarget(hit);
  };

  /** The planet, Moon, Sun or small body under the pointer, by id. */
  private pick(): string | null {
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const meshes = [
      ...[...this.bodies.values()].filter((v) => v.shown).map((v) => v.mesh),
      ...[...this.smallBodies.values()].filter((v) => v.shown).map((v) => v.mesh),
    ];
    const hits = this.raycaster.intersectObjects(meshes, false);
    const first = hits[0];
    if (!first) return null;
    const id = first.object.userData.bodyId ?? first.object.userData.smallBodyId;
    return typeof id === 'string' ? id : null;
  }

  resize = (): void => {
    const width = this.container.clientWidth || 1;
    const height = this.container.clientHeight || 1;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    for (const visual of this.trajectories.values()) {
      for (const material of visual.materials) {
        if (material instanceof LineMaterial) this.applyLineResolution(material);
      }
    }
  };

  // --------------------------------------------------------------------------------------
  // Frame
  // --------------------------------------------------------------------------------------

  /** Renders one frame. The caller owns timing; this only draws. */
  render(): void {
    if (this.disposed) return;
    if (this.flight) this.applyFollow();
    this.updateSpin(performance.now() / 1000);
    // The sky sits just inside the far plane, centred on the camera, so it is always at
    // "infinity" whatever the zoom. Built at radius 20000, scaled to fit.
    this.stars.position.copy(this.camera.position);
    this.stars.scale.setScalar((this.camera.far * 0.8) / 20000);
    this.updateBodySizes();
    this.updateLabels();
    this.updateReticle();
    this.updateMarkerScales();
    this.renderer.render(this.scene, this.camera);
  }

  /** Runs a render loop, used only when the app is not driving frames itself. */
  start(): void {
    const loop = () => {
      if (this.disposed) return;
      this.render();
      this.frameId = requestAnimationFrame(loop);
    };
    this.frameId = requestAnimationFrame(loop);
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frameId);
    window.removeEventListener('resize', this.resize);
    const el = this.renderer.domElement;
    el.removeEventListener('pointermove', this.handlePointerMove);
    el.removeEventListener('pointerdown', this.handlePointerDown);
    el.removeEventListener('pointerup', this.handlePointerUp);
    el.removeEventListener('pointercancel', this.handlePointerUp);
    el.removeEventListener('click', this.handleClick);
    el.removeEventListener('dblclick', this.handleDoubleClick);
    el.removeEventListener('wheel', this.handleWheel);

    for (const visual of this.trajectories.values()) this.disposeTrajectory(visual);
    this.trajectories.clear();

    const disposed = new Set<unknown>();
    const once = (thing: { dispose(): void } | null | undefined): void => {
      if (!thing || disposed.has(thing)) return;
      disposed.add(thing);
      thing.dispose();
    };
    this.scene.traverse((obj) => {
      if (obj instanceof THREE.Mesh || obj instanceof THREE.Points || obj instanceof THREE.Line) {
        once(obj.geometry);
        const material = obj.material as THREE.Material | THREE.Material[];
        for (const m of Array.isArray(material) ? material : [material]) {
          once((m as THREE.MeshStandardMaterial).map);
          once((m as THREE.MeshStandardMaterial).emissiveMap);
          once(m);
        }
      } else if (obj instanceof THREE.Sprite) {
        once(obj.material.map);
        once(obj.material);
      }
    });
    once(this.craftGeometry);
    once(this.glowTexture);

    this.renderer.dispose();
    el.remove();
  }
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Deterministic pseudo-random in [0,1) from an integer, for the starfield. */
function hash01(n: number): number {
  let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}
