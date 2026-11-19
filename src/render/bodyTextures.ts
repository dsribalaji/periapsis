/**
 * Procedural surface textures for the bodies.
 *
 * Every body is a sphere with a flat colour today, which is why the view reads as a diagram
 * rather than a place. These generate real per-body colour maps: continents and ice on Earth,
 * maria and craters on the Moon, banded turbulence on the gas giants, a granulated photosphere
 * on the Sun.
 *
 * Three rules, all inherited from this project rather than invented here:
 *
 * - **Deterministic.** No `Math.random`; every pixel is a pure function of its position and a
 *   seed (`noise.ts`). The same build produces the same planet, and a screenshot can be
 *   compared against a later one.
 * - **No network.** Textures are drawn into a canvas at runtime, so the app stays offline and
 *   ships no image assets (SETUP.md, "Offline").
 * - **No licensing question.** A procedurally generated Jupiter is ours; a photograph of it is
 *   not, and D-004 already refused to take that on for coastlines for exactly this reason.
 *
 * Resolution is chosen per body from its on-screen size, not uniformly: the Sun is the largest
 * disc in the default view and gets the most pixels, while Mercury is a few units across and
 * does not need 2048.
 */

import * as THREE from 'three';
import type { BodyId } from '../core/ephemeris/solarSystem.js';
import { clamp01, fbm3, ridged3, smoothstep, valueNoise3 } from './noise.js';

/**
 * Texture edge in pixels for a body.
 *
 * These are deliberately small. The generator is a per-pixel noise loop on the main thread, so
 * cost is quadratic in size, and the first version of this file asked for 1024x1024 for the Sun
 * and 512 for most planets — 2.8 M pixels and about 1.8 billion hash operations, which measured
 * **14.7 s to boot**. That is not a rendering cost; it is a blank window.
 *
 * Sizes follow how many pixels each body can actually cover: Jupiter is ~30 px wide in the
 * whole-system view and never more than a few hundred anywhere, so 128 is ample. Earth and the
 * Sun are the two the camera can approach closely — Earth fills the viewport in `leo-raise` and
 * the Sun reaches ~460 px in the inner system — so they get 256. Measured total for all bodies:
 * about 760 ms, against 14.7 s before.
 */
function textureSize(id: BodyId, displayRadius: number): number {
  if (id === 'earth' || id === 'sun') return 256;
  if (displayRadius > 1.5) return 128;
  return 96;
}

/** RGB triple, 0-255. */
type Rgb = readonly [number, number, number];

const mix = (a: Rgb, b: Rgb, t: number): Rgb => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

/** Writes a colour into an RGBA buffer. */
function put(data: Uint8ClampedArray, offset: number, c: Rgb, alpha = 255): void {
  data[offset] = c[0];
  data[offset + 1] = c[1];
  data[offset + 2] = c[2];
  data[offset + 3] = alpha;
}

/**
 * Generates a colour map for one body.
 *
 * The loops run per pixel rather than per texel of a 2D noise field because the noise is
 * sampled on the unit sphere: `(sin φ cos λ, sin φ sin λ, cos φ)` in physics axes, where the
 * poles are the *equator of the texture*. That mapping is what makes the result seamless —
 * longitude wraps without a seam because the sample is a direction, not a coordinate.
 */
export function generateSurface(id: BodyId, size: number): THREE.DataTexture {
  const data = new Uint8ClampedArray(size * size * 4);

  for (let y = 0; y < size; y++) {
    // v from 0 (north pole) to 1 (south pole).
    const v = (y + 0.5) / size;
    const polar = v * Math.PI;
    const sinPolar = Math.sin(polar);
    const cosPolar = Math.cos(polar);

    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const lon = u * 2 * Math.PI;
      // Unit direction on the sphere. Longitude is the fast axis, as in an equirectangular map.
      const nx = sinPolar * Math.cos(lon);
      const ny = sinPolar * Math.sin(lon);
      const nz = cosPolar;

      const offset = (y * size + x) * 4;
      put(data, offset, colourAt(id, nx, ny, nz, polar), surfaceAlpha(id, polar));
    }
  }

  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}

