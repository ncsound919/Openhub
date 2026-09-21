import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDb } from '../src/auth/db.js';
import { setAutoConfig, runAutoTick } from '../src/services/pipelineAuto.js';

const prevKill = process.env.OPENHUB_AUTODISPATCH;

beforeEach(() => {
  delete process.env.OPENHUB_AUTODISPATCH;
  // Clear the due-check so a prior run does not mask the case under test.
  try { getDb().prepare("DELETE FROM node_settings WHERE key = 'pipeline.auto.lastRunAt'").run(); } catch { /* table not created yet */ }
});

afterEach(() => {
  if (prevKill === undefined) delete process.env.OPENHUB_AUTODISPATCH;
  else process.env.OPENHUB_AUTODISPATCH = prevKill;
});

// Unattended Autopilot must be fail-closed: it only runs when explicitly
// enabled, never under the kill switch, and never without a project.
describe('pipeline auto (unattended Autopilot)', () => {
  it('does nothing when disabled', () => {
    setAutoConfig({ enabled: false });
    const r = runAutoTick();
    expect(r.started).toBe(false);
    expect(r.skipped).toBe('disabled');
  });

  it('stops entirely on the fleet kill switch', () => {
    setAutoConfig({ enabled: true });
    process.env.OPENHUB_AUTODISPATCH = '0';
    const r = runAutoTick();
    expect(r.started).toBe(false);
    expect(r.skipped).toBe('kill-switch');
  });

  it('never starts without a loaded project (and never while busy)', () => {
    setAutoConfig({ enabled: true });
    try { getDb().prepare('DELETE FROM active_project_context').run(); } catch { /* table absent */ }
    const r = runAutoTick();
    expect(r.started).toBe(false);
    expect(['no-project', 'busy']).toContain(r.skipped);
  });
});
