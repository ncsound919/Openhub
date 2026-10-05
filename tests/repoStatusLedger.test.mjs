#!/usr/bin/env node
/**
 * Regression tests for the repo status ledger. Each test covers a failure mode
 * that actually happened while building this, so a change that reintroduces it
 * fails here instead of corrupting the change history in production.
 *
 * Run: node tests/repoStatusLedger.test.mjs   (from the openhub checkout)
 *
 * Runs against a throwaway copy of the database; the real data/openhub.db is
 * never written.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const SRC_DB = process.argv[2] || path.resolve('data/openhub.db');
const SCRIPT = path.resolve('repo-status-ledger.mjs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-test-'));
const DB = path.join(tmp, 't.db');
fs.copyFileSync(SRC_DB, DB);

const run = (...args) => execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

const ro = (q, ...params) => {
  const db = new Database(DB, { readonly: true });
  try { return db.prepare(q).all(...params); } finally { db.close(); }
};
const rw = (fn) => {
  const db = new Database(DB);
  try { return fn(db); } finally { db.close(); }
};

let pass = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); pass++; }
  catch (e) {
    console.log(`  FAIL ${name}`);
    console.log(`       ${e.message.split('\n')[0]}`);
    process.exitCode = 1;
  }
};

console.log('repo status ledger\n');

test('the script and db.ts agree on the canonical column names', () => {
  const dbts = fs.readFileSync(path.resolve('src/auth/db.ts'), 'utf8');
  assert.match(dbts, /CREATE TABLE IF NOT EXISTS repo_status\b/, 'db.ts declares repo_status');
  assert.match(dbts, /CREATE TABLE IF NOT EXISTS repo_status_events\b/, 'db.ts declares repo_status_events');

  // The failure this prevents: the writer shipped `last_commit_subj` / `at` while
  // the read routes expected `subject` / `observed_at`, and CREATE TABLE IF NOT
  // EXISTS silently made whichever ran first the winner.
  // Comments are stripped first: the file documents the legacy names when
  // explaining why they were renamed, and a naive substring check would flag
  // that explanation as a second declaration.
  const script = fs.readFileSync(SCRIPT, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const schema = script.slice(0, script.indexOf('const repos ='));
  assert.ok(schema.length > 0, 'the CREATE TABLE block was found');
  assert.ok(!schema.includes('last_commit_subj'), 'writer must not declare last_commit_subj');
  assert.ok(!/\bat\s+TEXT\s+NOT NULL/.test(schema), 'writer must not declare a bare `at` column');
  for (const col of ['subject', 'observed_at']) {
    assert.ok(schema.includes(col), `writer declares canonical column ${col}`);
  }
});

test('WATCHED maps every column to a real accessor', () => {
  // A bare string list is the bug that produced 132 phantom events: the column
  // was head_sha but the object field was headSha, so every value read undefined.
  const src = fs.readFileSync(SCRIPT, 'utf8');
  const block = src.match(/const WATCHED = \[([\s\S]*?)\];/);
  assert.ok(block, 'WATCHED is declared');
  const entries = [...block[1].matchAll(/\['([a-z_]+)',\s*\(o\)\s*=>\s*o\.([A-Za-z]+)/g)];
  assert.equal(entries.length, 5, 'all five watched fields use an explicit accessor');
  for (const [, col, field] of entries) {
    assert.ok(src.includes(`${field}:`), `observe() returns ${field} (for column ${col})`);
  }
});

test('the writer waits for a lock instead of failing fast', () => {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  assert.match(src, /busy_timeout/, 'script must set busy_timeout');
  assert.match(src, /journal_mode = WAL/, 'script must match the server journal mode');
});

test('an unchanged tree appends zero events', () => {
  run('--db', DB, '--quiet');
  const before = ro('SELECT COUNT(*) n FROM repo_status_events')[0].n;
  const out = run('--db', DB, '--quiet');
  const after = ro('SELECT COUNT(*) n FROM repo_status_events')[0].n;
  assert.equal(after, before, 'a second run must not append anything');
  assert.match(out, /events_appended=0/, 'the run reports zero events');
});

test('a real change appends one event naming the changed field', () => {
  const target = ro("SELECT repo_id FROM repo_status WHERE health = 'ok' LIMIT 1")[0];
  if (!target) return; // no clean repo available; nothing to perturb
  const before = ro('SELECT COUNT(*) n FROM repo_status_events')[0].n;
  rw((db) => db.prepare('UPDATE repo_status SET dirty_count = 99999 WHERE repo_id = ?').run(target.repo_id));
  run('--db', DB, '--quiet');
  const after = ro('SELECT COUNT(*) n FROM repo_status_events')[0].n;
  assert.ok(after > before, 'a real change must append at least one event');
  const latest = ro(
    'SELECT field FROM repo_status_events WHERE repo_id = ? ORDER BY id DESC LIMIT 1',
    target.repo_id,
  )[0];
  assert.equal(latest.field, 'dirty_count', 'the event names the field that changed');
});

test('every event carries a stored reason', () => {
  const blank = ro("SELECT COUNT(*) n FROM repo_status_events WHERE note IS NULL OR note = ''")[0].n;
  assert.equal(blank, 0, 'an event must explain itself');
});

test('no row claims a health without a reason', () => {
  const bad = ro(`SELECT COUNT(*) n FROM repo_status
    WHERE health IS NULL OR health = '' OR health_reason IS NULL OR health_reason = ''`)[0].n;
  assert.equal(bad, 0);
});

test('every row has an observed_at', () => {
  const bad = ro('SELECT COUNT(*) n FROM repo_status WHERE observed_at IS NULL')[0].n;
  assert.equal(bad, 0);
});

test('integrity check passes', () => {
  assert.equal(rw((db) => db.pragma('integrity_check', { simple: true })), 'ok');
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed${process.exitCode ? ', with failures' : ''}`);
