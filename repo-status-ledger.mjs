#!/usr/bin/env node
/**
 * repo-status-ledger.mjs — the activity/status ledger.
 *
 * WHAT THIS IS
 * ------------
 * A `repo_status` table recording, per repository, the last observed git state:
 * branch, HEAD sha, dirty count, last commit time, whether a remote exists, and
 * a `health` verdict. One row per repo, rewritten on every run, PLUS an
 * append-only `repo_status_events` history so change is visible rather than
 * inferred from a single current value.
 *
 * WHY WRITE SQL RATHER THAN USE AN API
 * ------------------------------------
 * There is no status API in OpenHub. `/api/repos` returns only the registry rows
 * (name, path, owner) and carries no git state. Rather than invent an endpoint
 * that does not exist and call it an integration, this writes the two tables
 * directly and says so. The registry itself was populated through the real
 * import API; only the ledger bypasses it, because only the ledger is new.
 *
 * DESIGN NOTES
 * ------------
 * - `health` is derived, never asserted. A verdict with no evidence behind it is
 *   the defect class this whole corpus is about, so the rule is written down and
 *   the inputs are stored alongside the verdict.
 * - The writer is idempotent: rerunning it on an unchanged tree writes the same
 *   values and records NO event. An event is only appended when something
 *   actually changed, otherwise the ledger fills with noise that hides the real
 *   signal.
 * - It is safe to run against a live server: it opens the db read-only for the
 *   git facts (none) and writes in a transaction. The server should be stopped for
 *   the write, which the caller does, because SQLite + a long-lived writer is
 *   exactly how the fleet lost data once already.
 *
 * Usage: node repo-status-ledger.mjs --db <path> [--repos <json>] [--quiet]
 */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const argv = process.argv.slice(2);
const arg = (k, d = null) => {
  const i = argv.indexOf(`--${k}`);
  return i === -1 ? d : (argv[i + 1]?.startsWith('--') ? true : argv[i + 1]);
};
const DB = arg('db');
const QUIET = argv.includes('--quiet');
if (!DB) { console.error('usage: node repo-status-ledger.mjs --db <path> [--repos <json>]'); process.exit(2); }

const Database = require('better-sqlite3');
const db = new Database(DB);
// This writer runs on a cron while the server holds the same file open. Both
// ends now set WAL and a busy timeout, so neither dies on the other's lock:
//   - server: src/auth/db.ts (WAL + busy_timeout 10000) retries transient
//     SQLITE_BUSY via withBusyRetry/withBusyRetrySync (src/lib/sqliteRetry.ts),
//     because a serving loop must not drop ticks;
//   - here:   WAL + busy_timeout 30000 below, and NO retry loop on top. That
//     asymmetry is deliberate: this process fires on a 15-minute cron, so a
//     failure is loud (nonzero exit, pm2 err log) and self-heals next cycle,
//     while a retry loop here would only turn a >30s stuck lock into a slower
//     failure. The process that can least afford to fail waits longest; the
//     process that can afford to fail, fails loud instead of retrying forever.
//
 // Measured 2026-10-05 in openhub-pm2.err.log, before both sides were hardened:
//   Unhandled promise rejection: SqliteError: database is locked
//     at migrateRepoStatusTables -> initializeDatabase -> startServer
// and again at dreamTick -> startDreamLoop. A read-mostly sampler taking down the
// app it samples is the failure mode this file exists to avoid.
//
// The comment this replaces claimed "the server sets WAL but not busy_timeout".
// That was true when written and is now false -- db.ts:27 sets busy_timeout and
// explains why. A stale comment describing a bug that no longer exists sends the
// next reader hunting for a fix that is already in place.
//
// journal_mode is set because WAL is persistent on the file, not a per-connection
// setting; setting it is harmless and makes the sampler's intent explicit.
//
// The sampler's timeout is deliberately LONGER than the server's 10s. It runs on
// a 15-minute cron and a missed cycle is lost data, whereas the server retries and
// recovers -- so the process that can least afford to fail waits longest.
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 30000');
db.pragma('foreign_keys = ON');

