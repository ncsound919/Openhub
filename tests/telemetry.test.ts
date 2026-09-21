import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { recordEvent, listEvents, summarizeEvents } from '../src/services/telemetry';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openhub-telemetry-'));
  vi.stubEnv('OPENHUB_TELEMETRY_DIR', dir);
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('telemetry store', () => {
  it('appends and reads back events newest-first', () => {
    recordEvent({ system: 'axiom', kind: 'loop-start', at: '2026-01-01T00:00:00.000Z' });
    recordEvent({ system: 'gamemaker', kind: 'godot-gate', outcome: 'rejected', at: '2026-01-02T00:00:00.000Z' });
    const events = listEvents();
    expect(events).toHaveLength(2);
    expect(events[0].system).toBe('gamemaker');
    expect(events[0].outcome).toBe('rejected');
    expect(events[0].id).toBeTruthy();
  });

  it('rejects events without system/kind instead of writing junk', () => {
    expect(recordEvent({ system: '', kind: 'x' } as never).wrote).toBe(false);
    expect(recordEvent({ system: 'x', kind: '' } as never).wrote).toBe(false);
    expect(listEvents()).toHaveLength(0);
  });

  it('filters by system, kind, severity and correlation id', () => {
    recordEvent({ system: 'axiom', kind: 'loop-start', correlationId: 'cid-1' });
    recordEvent({ system: 'axiom', kind: 'loop-complete', severity: 'high', correlationId: 'cid-1' });
    recordEvent({ system: 'gamemaker', kind: 'godot-gate', severity: 'low' });
    expect(listEvents({ system: 'axiom' })).toHaveLength(2);
    expect(listEvents({ kind: 'godot-gate' })).toHaveLength(1);
    expect(listEvents({ severity: 'high' })).toHaveLength(1);
    expect(listEvents({ correlationId: 'cid-1' })).toHaveLength(2);
  });

  it('summarizes counts and computes a pass rate', () => {
    recordEvent({ system: 'supervisor', kind: 'run-complete', outcome: 'accepted' });
    recordEvent({ system: 'supervisor', kind: 'run-complete', outcome: 'accepted' });
    recordEvent({ system: 'supervisor', kind: 'run-complete', outcome: 'rejected' });
    recordEvent({ system: 'axiom', kind: 'loop-start' });
    const s = summarizeEvents();
    expect(s.total).toBe(4);
    expect(s.bySystem.supervisor).toBe(3);
    expect(s.byOutcome.accepted).toBe(2);
    expect(s.passRate).toBeCloseTo(2 / 3, 5);
  });

  it('skips corrupt lines and keeps the rest of the stream', () => {
    recordEvent({ system: 'axiom', kind: 'loop-start' });
    fs.appendFileSync(path.join(dir, 'events.jsonl'), '{not json}\n');
    recordEvent({ system: 'axiom', kind: 'loop-complete' });
    const events = listEvents();
    expect(events).toHaveLength(2);
  });

  it('respects the since window', () => {
    recordEvent({ system: 'axiom', kind: 'old', at: new Date(Date.now() - 10 * 86400000).toISOString() });
    recordEvent({ system: 'axiom', kind: 'new' });
    expect(listEvents({ sinceMs: 86400000 })).toHaveLength(1);
    expect(listEvents({ sinceMs: 86400000 })[0].kind).toBe('new');
  });
});
