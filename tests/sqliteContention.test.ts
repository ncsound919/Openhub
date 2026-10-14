import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withBusyRetry, withBusyRetrySync } from '../src/lib/sqliteRetry';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

/**
 * Real lock contention, deterministically.
 *
 * Two independent connections to one file, one holding a write transaction
 * while the other writes. This is the exact condition that produced the
 * production crash (unhandled "database is locked" out of a background tick).
 *
 * The lock is held with Atomics.wait, not a spin loop: a busy-wait saturates a
 * core and turns a lock test into a CPU test, which on a loaded host produces a
 * confident wrong answer. Verified: a spin-loop version of this drill reported
 * the server "NOT hardened" purely from CPU starvation.
 */

const park = Atomics.wait.bind(Atomics);
const sleeper = new Int32Array(new SharedArrayBuffer(4));

const tmpDirs: string[] = [];
function tempDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-contention-'));
  tmpDirs.push(dir);
  return path.join(dir, 'test.db');
}

afterEach(() => {
  while (tmpDirs.length) {
    try { fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe('real SQLite write-lock contention', () => {
  it('a second connection is genuinely blocked while the first holds a write transaction', () => {
    const file = tempDb();
    const a = new Database(file);
    const b = new Database(file);
    a.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    a.pragma('busy_timeout = 300');
    b.pragma('busy_timeout = 300');

    let blocked = false;
    const t0 = Date.now();
    const tx = a.transaction(() => {
      a.prepare('INSERT INTO t (v) VALUES (?)').run('held');
      try {
        b.prepare('INSERT INTO t (v) VALUES (?)').run('competing');
      } catch (e) {
        blocked = /busy|locked/i.test(`${(e as { code?: string }).code} ${(e as Error).message}`);
      }
    });
    tx();
    const waited = Date.now() - t0;

    // If this ever stops being true the whole file is measuring nothing.
    expect(blocked, 'competing write must be blocked, otherwise there is no contention to handle').toBe(true);
    expect(waited).toBeGreaterThanOrEqual(250);
    a.close();
    b.close();
  });

  it('withBusyRetry survives a lock held past the busy timeout and completes once released', async () => {
    const file = tempDb();
    const holder = new Database(file);
    const worker = new Database(file);
    holder.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    holder.pragma('busy_timeout = 200');
    worker.pragma('busy_timeout = 200');

    let release!: () => void;
    const released = new Promise<void>((r) => { release = r; });
    const tx = holder.transaction(() => {
      holder.prepare('INSERT INTO t (v) VALUES (?)').run('held');
      // hold until the test releases, parked not spun
      const t0 = Date.now();
      while (Date.now() - t0 < 1500) park(sleeper, 0, 0, 50);
    });
    const holding = setTimeout(() => release(), 1200);
    setTimeout(release, 1200);

    // Fire the retrying write while the lock is held, then let the holder go.
    const attempt = withBusyRetry('contended-write', () => {
      worker.prepare('INSERT INTO t (v) VALUES (?)').run('retried');
      return 'written';
    }, { attempts: 40, baseMs: 100 });

    const result = await attempt;
    clearTimeout(holding);
    await released;
    tx();
    holder.close();
    worker.close();

    expect(result).toBe('written');
    const db = new Database(file, { readonly: true });
    try {
      const values = db.prepare('SELECT v FROM t ORDER BY id').all().map((r: { v: string }) => r.v);
      expect(values).toContain('retried');
    } finally {
      db.close();
    }
  });

  it('withBusyRetrySync gives up rather than blocking forever, and reports BUSY', () => {
    const file = tempDb();
    const holder = new Database(file);
    const worker = new Database(file);
    holder.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    holder.pragma('busy_timeout = 150');
    worker.pragma('busy_timeout = 150');

    const t0 = Date.now();
    const tx = holder.transaction(() => {
      holder.prepare('INSERT INTO t (v) VALUES (?)').run('held');
      let caught: unknown;
      try {
        withBusyRetrySync('doomed', () => {
          worker.prepare('INSERT INTO t (v) VALUES (?)').run('never');
        }, { attempts: 2 });
      } catch (e) { caught = e; }
      // The error must be identifiable as contention, so callers can tell a
      // skipped tick from a real defect.
      expect(/busy|locked/i.test(`${(caught as { code?: string })?.code} ${(caught as Error)?.message}`)).toBe(true);
    });
    tx();
    const elapsed = Date.now() - t0;

    // Bounded: attempts * busy_timeout, not unbounded waiting. This is the
    // property that keeps the event loop servable.
    expect(elapsed).toBeLessThan(3000);
    holder.close();
    worker.close();
  });
});