/** Alpha, 255 everywhere except a body with an atmosphere handled separately. */
function surfaceAlpha(_id: BodyId, _polar: number): number {
  return 255;
}

/** The colour of one surface point, by body. */
function colourAt(id: BodyId, nx: number, ny: number, nz: number, polar: number): Rgb {
  switch (id) {
    case 'sun':
      return sunSurface(nx, ny, nz);
    case 'mercury':
      return rockySurface(nx, ny, nz, 11, [96, 90, 84], [151, 142, 130], 0.9);
    case 'venus':
      return venusSurface(nx, ny, nz, polar);
    case 'earth':
      return earthSurface(nx, ny, nz, polar);
    case 'moon':
      return moonSurface(nx, ny, nz);
    case 'mars':
      return marsSurface(nx, ny, nz, polar);
    case 'jupiter':
      return gasGiant(nx, ny, nz, 5, [
        [222, 184, 135],
        [184, 134, 96],
        [244, 228, 200],
        [148, 104, 78],
      ]);
    case 'saturn':
      return gasGiant(nx, ny, nz, 4, [
        [235, 214, 168],
        [212, 188, 141],
        [246, 236, 208],
        [190, 164, 120],
      ]);
    case 'uranus':
      return gasGiant(nx, ny, nz, 2, [
        [174, 226, 230],
        [150, 208, 216],
        [196, 238, 240],
        [140, 196, 208],
      ]);
    case 'neptune':
      return gasGiant(nx, ny, nz, 3, [
        [72, 108, 200],
        [56, 88, 178],
        [104, 140, 224],
        [44, 72, 152],
      ]);
    default:
      return [150, 150, 150];
  }
}

/**
 * The Sun: a granulated photosphere with brighter faculae and cooler granules.
 *
 * Emissive, so it is the light source as well as a surface. The variation is deliberately low
 * contrast — a high-contrast Sun reads as a cartoon cheese, not a star.
 */
function sunSurface(nx: number, ny: number, nz: number): Rgb {
  const gran = fbm3(nx * 7, ny * 7, nz * 7, 4, 3);
  const cells = ridged3(nx * 14, ny * 14, nz * 14, 3, 7);
  const t = clamp01(gran * 0.65 + cells * 0.35);
  // A photosphere is white-hot with only a slight warm cast. The obvious choice — a saturated
  // orange — is what a star looks like *through an atmosphere*, and it also collides with the
  // mission-orange colour the app uses for trajectories (which is how a test caught it).
  const cool: Rgb = [255, 196, 120];
  const hot: Rgb = [255, 250, 232];
  return mix(cool, hot, smoothstep(0.25, 0.85, t));
}

/**
 * Mercury: heavy cratering, almost no albedo variation beyond the craters.
 *
 * Craters are added as bright rims and dark bowls on top of the base rock, using a low-frequency
 * ridged field so the same feature survives across neighbouring pixels.
 */
function rockySurface(
  nx: number,
  ny: number,
  nz: number,
  seed: number,
  dark: Rgb,
  light: Rgb,
  contrast: number,
): Rgb {
  const base = fbm3(nx * 4, ny * 4, nz * 4, 5, seed);
  const craters = ridged3(nx * 9, ny * 9, nz * 9, 4, seed + 17);
  const t = clamp01(base * 0.55 + craters * 0.45);
  return mix(dark, light, smoothstep(0.2, 0.8, t) * contrast);
}

/**
 * Venus: a featureless sulphuric cloud deck, which is the *truthful* render.
 *
 * Venus has no visible surface from outside; its clouds are a bright cream with faint
 * super-rotating banding. Drawing continents would be a prettier lie.
 */
function venusSurface(nx: number, ny: number, nz: number, polar: number): Rgb {
  const swirl = fbm3(nx * 3, ny * 3, nz * 6, 4, 23);
  const bands = Math.sin(polar * 9 + swirl * 2.4) * 0.5 + 0.5;
  const t = clamp01(swirl * 0.6 + bands * 0.4);
  return mix([196, 160, 104], [240, 222, 178], smoothstep(0.25, 0.8, t));
}

