/**
 * Maneuver-node editing: parse what a person typed, validate it, and apply it to a mission.
 *
 * Pure, like the other view models, so every rule is a unit test rather than a click-through.
 * The panel holds the text of a draft; nothing touches the mission until `applyNodeDraft`
 * says the draft is valid, and then the change is one immutable replacement, so the plan is
 * re-propagated exactly once.
 *
 * Horizon rules are shared with porkchop departures (`transferView.ts`): a node after the end
 * of the plan extends it by a day of coast, a two-body plan may grow to 1500 days, and an
 * N-body plan is never extended (months of N-body integration is not interactive).
 */

import { SECONDS_PER_DAY } from '../core/constants.js';
import type { CraftSpec } from '../sim/craft.js';
import type { Maneuver, ManeuverFrame } from '../sim/maneuver.js';
import { DEPARTURE_COAST_SECONDS, MAX_DEPARTURE_HORIZON_DAYS } from './transferView.js';

/** A burn as typed: every field is the raw text of its input. */
export interface NodeDraft {
  /** Null for a new node; the id of the node being edited otherwise. */
  readonly id: string | null;
  readonly label: string;
  /** Mission elapsed time: "5400", "1:30:00", "T+01:30:00", "2d 03:00:00" or "2.5d". */
  readonly time: string;
  readonly a: string;
  readonly b: string;
  readonly c: string;
  readonly frame: ManeuverFrame;
}

export interface DraftIssue {
  readonly field: keyof NodeDraft;
  readonly message: string;
}

export type DraftResult =
  | { readonly ok: true; readonly craft: CraftSpec; readonly note: string | null }
  | { readonly ok: false; readonly issues: readonly DraftIssue[] };

/**
 * Largest single burn accepted, m/s. Far beyond any chemical stage (a whole Saturn V delivered
 * about 12 km/s), so it only catches a slipped digit, never a real plan.
 */
export const MAX_BURN_MS = 20_000;

/**
 * Parses a mission elapsed time to seconds, or returns null.
 *
 * Accepts plain seconds, `h:mm:ss` or `mm:ss`, an optional `T+` prefix, and an optional day
 * count (`2d`, `2d 03:00:00`, `1.5d`). Negative times are rejected: a node before the epoch
 * cannot be flown.
 */
export function parseMissionTime(text: string): number | null {
  let s = text.trim().replace(/^T\+\s*/i, '');
  if (s === '') return null;
  let days = 0;
  const d = /^(\d+(?:\.\d+)?)\s*d\b\s*/i.exec(s);
  if (d) {
    days = Number(d[1]);
    s = s.slice(d[0].length);
  }
  let seconds = 0;
  if (s !== '') {
    if (/^\d+(\.\d+)?$/.test(s)) {
      seconds = Number(s);
    } else {
      const parts = s.split(':');
      if (parts.length < 2 || parts.length > 3) return null;
      if (!parts.every((p) => /^\d+(\.\d+)?$/.test(p))) return null;
      const nums = parts.map(Number);
      const [h, m, sec] = nums.length === 3 ? nums : [0, nums[0]!, nums[1]!];
      // The leading field is unbounded ("90:00" is ninety minutes); the ones after it are not.
      if (sec! >= 60 || (nums.length === 3 && m! >= 60)) return null;
      seconds = h! * 3600 + m! * 60 + sec!;
    }
  }
  const total = days * SECONDS_PER_DAY + seconds;
  return Number.isFinite(total) ? total : null;
}

/** `T+01:30:00`, or `T+2d 03:00:00` past a day. The inverse of `parseMissionTime`. */
export function formatMissionTime(seconds: number): string {
  let s = Math.max(0, Math.round(seconds));
  const days = Math.floor(s / SECONDS_PER_DAY);
  s -= days * SECONDS_PER_DAY;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `T+${days > 0 ? `${days}d ` : ''}${p2(h)}:${p2(m)}:${p2(sec)}`;
}

/** A draft pre-filled from an existing node, for editing it. */
export function draftFromNode(node: Maneuver): NodeDraft {
  return {
    id: node.id,
    label: node.label ?? '',
    time: formatMissionTime(node.timeSeconds),
    a: String(node.a),
    b: String(node.b),
    c: String(node.c),
    frame: node.frame,
  };
}

