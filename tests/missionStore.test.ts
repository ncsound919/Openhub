import { describe, it, expect, beforeEach } from 'vitest';
import { useMissionStore } from '../src/lib/missionStore.js';

describe('missionStore', () => {
  beforeEach(() => useMissionStore.getState().clear());

  it('upserts a mission without duplicates', () => {
    const s = useMissionStore.getState();
    s.upsertMission({ id: 'm1', goal: 'g', sessionId: null, status: 'draft', createdAt: '2026-10-07' });
    s.upsertMission({ id: 'm1', goal: 'g2', sessionId: 's', status: 'planned', createdAt: '2026-10-07' });
    const missions = useMissionStore.getState().missions;
    expect(missions).toHaveLength(1);
    expect(missions[0].goal).toBe('g2');
  });

  it('transitions status', () => {
    const s = useMissionStore.getState();
    s.upsertMission({ id: 'm1', goal: 'g', sessionId: null, status: 'draft', createdAt: '2026-10-07' });
    for (const st of ['planned', 'running', 'review', 'done'] as const) {
      useMissionStore.getState().setStatus('m1', st);
      expect(useMissionStore.getState().missions[0].status).toBe(st);
    }
  });

  it('appends events in order', () => {
    const s = useMissionStore.getState();
    s.addEvent('m1', { at: 1, kind: 'plan', text: 'a' });
    s.addEvent('m1', { at: 2, kind: 'tool', text: 'b' });
    expect(useMissionStore.getState().events.m1.map((e) => e.text)).toEqual(['a', 'b']);
  });

  it('clears', () => {
    const s = useMissionStore.getState();
    s.upsertMission({ id: 'm1', goal: 'g', sessionId: null, status: 'draft', createdAt: '2026-10-07' });
    useMissionStore.getState().clear();
    expect(useMissionStore.getState().missions).toHaveLength(0);
    expect(useMissionStore.getState().events).toEqual({});
  });
});
