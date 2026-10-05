import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDb } from '../src/auth/db';

vi.mock('../src/services/repairClient', () => ({ triggerRepairTriage: vi.fn() }));
vi.mock('../src/services/telemetry', () => ({ recordEvent: vi.fn() }));

import { triggerRepairTriage } from '../src/services/repairClient';
import { recordEvent } from '../src/services/telemetry';
import {
  reportIncident,
  listIncidents,
  getDispatchPrefs,
  setDispatchPrefs,
  dispatchState,
} from '../src/services/incidentBus';

describe('incidentBus', () => {
  let tmp: string;
  let previousDbPath: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'incident-bus-'));
    previousDbPath = process.env.OPENHUB_DB_PATH;
    process.env.OPENHUB_DB_PATH = path.join(tmp, 'test.db');
    closeDb();
    delete process.env.OPENHUB_AUTODISPATCH;
    vi.clearAllMocks();
    vi.mocked(triggerRepairTriage).mockResolvedValue({ ok: true });
    vi.mocked(recordEvent).mockReturnValue({ wrote: true });
  });

  afterEach(async () => {
    await vi.waitFor(() => expect(dispatchState().queued).toBe(0));
    closeDb();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    if (previousDbPath === undefined) delete process.env.OPENHUB_DB_PATH;
    else process.env.OPENHUB_DB_PATH = previousDbPath;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  describe('reportIncident', () => {
    it('persists a new incident and queues no dispatch for a disabled severity', async () => {
      const { incident, dispatchQueued } = await reportIncident({
        source: 'copilot',
        kind: 'task-failed',
        severity: 'low',
        detail: 'something went wrong',
      });

      expect(dispatchQueued).toBe(false);
      expect(incident).toMatchObject({
        source: 'copilot',
        kind: 'task-failed',
        severity: 'low',
        detail: 'something went wrong',
        dedupKey: 'copilot:task-failed',
        dispatched: false,
        dispatchResult: null,
      });
      expect(incident.id).toBeTruthy();
      expect(listIncidents()).toHaveLength(1);
      expect(recordEvent).toHaveBeenCalledWith(expect.objectContaining({ system: 'incidents', kind: 'task-failed' }));
    });

    it('truncates oversized detail text', async () => {
      const { incident } = await reportIncident({
        source: 'system',
        kind: 'huge',
        severity: 'low',
        detail: 'x'.repeat(5000),
      });
      expect(incident.detail).toHaveLength(4000);
    });

    it('dedupes incidents with the same explicit key inside the window', async () => {
      const first = await reportIncident({ source: 'axiom', kind: 'loop-failed', severity: 'low', detail: 'a', dedupKey: 'loop:1' });
      const second = await reportIncident({ source: 'axiom', kind: 'loop-failed', severity: 'low', detail: 'b', dedupKey: 'loop:1' });

      expect(second.dispatchQueued).toBe(false);
      expect(second.incident.id).toBe(first.incident.id);
      expect(second.incident.detail).toBe('a');
      expect(listIncidents()).toHaveLength(1);
    });

    it('dedupes on the derived source:kind key when none is given', async () => {
      const first = await reportIncident({ source: 'pipeline', kind: 'run-failed', severity: 'low', detail: 'a' });
      const second = await reportIncident({ source: 'pipeline', kind: 'run-failed', severity: 'low', detail: 'b' });
      expect(second.incident.id).toBe(first.incident.id);
      expect(listIncidents()).toHaveLength(1);
    });

    it('creates a fresh incident when the dedupe window has elapsed', async () => {
      getDb().exec(`
        CREATE TABLE IF NOT EXISTS incidents (
          id TEXT PRIMARY KEY, source TEXT NOT NULL, kind TEXT NOT NULL, severity TEXT NOT NULL,
          detail TEXT NOT NULL DEFAULT '', dedup_key TEXT NOT NULL DEFAULT '',
          dispatched INTEGER DEFAULT 0, dispatch_result TEXT, created_at TEXT NOT NULL
        );
      `);
      getDb().prepare(
        'INSERT INTO incidents (id, source, kind, severity, detail, dedup_key, dispatched, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)',
      ).run('old', 'axiom', 'loop-failed', 'low', 'old detail', 'axiom:loop-failed', new Date(Date.now() - 20 * 60_000).toISOString());

      const { incident, dispatchQueued } = await reportIncident({ source: 'axiom', kind: 'loop-failed', severity: 'low', detail: 'new detail' });
      expect(incident.id).toBeTruthy();
      expect(dispatchQueued).toBe(false);
      expect(listIncidents()).toHaveLength(2);
    });
  });

  describe('dispatch prefs + kill switch', () => {
    it('returns the defaults and persists patches', () => {
      const defaults = getDispatchPrefs();
      expect(defaults).toMatchObject({ low: false, medium: false, high: true, critical: true, killSwitch: false });

      const updated = setDispatchPrefs({ low: true, high: false });
      expect(updated).toMatchObject({ low: true, medium: false, high: false, critical: true });

      expect(getDispatchPrefs()).toMatchObject({ low: true, medium: false, high: false, critical: true });
    });

    it('honors the OPENHUB_AUTODISPATCH=0 kill switch', async () => {
      vi.stubEnv('OPENHUB_AUTODISPATCH', '0');
      expect(getDispatchPrefs().killSwitch).toBe(true);

      const { dispatchQueued } = await reportIncident({
        source: 'supervisor',
        kind: 'loop-timeout',
        severity: 'critical',
        detail: 'timed out',
      });
      expect(dispatchQueued).toBe(false);
      expect(dispatchState()).toEqual({ inFlight: false, queued: 0 });
      expect(triggerRepairTriage).not.toHaveBeenCalled();
    });
  });

  describe('auto-dispatch queue', () => {
    it('starts idle', () => {
      expect(dispatchState()).toEqual({ inFlight: false, queued: 0 });
    });

    it('dispatches a high severity incident and marks it dispatched', async () => {
      const { incident, dispatchQueued } = await reportIncident({
        source: 'mcp',
        kind: 'server-offline',
        severity: 'high',
        detail: 'mcp down',
      });
      expect(dispatchQueued).toBe(true);

      await vi.waitFor(() => expect(listIncidents()[0]?.dispatched).toBe(true));
      expect(listIncidents()[0]?.dispatchResult).toBe('dispatched');
      expect(triggerRepairTriage).toHaveBeenCalledWith(expect.objectContaining({ signal: 'openhub:incident:server-offline', kind: 'job' }));
      expect(dispatchState()).toEqual({ inFlight: false, queued: 0 });
      expect(incident.dispatched).toBe(false);
    });

    it('leaves a failed dispatch retryable and records the error', async () => {
      vi.mocked(triggerRepairTriage).mockResolvedValue({ ok: false, error: 'draymond offline' });
      await reportIncident({ source: 'ecosystem', kind: 'offline', severity: 'critical', detail: 'ecosystem down' });

      await vi.waitFor(() => expect(listIncidents()[0]?.dispatchResult).toBe('draymond offline'));
      expect(listIncidents()[0]?.dispatched).toBe(false);
    });
  });
});