/** An empty prograde burn at a given time, for adding a node. */
export function newDraft(atSeconds: number): NodeDraft {
  return {
    id: null,
    label: '',
    time: formatMissionTime(atSeconds),
    a: '0',
    b: '0',
    c: '0',
    frame: 'local',
  };
}

/** The first `node-N` id the mission does not already use. */
export function nextNodeId(craft: CraftSpec): string {
  const used = new Set(craft.maneuvers.map((m) => m.id));
  let n = craft.maneuvers.length + 1;
  while (used.has(`node-${n}`)) n++;
  return `node-${n}`;
}

function parseComponent(text: string, field: 'a' | 'b' | 'c', issues: DraftIssue[]): number {
  const t = text.trim();
  const v = t === '' ? 0 : Number(t);
  if (!Number.isFinite(v)) {
    issues.push({ field, message: 'must be a number of metres per second' });
    return 0;
  }
  return v;
}

/**
 * Validates a draft and, if it is valid, returns the mission with the node added or replaced.
 *
 * `note` reports a side effect the person should know about, such as the plan being extended.
 */
export function applyNodeDraft(craft: CraftSpec, draft: NodeDraft): DraftResult {
  const issues: DraftIssue[] = [];
  const time = parseMissionTime(draft.time);
  if (time === null) {
    issues.push({
      field: 'time',
      message: 'use seconds, h:mm:ss, or a day count such as 2d 03:00:00',
    });
  }
  const a = parseComponent(draft.a, 'a', issues);
  const b = parseComponent(draft.b, 'b', issues);
  const c = parseComponent(draft.c, 'c', issues);
  const magnitude = Math.hypot(a, b, c);
  if (issues.length === 0 && magnitude === 0) {
    issues.push({ field: 'a', message: 'a burn needs a non-zero delta-v in at least one axis' });
  }
  if (magnitude > MAX_BURN_MS) {
    issues.push({
      field: 'a',
      message: `${(magnitude / 1000).toFixed(1)} km/s is beyond any real stage (limit ${MAX_BURN_MS / 1000} km/s)`,
    });
  }
  if (draft.label.length > 60)
    issues.push({ field: 'label', message: 'keep it under 60 characters' });
  if (draft.id !== null && !craft.maneuvers.some((m) => m.id === draft.id)) {
    issues.push({ field: 'id', message: 'that node no longer exists' });
  }
  if (issues.length > 0 || time === null) return { ok: false, issues };

  const id = draft.id ?? nextNodeId(craft);
  const label = draft.label.trim();
  const node: Maneuver = {
    id,
    timeSeconds: time,
    a,
    b,
    c,
    frame: draft.frame,
    ...(label ? { label } : {}),
  };
  const maneuvers = [...craft.maneuvers.filter((m) => m.id !== id), node].sort(
    (x, y) => x.timeSeconds - y.timeSeconds || x.id.localeCompare(y.id),
  );

  if (time <= craft.horizonSeconds) {
    return { ok: true, craft: { ...craft, maneuvers }, note: null };
  }
  if (craft.propagation === 'nbody') {
    return {
      ok: false,
      issues: [
        {
          field: 'time',
          message:
            'is past the end of this N-body plan, and extending an N-body plan is not interactive',
        },
      ],
    };
  }
  const wanted = time + DEPARTURE_COAST_SECONDS;
  if (wanted > MAX_DEPARTURE_HORIZON_DAYS * SECONDS_PER_DAY) {
    return {
      ok: false,
      issues: [
        { field: 'time', message: `is past the ${MAX_DEPARTURE_HORIZON_DAYS}-day planning limit` },
      ],
    };
  }
  return {
    ok: true,
    craft: { ...craft, maneuvers, horizonSeconds: wanted },
    note: `The plan was extended to ${formatMissionTime(wanted)} so the burn is flown.`,
  };
}

/** The mission without one node. Unknown ids leave it unchanged. */
export function removeNode(craft: CraftSpec, id: string): CraftSpec {
  return { ...craft, maneuvers: craft.maneuvers.filter((m) => m.id !== id) };
}
