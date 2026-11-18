/**
 * Immutable 3D vector math. Spacecraft states are in metres and metres/second;
 * angles are radians; SI throughout. No allocation-free tricks in v1: clarity wins,
 * and the measured performance (see TESTING.md) has plenty of headroom.
 */

export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export const vec3 = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

export const ZERO: Vec3 = vec3(0, 0, 0);
export const X_AXIS: Vec3 = vec3(1, 0, 0);
export const Y_AXIS: Vec3 = vec3(0, 1, 0);
export const Z_AXIS: Vec3 = vec3(0, 0, 1);

export const add = (a: Vec3, b: Vec3): Vec3 => vec3(a.x + b.x, a.y + b.y, a.z + b.z);
export const sub = (a: Vec3, b: Vec3): Vec3 => vec3(a.x - b.x, a.y - b.y, a.z - b.z);
export const scale = (a: Vec3, s: number): Vec3 => vec3(a.x * s, a.y * s, a.z * s);
export const negate = (a: Vec3): Vec3 => vec3(-a.x, -a.y, -a.z);

export const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;

export const cross = (a: Vec3, b: Vec3): Vec3 =>
  vec3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);

export const lengthSq = (a: Vec3): number => a.x * a.x + a.y * a.y + a.z * a.z;
export const length = (a: Vec3): number => Math.sqrt(lengthSq(a));

export const distance = (a: Vec3, b: Vec3): number => length(sub(a, b));
export const distanceSq = (a: Vec3, b: Vec3): number => lengthSq(sub(a, b));

/** Returns the zero vector for a zero-length input rather than NaN. */
export const normalize = (a: Vec3): Vec3 => {
  const len = length(a);
  return len === 0 ? ZERO : scale(a, 1 / len);
};

export const lerp = (a: Vec3, b: Vec3, t: number): Vec3 =>
  vec3(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);

export const equalsApprox = (a: Vec3, b: Vec3, tol: number): boolean =>
  Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol && Math.abs(a.z - b.z) <= tol;

/** Angle between two vectors in radians, clamped against floating-point overshoot. */
export const angleBetween = (a: Vec3, b: Vec3): number => {
  const la = length(a);
  const lb = length(b);
  if (la === 0 || lb === 0) return 0;
  const c = dot(a, b) / (la * lb);
  return Math.acos(Math.max(-1, Math.min(1, c)));
};

/** Projects `a` onto the direction of `onto`. Returns zero if `onto` is zero. */
export const projectOnto = (a: Vec3, onto: Vec3): Vec3 => {
  const d = dot(onto, onto);
  return d === 0 ? ZERO : scale(onto, dot(a, onto) / d);
};

/** Component of `a` perpendicular to `onto`. */
export const rejectFrom = (a: Vec3, onto: Vec3): Vec3 => sub(a, projectOnto(a, onto));

/** Arbitrary unit vector perpendicular to `a` (stable for any non-zero input). */
export const anyPerpendicular = (a: Vec3): Vec3 => {
  const helper = Math.abs(a.x) < 0.9 * length(a) ? X_AXIS : Y_AXIS;
  return normalize(cross(a, helper));
};

/**
 * Right-handed rotation of `v` about unit axis `axis` by `angle` radians (Rodrigues).
 * The axis is assumed unit; pass it through {@link normalize} if unsure.
 */
export const rotateAboutAxis = (v: Vec3, axis: Vec3, angle: number): Vec3 => {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const k = cross(axis, v);
  const d = dot(axis, v);
  return vec3(
    v.x * c + k.x * s + axis.x * d * (1 - c),
    v.y * c + k.y * s + axis.y * d * (1 - c),
    v.z * c + k.z * s + axis.z * d * (1 - c),
  );
};

/** Rotation about the X axis by `angle` radians. */
export const rotateX = (v: Vec3, angle: number): Vec3 => {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return vec3(v.x, v.y * c - v.z * s, v.y * s + v.z * c);
};

/** Rotation about the Z axis by `angle` radians. */
export const rotateZ = (v: Vec3, angle: number): Vec3 => {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return vec3(v.x * c - v.y * s, v.x * s + v.y * c, v.z);
};

/** Rotation about the Y axis by `angle` radians. */
export const rotateY = (v: Vec3, angle: number): Vec3 => {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return vec3(v.x * c + v.z * s, v.y, -v.x * s + v.z * c);
};