/**
 * Earth: oceans, continents, ice caps and a separate cloud shell.
 *
 * Continents come from fbm thresholded at sea level — the standard cheap technique, and honest
 * here because nothing in this model claims to know where Earth's real coastlines are. The
 * `PHYSICS.md` caveat about approximate ephemerides applies to positions; this is scenery.
 */
function earthSurface(nx: number, ny: number, nz: number, polar: number): Rgb {
  const continent = fbm3(nx * 2.6, ny * 2.6, nz * 2.6, 6, 101);
  const detail = fbm3(nx * 12, ny * 12, nz * 12, 3, 211);

  // Latitude from the polar angle, so the caps sit on the poles of the texture, not the sphere.
  const lat = Math.abs(Math.cos(polar));
  // Sea level tuned so roughly a third of the sphere is land.
  const seaLevel = 0.52;

  const deepSea: Rgb = [16, 44, 92];
  const shallowSea: Rgb = [32, 96, 150];
  const beach: Rgb = [196, 184, 140];
  const grass: Rgb = [64, 106, 56];
  const forest: Rgb = [38, 78, 44];
  const rock: Rgb = [124, 116, 104];

  let c: Rgb;
  if (continent < seaLevel) {
    // Ocean, shaded by depth.
    const depth = smoothstep(seaLevel - 0.16, seaLevel, continent);
    c = mix(deepSea, shallowSea, depth);
  } else {
    const land = smoothstep(seaLevel, seaLevel + 0.1, continent);
    const rockiness = smoothstep(0.62, 0.85, continent + detail * 0.2);
    const green = mix(beach, grass, smoothstep(0, 0.25, land));
    const veg = mix(green, forest, smoothstep(0.2, 0.7, land) * (1 - rockiness));
    c = mix(veg, rock, rockiness);
  }

  // Ice caps, wider at the poles, with a ragged edge from the detail field.
  const iceEdge = 0.80 + detail * 0.06;
  const ice = smoothstep(iceEdge, iceEdge + 0.1, lat);
  c = mix(c, [232, 240, 248], ice);

  return c;
}

/**
 * The Moon: dark maria (the "seas"), bright highlands, and crater rims.
 *
 * The maria are large low-albedo basalt plains concentrated on the near side; a noise threshold
 * at low frequency reproduces the look without pretending to place the real ones.
 */
function moonSurface(nx: number, ny: number, nz: number): Rgb {  const maria = fbm3(nx * 1.8, ny * 1.8, nz * 1.8, 4, 311);
  const regolith = fbm3(nx * 9, ny * 9, nz * 9, 5, 401);
  const craters = ridged3(nx * 16, ny * 16, nz * 16, 4, 533);

  const highland: Rgb = [186, 184, 180];
  const mare: Rgb = [74, 74, 78];

  const sea = smoothstep(0.42, 0.56, maria);
  let c = mix(highland, mare, sea);
  // Craters: bright rims, and the regolith mottling underneath.
  const rim = smoothstep(0.62, 0.86, craters);
  c = mix(c, [222, 220, 214], rim * 0.55);
  c = mix(c, [150, 148, 146], clamp01(regolith * 0.3));
  return c;
}

/**
 * Mars: the red deserts, the dark albedo features, the polar caps.
 *
 * The `polar` argument is used directly for the caps because Mars' caps are the most visible
 * thing about it and they are cleaner as a latitude ramp than as noise.
 */