// The authoritative schema for these two tables lives in src/auth/db.ts, not
// here. This block only exists so the script can run against a database the
// server has never opened. It previously declared its own column names
// (`last_commit_subj`, `at`) while the server's routes read `subject` and
// `observed_at`; because CREATE TABLE IF NOT EXISTS is a no-op once a table
// exists, whichever ran first silently won and every read route failed with
// "no such column". The names below now match db.ts exactly.
db.exec(`
CREATE TABLE IF NOT EXISTS repo_status (
  repo_id           TEXT PRIMARY KEY,
  branch            TEXT,
  head_sha          TEXT,
  dirty_count       INTEGER,
  has_remote        INTEGER NOT NULL DEFAULT 0,
  remote_url        TEXT,
  last_commit_at    TEXT,
  subject           TEXT,
  health            TEXT NOT NULL DEFAULT 'unobserved',
  health_reason     TEXT NOT NULL DEFAULT 'never observed',
  observed_at       TEXT NOT NULL,
  FOREIGN KEY (repo_id) REFERENCES repositories(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS repo_status_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id      TEXT NOT NULL,
  observed_at  TEXT NOT NULL,
  field        TEXT NOT NULL,
  old_value    TEXT,
  new_value    TEXT,
  note         TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (repo_id) REFERENCES repositories(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_repo_status_events_repo ON repo_status_events(repo_id, id DESC);
`);

