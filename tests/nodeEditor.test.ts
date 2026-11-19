import { describe, expect, it } from 'vitest';
import {
  applyNodeDraft,
  draftFromNode,
  formatMissionTime,
  newDraft,
  nextNodeId,
  parseMissionTime,
  removeNode,
  type NodeDraft,
} from '../src/ui/nodeEditor.js';
import { scenarioById } from '../src/scenarios/catalogue.js';
import type { CraftSpec } from '../src/sim/craft.js';

const leo = (): CraftSpec => scenarioById('leo-raise')!.mission!;
const freeReturn = (): CraftSpec => scenarioById('lunar-free-return')!.mission!;
const draft = (patch: Partial<NodeDraft>): NodeDraft => ({ ...newDraft(600), a: '10', ...patch });

describe('mission time', () => {
  it('reads every accepted form', () => {
    expect(parseMissionTime('5400')).toBe(5400);
    expect(parseMissionTime('1:30:00')).toBe(5400);
    expect(parseMissionTime('T+01:30:00')).toBe(5400);
    expect(parseMissionTime('t+ 90:00')).toBe(5400);
    expect(parseMissionTime('2d')).toBe(172800);
    expect(parseMissionTime('2d 03:00:00')).toBe(172800 + 10800);
    expect(parseMissionTime('1.5d')).toBe(129600);
  });

  it('rejects what it cannot read rather than guessing', () => {
    for (const bad of ['', 'soon', '-5', '1:75:00', '1:2:3:4', '10:61', 'T+', '2days']) {
      expect(parseMissionTime(bad), bad).toBeNull();
    }
  });

  it('formats as the parser reads, so an edit round-trips', () => {
    for (const s of [0, 59, 5400, 86399, 86400, 3 * 86400 + 3725]) {
      expect(parseMissionTime(formatMissionTime(s))).toBe(s);
    }
    expect(formatMissionTime(2900)).toBe('T+00:48:20');
    expect(formatMissionTime(90000)).toBe('T+1d 01:00:00');
  });
});

describe('editing nodes', () => {
  it('adds a node with a fresh id, in time order', () => {
    const craft = leo();
    const result = applyNodeDraft(craft, draft({ time: '600', label: 'Trim' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.craft.maneuvers.map((m) => m.id);
    expect(ids).toEqual([nextNodeId(craft), 'raise-1']);
    expect(result.craft.maneuvers[0]).toMatchObject({ timeSeconds: 600, a: 10, label: 'Trim' });
    expect(result.note).toBeNull();
  });

  it('edits a node in place and keeps its id', () => {
    const craft = leo();
    const original = craft.maneuvers[0]!;
    const result = applyNodeDraft(craft, { ...draftFromNode(original), a: '80' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.craft.maneuvers).toHaveLength(1);
    expect(result.craft.maneuvers[0]).toMatchObject({ id: original.id, a: 80, timeSeconds: 2900 });
  });

  it('round-trips an unedited node exactly', () => {
    const craft = leo();
    const result = applyNodeDraft(craft, draftFromNode(craft.maneuvers[0]!));
    expect(result.ok && result.craft.maneuvers).toEqual(craft.maneuvers);
  });

  it('extends a two-body plan to cover a late burn, and says so', () => {
    const craft = leo();
    const result = applyNodeDraft(craft, draft({ time: '1d' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.craft.horizonSeconds).toBe(2 * 86400);
    expect(result.note).toMatch(/extended to T\+2d 00:00:00/);
  });

  it('refuses to extend an N-body plan', () => {
    const result = applyNodeDraft(freeReturn(), draft({ time: '30d' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.message).toMatch(/N-body/);
  });

  it('collects every problem with a draft', () => {
    const result = applyNodeDraft(
      leo(),
      draft({ time: 'later', b: 'lots', label: 'x'.repeat(61) }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((i) => i.field).sort()).toEqual(['b', 'label', 'time']);
    }
  });

  it('refuses a zero burn and an implausible one', () => {
    const zero = applyNodeDraft(leo(), draft({ a: '0' }));
    expect(zero.ok).toBe(false);
    const huge = applyNodeDraft(leo(), draft({ a: '25000' }));
    expect(huge.ok).toBe(false);
    if (!huge.ok) expect(huge.issues[0]?.message).toMatch(/25\.0 km\/s/);
  });

  it('treats a blank component as zero, so a pure prograde burn needs one field', () => {
    const result = applyNodeDraft(leo(), draft({ a: '12', b: '', c: ' ' }));
    expect(result.ok && result.craft.maneuvers[0]).toMatchObject({ a: 12, b: 0, c: 0 });
  });

  it('refuses to edit a node that has been deleted meanwhile', () => {
    const craft = leo();
    const stale = draftFromNode(craft.maneuvers[0]!);
    const result = applyNodeDraft(removeNode(craft, 'raise-1'), stale);
    expect(result.ok).toBe(false);
  });

  it('deletes by id, and ignores an unknown id', () => {
    expect(removeNode(leo(), 'raise-1').maneuvers).toEqual([]);
    expect(removeNode(leo(), 'nope').maneuvers).toEqual(leo().maneuvers);
  });

  it('never reuses an id', () => {
    const craft = { ...leo(), maneuvers: [{ ...leo().maneuvers[0]!, id: 'node-2' }] };
    expect(nextNodeId(craft)).toBe('node-3');
  });
});