function marsSurface(nx: number, ny: number, nz: number, polar: number): Rgb {
  const terrain = fbm3(nx * 3.4, ny * 3.4, nz * 3.4, 5, 601);
  const dust = fbm3(nx * 10, ny * 10, nz * 10, 3, 701);

  const darkRust: Rgb = [122, 54, 30];
  const rust: Rgb = [178, 88, 48];
  const sand: Rgb = [206, 132, 86];

  const t = clamp01(terrain * 0.7 + dust * 0.3);
  let c = mix(darkRust, rust, smoothstep(0.25, 0.6, t));
  c = mix(c, sand, smoothstep(0.55, 0.85, t) * 0.7);

  // Polar caps, ragged.
  const lat = Math.abs(Math.cos(polar));
  const capEdge = 0.92 + dust * 0.03;
  c = mix(c, [236, 240, 244], smoothstep(capEdge, capEdge + 0.05, lat));
  return c;
}

/**
 * A gas giant: horizontal bands warped by turbulence.
 *
 * The banding is a function of latitude, and the turbulence is fbm sampled with the latitude
 * stretched, which produces the sheared, streaky structure of a real giant rather than
 * isotropic blobs.
 */
function gasGiant(
  nx: number,
  ny: number,
  nz: number,
  bandCount: number,
  palette: readonly [Rgb, Rgb, Rgb, Rgb],
): Rgb {
  const lat = nz; // -1..1
  // Turbulence: stretched along longitude.
  const warp = fbm3(nx * 2.2, ny * 2.2, nz * 9, 5, 811) - 0.5;
  const bands = Math.sin((lat + warp * 0.18) * Math.PI * bandCount) * 0.5 + 0.5;
  const fine = fbm3(nx * 7, ny * 7, nz * 26, 4, 907);

  const idx = bands * 3;
  const i0 = Math.min(2, Math.floor(idx));
  const c = mix(palette[i0]!, palette[i0 + 1]!, clamp01(idx - i0));
  // A little fine turbulence so the bands are not perfect stripes.
  return mix(c, palette[i0 + 1]!, (fine - 0.5) * 0.25);
}

/**
 * A cloud shell for Earth: white, transparent elsewhere.
 *
 * Separate from the surface so the clouds can rotate slightly faster than the ground, which is
 * what real cloud decks do and what makes the planet look alive rather than painted on.
 */
export function generateClouds(size: number): THREE.DataTexture {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) / size;
    const polar = v * Math.PI;
    const sinPolar = Math.sin(polar);
    const cosPolar = Math.cos(polar);
    for (let x = 0; x < size; x++) {
      const lon = ((x + 0.5) / size) * 2 * Math.PI;
      const nx = sinPolar * Math.cos(lon);
      const ny = sinPolar * Math.sin(lon);
      const nz = cosPolar;

      // Swirled cloud masses, with banding in the mid-latitudes.
      const swirl = fbm3(nx * 3.1, ny * 3.1, nz * 3.1, 5, 1301);
      const bands = Math.sin(polar * 7 + swirl * 3) * 0.5 + 0.5;
      const density = clamp01(swirl * 0.72 + bands * 0.28);
      const alpha = smoothstep(0.5, 0.82, density) * 235;

      const offset = (y * size + x) * 4;
      put(data, offset, [246, 248, 252], alpha);
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

/** Texture size for a body's display radius, exported so callers and tests agree. */
export { textureSize };

/** A cheap ring texture for Saturn: concentric bands of varying opacity. */
export function generateRings(width: number): THREE.DataTexture {
  const height = 8;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let x = 0; x < width; x++) {
    const t = (x + 0.5) / width;
    // Cassini-like gaps at fixed fractional radii.
    const gap =
      smoothstep(0.42, 0.46, t) * (1 - smoothstep(0.5, 0.54, t)) +
      smoothstep(0.74, 0.77, t) * (1 - smoothstep(0.78, 0.8, t));
    const band = 0.55 + 0.45 * Math.sin(t * 90) * 0.5 + 0.25 * valueNoise3(t * 40, 0, 0, 17);
    const alpha = clamp01(band * (1 - gap * 0.95)) * 190 * smoothstep(0, 0.06, t) * (1 - smoothstep(0.92, 1, t));
    for (let y = 0; y < height; y++) {
      const offset = (y * width + x) * 4;
      put(data, offset, [226, 208, 170], alpha);
    }
  }
  const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}
