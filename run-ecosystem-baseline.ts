/**
 * Ecosystem baseline audit runner — one repo at a time, resumable.
 *
 * Runs OpenHub's own audit in-process (no server, no auth, no MCP), iterating
 * the proprietary manifest. Each repo's full report is written to
 * baseline/<date>/<id>.json and a resumable state file tracks progress.
 *
 * Fixture handling: before auditing a repo that has no `.gitleaks.toml`, it
 * copies the canonical fixture allowlist in (baseline/gitleaks-allowlist.toml)
 * and records the addition in state (reversible). This stops the secret scorer
 * from flagging deliberate test fixtures (the sieve false-positive).
 *
 * Usage (from INFRASTRUCTURE/openhub):
 *   npx tsx run-ecosystem-baseline.ts
 *   BASELINE_PRESET=deep npx tsx run-ecosystem-baseline.ts
 *   BASELINE_ONLY=sieve,keywire npx tsx run-ecosystem-baseline.ts   # subset
 */
import fs from 'node:fs';
import path from 'node:path';
import { executeAuditSuite } from './src/services/auditSuite.js';

const ROOT = 'C:/Users/User/Downloads/BUSINESS';
const MANIFEST = path.join(ROOT, 'plans/2026-10-15-ecosystem-audit-manifest.json');
const DATE = process.env.BASELINE_DATE || '2026-10-15';
const OUT = path.join(ROOT, 'baseline', DATE);
const STATE = path.join(OUT, 'state.json');
const ALLOWLIST = path.join(ROOT, 'baseline', 'gitleaks-allowlist.toml');
const preset = process.env.BASELINE_PRESET || 'quick';
const only = process.env.BASELINE_ONLY ? process.env.BASELINE_ONLY.split(',') : null;

fs.mkdirSync(OUT, { recursive: true });
const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
const state: Record<string, any> = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {};
const allowlist = fs.existsSync(ALLOWLIST) ? fs.readFileSync(ALLOWLIST, 'utf8') : null;

function ensureFixtureAllowlist(dir: string, id: string): boolean {
  if (!allowlist) return false;
  const dest = path.join(dir, '.gitleaks.toml');
  if (fs.existsSync(dest)) return false; // repo has its own config — do not clobber
  fs.writeFileSync(dest, allowlist, 'utf8');
  state[`__added__${id}`] = dest;
  return true;
}

const targets = (manifest.targets as any[]).filter((t) => t.path).filter((t) => !only || only.includes(t.id));
let done = 0, errs = 0;
for (const t of targets) {
  if (state[t.id]?.ok) { console.log(`skip  ${t.id} (done: ${state[t.id].grade} ${state[t.id].score})`); continue; }
  const dir = path.join(ROOT, t.path);
  if (!fs.existsSync(dir)) { state[t.id] = { id: t.id, ok: false, error: 'missing dir' }; fs.writeFileSync(STATE, JSON.stringify(state, null, 2)); continue; }

  const added = ensureFixtureAllowlist(dir, t.id);
  process.stdout.write(`audit ${t.id} (${preset}${added ? ', +gitleaks allowlist' : ''}) ... `);
  const t0 = Date.now();
  try {
    const report: any = await executeAuditSuite({ targetDir: dir, full: true, preset: preset as any, core: true });
    const rec = {
      id: t.id, ok: true,
      grade: report.grade ?? null,
      score: report.overallScore ?? report.overallScoreDeterministic ?? null,
      status: report.status ?? report.overallStatus ?? null,
      reason: report.verdictReason ?? null,
      ms: Date.now() - t0, at: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(OUT, `${t.id}.json`), JSON.stringify(report, null, 2));
    state[t.id] = rec;
    done++;
    console.log(`${rec.grade} ${rec.score} ${rec.status} (${Math.round(rec.ms / 1000)}s)`);
  } catch (e: any) {
    errs++;
    state[t.id] = { id: t.id, ok: false, error: String(e?.message || e), ms: Date.now() - t0 };
    console.log(`ERR ${state[t.id].error}`);
  }
  fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
}
console.log(`\nbaseline done: ok=${done} err=${errs} of ${targets.length} (${preset})`);
