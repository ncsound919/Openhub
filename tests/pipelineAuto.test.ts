import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getDb } from '../src/auth/db.js';
import { setAutoConfig, runAutoTick, hasDrift } from '../src/services/pipelineAuto.js';

const execFileAsync = promisify(execFile);

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
  it('does nothing when disabled', async () => {
    setAutoConfig({ enabled: false });
    const r = await runAutoTick();
    expect(r.started).toBe(false);
    expect(r.skipped).toBe('disabled');
  });

  it('stops entirely on the fleet kill switch', async () => {
    setAutoConfig({ enabled: true });
    process.env.OPENHUB_AUTODISPATCH = '0';
    const r = await runAutoTick();
    expect(r.started).toBe(false);
    expect(r.skipped).toBe('kill-switch');
  });

  it('never starts without a loaded project (and never while busy)', async () => {
    setAutoConfig({ enabled: true });
    try { getDb().prepare('DELETE FROM active_project_context').run(); } catch { /* table absent */ }
    const r = await runAutoTick();
    expect(r.started).toBe(false);
    expect(['no-project', 'busy']).toContain(r.skipped);
  });

  it('detects drift from uncommitted changes (the on-drift trigger)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-drift-'));
    try {
      await execFileAsync('git', ['init', '-q'], { cwd: dir });
      await execFileAsync('git', ['config', 'user.email', 't@t.local'], { cwd: dir });
      await execFileAsync('git', ['config', 'user.name', 'tester'], { cwd: dir });
      fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
      await execFileAsync('git', ['add', '.'], { cwd: dir });
      await execFileAsync('git', ['commit', '-qm', 'init'], { cwd: dir });
      expect(await hasDrift(dir)).toBe(false);
      fs.writeFileSync(path.join(dir, 'b.txt'), 'b');
      expect(await hasDrift(dir)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