const git = (dir, args) => {
  try { return execFileSync('git', args, { cwd: dir, encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; }
};

function observe(dir) {
  const remotes = (git(dir, ['remote']) || '').split(/\r?\n/).filter(Boolean);
  const hasRemote = remotes.includes('origin') ? 1 : 0;
  let dirty = null;
  try {
    dirty = execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n').filter((l) => l.trim()).length;
  } catch { /* not a repo or unreadable */ }

  const branch = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const headSha = git(dir, ['rev-parse', 'HEAD']);
  const lastCommitAt = git(dir, ['log', '-1', '--format=%cI']);
  const subject = git(dir, ['log', '-1', '--format=%s']);
  const remoteUrl = hasRemote ? git(dir, ['remote', 'get-url', 'origin']) : null;

  // Derived health. Every branch records WHY, because a bare verdict is the
  // thing this corpus keeps finding fabricated.
  let health = 'ok';
  let reason = 'clean tree';
  if (branch === null) {
    health = 'unreadable';
    reason = 'not a git repository, or git failed';
  } else if (dirty !== null && dirty > 50) {
    health = 'at-risk';
    reason = `${dirty} uncommitted files`;
  } else if (dirty !== null && dirty > 0) {
    health = 'dirty';
    reason = `${dirty} uncommitted file(s)`;
  }
  if (hasRemote === 0 && health === 'ok') {
    health = 'unbacked-up';
    reason = 'no origin remote: commits exist on this disk only';
  }
  return { branch, headSha, dirty, lastCommitAt, subject, hasRemote, remoteUrl, health, reason };
}

const repos = db.prepare('SELECT id, full_path, name FROM repositories').all();

// Column names must match src/auth/db.ts. A database that predates the canonical
// schema also carries NOT NULL `full_path` / `name` from the script's original
// table, and SQLite cannot relax a NOT NULL without rebuilding the table, so
// those two are still written when present. Fresh databases get the canonical
// shape and this branch is skipped.
const statusCols = new Set(
  db.prepare('PRAGMA table_info(repo_status)').all().map((c) => c.name),
);
const legacy = statusCols.has('full_path') && statusCols.has('name');
const insert = db.prepare(`
  INSERT INTO repo_status (${legacy ? 'repo_id, full_path, name, ' : 'repo_id,'}
                           branch, head_sha, dirty_count, last_commit_at,
                           subject, has_remote, remote_url, health, health_reason, observed_at)
  VALUES (${legacy ? '@repo_id, @full_path, @name, ' : '@repo_id,'}
          @branch, @head_sha, @dirty_count, @last_commit_at,
          @subject, @has_remote, @remote_url, @health, @health_reason, @observed_at)
  ON CONFLICT(repo_id) DO UPDATE SET
    ${legacy ? 'full_path=excluded.full_path, name=excluded.name,' : ''}
    branch=excluded.branch, head_sha=excluded.head_sha, dirty_count=excluded.dirty_count,
    last_commit_at=excluded.last_commit_at, subject=excluded.subject,
    has_remote=excluded.has_remote, remote_url=excluded.remote_url,
    health=excluded.health, health_reason=excluded.health_reason, observed_at=excluded.observed_at
`);
const prior = db.prepare('SELECT * FROM repo_status WHERE repo_id = ?');
// Same legacy-shape problem as repo_status: older databases carry a NOT NULL
// `at`, which cannot be relaxed in place. Write it alongside observed_at when it
// exists so one writer serves both shapes.
const eventsHaveAt = new Set(
  db.prepare('PRAGMA table_info(repo_status_events)').all().map((c) => c.name),
).has('at');
const event = db.prepare(
  `INSERT INTO repo_status_events (repo_id${eventsHaveAt ? ', at,' : ','} observed_at, field, old_value, new_value, note)
   VALUES (?${eventsHaveAt ? ',?,' : ','}?,?,?,?,?)`,
);
const writeEvent = (repoId, at, field, oldV, newV, note) => (
  eventsHaveAt
    ? event.run(repoId, at, at, field, oldV, newV, note)
    : event.run(repoId, at, field, oldV, newV, note)
);

// Each entry maps the COLUMN name to the field on the `observe()` result. These
// were mismatched on the first run -- the column list said `head_sha` /
// `dirty_count` / `has_remote` while observe() returns `headSha` / `dirty` /
// `hasRemote` -- so `o[f]` was always undefined, every run looked like a total
// change, and the ledger appended 132 events for 45 repos that had not moved.
// That is the exact "a check that reports a change that did not happen" shape, so
// the mapping is explicit rather than relying on the two sides sharing names.
const WATCHED = [
  ['head_sha', (o) => o.headSha],
  ['branch', (o) => o.branch],
  ['dirty_count', (o) => o.dirty],
  ['has_remote', (o) => o.hasRemote],
  ['health', (o) => o.health],
];
const tally = { ok: 0, dirty: 0, 'at-risk': 0, unreadable: 0, 'unbacked-up': 0 };
let events = 0;

// Phase 1 -- observe. No transaction, no writes: every git subprocess runs here,
// so nothing holds a database lock while a child process is slow. An earlier
// version wrapped the whole loop in db.transaction(), which held a RESERVED
// lock for the full ~60s sweep; any server write in that window -- including
// the boot migration -- died with "database is locked" after the 10s
// busy_timeout, and the unhandled rejection killed the server. A sampler must
// never take down the thing it samples, so the lock window below is one fast
// pass of prepared statements instead of the whole observation loop.
const now = new Date().toISOString();
const seen = [];
for (const r of repos) {
  let o;
  if (!fs.existsSync(r.full_path)) {
    // Still recorded, and still diffed. A repo whose folder was deleted or a
    // drive was unmounted is the single most important transition this ledger
    // can see, so skipping the diff here would drop exactly the event that
    // matters. `path does not exist on disk` distinguishes this from the
    // `unreadable / not a git repository` case below.
    o = { branch: null, headSha: null, dirty: null, lastCommitAt: null, subject: null,
      hasRemote: 0, remoteUrl: null, health: 'unreadable', reason: 'path does not exist on disk', missing: true };
  } else {
    o = observe(r.full_path);
  }
  tally[o.health] = (tally[o.health] || 0) + 1;
  seen.push({ r, o });
  if (!QUIET) {
    console.log(o.missing
      ? `  MISSING  ${r.name}  ${r.full_path}`
      : `  ${o.health.padEnd(11)} ${String(r.name).slice(0, 34).padEnd(34)} ${(o.branch || '-').padEnd(9)} dirty=${o.dirty ?? '-'} ${o.reason}`);
  }
}

// Phase 2 -- write. One short transaction of prepared statements only; no
// subprocesses, no filesystem reads, nothing that can stall while holding the
// lock. prior.get runs here too: the "before" snapshot must be taken at write
// time, not observation time, or a concurrent writer could slip a change
// between the read and the write and we would silently overwrite it.
const write = db.transaction(() => {
  for (const { r, o } of seen) {
    const before = prior.get(r.id);
    if (before) {
      for (const [col, pick] of WATCHED) {
        const a = before[col] ?? null;
        const b = pick(o) ?? null;
        if (String(a) !== String(b)) {
          writeEvent(r.id, now, col, a === null ? null : String(a), b === null ? null : String(b), o.reason);
          events++;
        }
      }
    }
    insert.run({ repo_id: r.id, ...(legacy ? { full_path: r.full_path, name: r.name } : {}),
      branch: o.branch, head_sha: o.headSha,
      dirty_count: o.dirty, last_commit_at: o.lastCommitAt, subject: o.subject,
      has_remote: o.hasRemote, remote_url: o.remoteUrl, health: o.health, health_reason: o.reason, observed_at: now });
  }
});
write();

console.log(`\nrepos=${repos.length}  events_appended=${events}`);
console.log(`health: ok=${tally.ok} dirty=${tally.dirty} at-risk=${tally['at-risk']} unbacked-up=${tally['unbacked-up']} unreadable=${tally.unreadable}`);
console.log(`integrity: ${db.pragma('integrity_check')[0].integrity_check ?? db.pragma('integrity_check', { simple: true })}`);
db.close();