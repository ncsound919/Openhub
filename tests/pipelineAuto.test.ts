import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getDb } from '../src/auth/db.js';
import { setAutoConfig, runAutoTick, hasDrift, getWatchState, driftSignature } from '../src/services/pipelineAuto.js';

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

  it('reports the save watcher state and holds the on-save trigger until a change is seen', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-watch-'));
    try {
      const db = getDb();
      db.exec('CREATE TABLE IF NOT EXISTS active_project_context (user_id TEXT, repo_id TEXT, path TEXT NOT NULL, selected_at TEXT NOT NULL)');
      db.prepare('DELETE FROM active_project_context').run();
      db.prepare('INSERT INTO active_project_context (user_id, repo_id, path, selected_at) VALUES (?, ?, ?, ?)')
        .run('u1', 'r1', dir, new Date().toISOString());
      setAutoConfig({ enabled: true, trigger: 'change' });
      // The watcher state is always reported honestly (watching or unsupported).
      const ws = getWatchState();
      expect(typeof ws.watching).toBe('boolean');
      expect(typeof ws.unsupported).toBe('boolean');
      // With no fresh change since the last run, the on-save trigger must not fire
      // (busy is an equally valid fail-closed skip if another run is in flight).
      const r = await runAutoTick();
      expect(r.started).toBe(false);
      expect(['no-change', 'busy']).toContain(r.skipped);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      try { getDb().prepare('DELETE FROM active_project_context').run(); } catch { /* ignore */ }
    }
  });

  it('does not re-trigger on the tree its own previous run left behind', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-self-'));
    const db = getDb();
    try {
      await execFileAsync('git', ['init', '-q'], { cwd: dir });
      await execFileAsync('git', ['config', 'user.email', 't@t.local'], { cwd: dir });
      await execFileAsync('git', ['config', 'user.name', 'tester'], { cwd: dir });
      fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
      await execFileAsync('git', ['add', '.'], { cwd: dir });
      await execFileAsync('git', ['commit', '-qm', 'init'], { cwd: dir });

      db.exec('CREATE TABLE IF NOT EXISTS active_project_context (user_id TEXT, repo_id TEXT, path TEXT NOT NULL, selected_at TEXT NOT NULL)');
      db.prepare('DELETE FROM active_project_context').run();
      db.prepare('INSERT INTO active_project_context (user_id, repo_id, path, selected_at) VALUES (?, ?, ?, ?)')
        .run('u1', 'r1', dir, new Date().toISOString());
      try { db.prepare("DELETE FROM pipeline_jobs WHERE status IN ('running','awaiting-approval')").run(); } catch { /* table absent */ }

      // Simulate: an auto run (job-1) finished and left uncommitted edits.
      setAutoConfig({ enabled: true, trigger: 'drift' });
      db.prepare('INSERT OR REPLACE INTO node_settings (key, value, updated_at) VALUES (?, ?, ?)')
        .run('pipeline.auto.lastJobId', 'job-1', new Date().toISOString());
      db.prepare('INSERT OR REPLACE INTO node_settings (key, value, updated_at) VALUES (?, ?, ?)')
        .run('pipeline.auto.lastRunAt', new Date(Date.now() - 60 * 60_000).toISOString(), new Date().toISOString());
      fs.writeFileSync(path.join(dir, 'a.txt'), 'agent edit');
      expect(await hasDrift(dir)).toBe(true);

      // Cooldown has long passed, the tree is dirty — but it is the tree the
      // run itself produced, so nothing starts.
      const r1 = await runAutoTick();
      expect(r1.started).toBe(false);
      expect(r1.skipped).toBe('no-drift');
      const r2 = await runAutoTick();
      expect(r2.skipped).toBe('no-drift');

      // A further edit (the operator's) changes the signature => real drift.
      const before = await driftSignature(dir);
      fs.writeFileSync(path.join(dir, 'a.txt'), 'operator edit, longer line\nand another');
      expect(await driftSignature(dir)).not.toBe(before);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      try { db.prepare('DELETE FROM active_project_context').run(); } catch { /* ignore */ }
      try { db.prepare("DELETE FROM node_settings WHERE key LIKE 'pipeline.auto.%'").run(); } catch { /* ignore */ }
    }
  });

  it('driftSignature is null outside a git worktree', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-nogit-'));
    try {
      expect(await driftSignature(dir)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
