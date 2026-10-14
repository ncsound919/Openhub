#!/usr/bin/env node
/**
 * Lock-contention drill against the LIVE openhub database.
 *
 * Holds an exclusive write transaction for longer than the server's 10s
 * busy_timeout, then polls /api/health throughout. This is the shape that
 * crash-looped the server before hardening: a competing writer holding the lock
 * past the timeout, with a background tick firing inside the window.
 *
 * Read-only apart from the lock itself: no rows are written, so a drill can be
 * run against production data. A temporary table is created and dropped in the
 * lock-holding transaction's own connection.
 */
import { createRequire } from 'node:module';
import os from 'node:os';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const DB = process.argv[2] || 'data/openhub.db';
const HOLD_MS = Number(process.argv[3] || 25_000);
const base = 'http://127.0.0.1:3010';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const probe = async () => {
  const t0 = Date.now();
  try {
    const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(8000) });
    return { ok: r.ok, ms: Date.now() - t0, body: await r.json().catch(() => null) };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, body: e.message };
  }
};

console.log(`drill: holding an EXCLUSIVE write lock on ${DB} for ${HOLD_MS / 1000}s`);
console.log(`       thread parked via Atomics.wait (no CPU spin) so the server keeps its core`);
console.log(`       server busy_timeout is 1s; the lock deliberately outlives it by ~30x\n`);

const park = Atomics.wait.bind(Atomics);
const sleeper = new Int32Array(new SharedArrayBuffer(4));

// Refuse to render a verdict on a loaded host. This drill measures LATENCY, and
// latency on a saturated box is dominated by CPU starvation rather than by the
// lock. Measured 2026-10-05 on this host: /api/health swung between 40ms and
// 8000ms with no lock held at all, producing a confident "NOT hardened" verdict
// for a server that was fine. A diagnostic that cannot tell noise from signal
// must decline to answer.
//
// NOTE: os.loadavg() returns [0,0,0] on Windows, so it is useless here -- an
// earlier version of this guard tested it and could never fire. CPU busy is
// therefore sampled from os.cpus() tick deltas, which works on both platforms.
function cpuBusyFraction(sampleMs = 500) {
  const snap = () => os.cpus().map((c) => c.times);
  const idleFor = (t) => t.idle + t.nice;
  const totalFor = (t) => t.user + t.sys + t.idle + t.irq + t.nice;
  const before = snap();
  const t0 = Date.now();
  // Park rather than spin, so the sampler itself adds no load.
  while (Date.now() - t0 < sampleMs) park(sleeper, 0, 0, 50);
  const after = snap();
  let busy = 0, total = 0;
  for (let i = 0; i < before.length; i++) {
    const dTotal = totalFor(after[i]) - totalFor(before[i]);
    const dIdle = idleFor(after[i]) - idleFor(before[i]);
    total += dTotal;
    busy += dTotal - dIdle;
  }
  return total > 0 ? busy / total : 0;
}

const busy = cpuBusyFraction();
if (process.env.DRILL_FORCE !== '1' && busy > 0.6) {
  console.error(`REFUSING TO RUN: CPU busy ${(busy * 100).toFixed(0)}% across ${os.cpus().length} CPUs.`);
  console.error('Latency on a loaded host measures CPU starvation, not lock handling.');
  console.error('Wait for an idle host, or re-run with DRILL_FORCE=1 to accept a noisy result.');
  process.exit(3);
}
console.log(`  host CPU busy ${(busy * 100).toFixed(0)}% (verdict is only meaningful when low)\n`);

const before = await probe();
console.log(`  pre-lock   ${before.ok ? 'UP' : 'DOWN'} in ${before.ms}ms`);

const holder = new Database(DB);
holder.pragma('busy_timeout = 5000');
// Block WITHOUT burning CPU. A `while (Date.now() < until) {}` spin holds the
// lock just as well, but it saturates a core for the whole window -- and this
// host already runs at 79-100% CPU, so the spin starved the server and produced
// a false "NOT hardened" verdict that measured CPU contention, not lock
// handling. Atomics.wait parks the thread: the lock is still held, and the
// server keeps the core it needs to answer /api/health.
const tx = holder.transaction(() => {
  holder.exec('CREATE TABLE IF NOT EXISTS _lock_drill (id INTEGER PRIMARY KEY, at TEXT)');
  holder.prepare('INSERT INTO _lock_drill (at) VALUES (?)').run(new Date().toISOString());
  // Prove exclusivity FROM INSIDE the transaction. An earlier version ran this
  // check after tx() returned, i.e. after the lock was already released, and so
  // it always reported "NOT BLOCKED" and flagged its own drill invalid.
  {
    const probe = new Database(DB);
    probe.pragma('busy_timeout = 750');
    try {
      probe.exec('CREATE TABLE IF NOT EXISTS _lock_probe (id INTEGER PRIMARY KEY)');
      lockWasExclusive = false;
    } catch (e) {
      lockWasExclusive = /busy|locked/i.test(`${e.code} ${e.message}`);
      if (!lockWasExclusive) probe.close();
    }
    probe.close();
  }
  const t0 = Date.now();
  while (Date.now() - t0 < HOLD_MS) park(sleeper, 0, 0, 200);
});
tx();
console.log(lockWasExclusive
  ? '  competing writer was BLOCKED while the lock was held -> drill is valid'
  : '  competing writer was NOT BLOCKED -> drill is invalid, verdict below is meaningless');
if (!lockWasExclusive) process.exitCode = 2;
holder.exec('DROP TABLE IF EXISTS _lock_drill');
holder.close();
console.log('  lock released\n');

// Sample health across the whole window plus a settle period, so a server that
// dies mid-window and a server that never noticed are distinguishable.
const samples = [];
const t0 = Date.now();
while (Date.now() - t0 < HOLD_MS + 12_000) {
  const s = await probe();
  samples.push({ at: Math.round((Date.now() - t0) / 1000), ...s });
  await sleep(2000);
}

const down = samples.filter((s) => !s.ok);
console.log('  health samples (s, status, ms):');
let lastMark = null;
for (const s of samples) {
  const mark = s.ok ? 'UP  ' : 'DOWN';
  if (mark !== lastMark) { console.log(`    ${String(s.at).padStart(3)}s  ${mark} ${s.ms}ms`); lastMark = mark; }
}
const maxMs = Math.max(...samples.map((s) => s.ms));
console.log(`\n  samples=${samples.length}  down=${down.length}  slowest=${maxMs}ms`);
console.log(down.length === 0
  ? '  RESULT: server stayed up through a lock longer than its own timeout -> hardened'
  : `  RESULT: server was unavailable ${down.length} time(s) -> NOT hardened`);
process.exitCode = down.length === 0 ? 0 : 1;
