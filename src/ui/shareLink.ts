/**
 * Share links: the current view, encoded in the URL fragment.
 *
 * The fragment (`#...`) rather than the query string, because a fragment is never sent to a
 * server: the app stays "no data leaves this machine" even when the page is hosted. A link
 * names a *bundled* scenario by id, the instant, the selected target, the warp, the layout and
 * the camera. That is enough to put a second person in front of exactly the same picture.
 *
 * What it deliberately does not carry: a scenario opened from a file, or a departure node
 * planned in this session. Those are user data with their own export (the scenario file), and
 * stuffing them into a URL would make links long, fragile and silently lossy.
 *
 * Parsing is total: any malformed field is dropped, never thrown, and the app falls back to its
 * normal boot for whatever is missing. A hand-edited or truncated link must not break the page.
 */

import type { RadialMode } from '../render/scale.js';
import { WARP_STEPS, type Warp } from '../sim/clock.js';

export const SHARE_LINK_VERSION = 1;

export interface ShareState {
  readonly scenarioId: string;
  /** ISO-8601 UTC instant, whole seconds. */
  readonly timeUtc: string;
  /** A `BodyId` or a small-body id. */
  readonly selected: string;
  readonly warp: Warp;
  readonly radialMode: RadialMode;
  readonly camera: {
    readonly azimuthRad: number;
    readonly elevationRad: number;
    readonly distanceUnits: number;
    /** What the camera follows: a target id, or null for the Sun-centred view. */
    readonly follow: string | null;
  };
}

/** Builds the fragment, without the leading `#`. Angles to 4 decimals, distance to 5 figures. */
export function encodeShareLink(state: ShareState): string {
  const p = new URLSearchParams();
  p.set('v', String(SHARE_LINK_VERSION));
  p.set('s', state.scenarioId);
  p.set('t', state.timeUtc);
  p.set('sel', state.selected);
  p.set('w', String(state.warp));
  p.set('m', state.radialMode);
  p.set(
    'cam',
    [
      state.camera.azimuthRad.toFixed(4),
      state.camera.elevationRad.toFixed(4),
      state.camera.distanceUnits.toPrecision(5),
    ].join(','),
  );
  if (state.camera.follow) p.set('f', state.camera.follow);
  return p.toString();
}

/** A partially valid link decodes to whatever fields were valid. */
export type ParsedShareLink = Partial<ShareState> & { readonly camera?: ShareState['camera'] };

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/** Reads a fragment (with or without `#`). Returns null when it is not a share link at all. */
export function parseShareLink(fragment: string): ParsedShareLink | null {
  const p = new URLSearchParams(fragment.replace(/^#/, ''));
  if (p.get('v') !== String(SHARE_LINK_VERSION)) return null;

  const out: { -readonly [K in keyof ShareState]?: ShareState[K] } = {};
  const s = p.get('s');
  if (s && ID.test(s)) out.scenarioId = s;
  const t = p.get('t');
  if (t && ISO.test(t) && Number.isFinite(Date.parse(t))) out.timeUtc = t;
  const sel = p.get('sel');
  if (sel && ID.test(sel)) out.selected = sel;
  const w = Number(p.get('w'));
  if ((WARP_STEPS as readonly number[]).includes(w)) out.warp = w as Warp;
  const m = p.get('m');
  if (m === 'linear' || m === 'compressed') out.radialMode = m;

  const cam = (p.get('cam') ?? '').split(',').map(Number);
  const [az, el, dist] = cam;
  if (
    cam.length === 3 &&
    Number.isFinite(az) &&
    Number.isFinite(el) &&
    Math.abs(el!) < Math.PI / 2 &&
    Number.isFinite(dist) &&
    dist! > 0
  ) {
    const f = p.get('f');
    out.camera = {
      azimuthRad: az!,
      elevationRad: el!,
      distanceUnits: dist!,
      follow: f && ID.test(f) ? f : null,
    };
  }
  return out;
}
