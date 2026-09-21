import crypto from 'crypto';
import path from 'path';
import { getDb } from '../auth/db.js';
import { startAxiomProjectLoop, getAxiomProjectStatus } from './axiomClient.js';
import { executeAuditSuite, type AuditReport } from './auditSuite.js';
import { triggerRepairTriage } from './repairClient.js';
import { loadFleetCatalog } from './fleetCatalog.js';
import { searchKnowledge } from './ecosystemKnowledge.js';
import { matchSkills, type Matchable } from '../lib/skillMatch.js';
import { recourseMemoryRecall, recourseMemoryIndex } from './recourseClient.js';
import { saveProjectStatus } from './projectStatus.js';
import { getAgentReadouts, buildWorkOrder } from './agentReadouts.js';
import { buildRepairBrief, renderRepairBrief } from './repairBrief.js';
import { reportIncident } from './incidentBus.js';
import { recordEvent } from './telemetry.js';
import { advise, recordEpisode } from './selfLearning.js';

/**
 * Supervised runs: dispatch an Axiom loop, watch it to completion, then run
 * the audit team against the result and dispatch repair when it fails. Every
 * step is persisted to `supervision_runs`, so progress survives restarts and
 * the screens load the same timeline the server recorded. Nothing here
 * fabricates a result — a loop/audit/repair that could not run is recorded
 * with an explicit error.
 */

export type SupervisionStatus = 'looping' | 'auditing' | 'repairing' | 'complete' | 'failed';

export interface SupervisionRun {
  id: string;
  goal: string;
  targetDir: string;
  loopId: string | null;
  status: SupervisionStatus;
  iteration: number;
  maxIterations: number;
  skills: { name: string; kind: string; reason?: string }[];
  audit: AuditReport | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

const POLL_INTERVAL_MS = 5_000;
const MAX_POLL_MS = 30 * 60_000;
const activePollers = new Map<string, boolean>();
const runOwners = new Map<string, string>();

function ensureTable(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS supervision_runs (
      id TEXT PRIMARY KEY,
      goal TEXT NOT NULL,
      target_dir TEXT NOT NULL,
      loop_id TEXT,
      status TEXT NOT NULL,
      iteration INTEGER DEFAULT 0,
      max_iterations INTEGER DEFAULT 8,
      skills TEXT NOT NULL DEFAULT '[]',
      audit_json TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function rowToRun(row: any): SupervisionRun {
  let skills: { name: string; kind: string; reason?: string }[] = [];
  try { skills = JSON.parse(row.skills ?? '[]'); } catch { skills = []; }
  let audit: AuditReport | null = null;
  try { audit = row.audit_json ? JSON.parse(row.audit_json) : null; } catch { audit = null; }
  return {
    id: row.id,
    goal: row.goal,
    targetDir: row.target_dir,
    loopId: row.loop_id,
    status: row.status,
    iteration: row.iteration ?? 0,
    maxIterations: row.max_iterations ?? 8,
    skills,
    audit,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getRun(id: string): SupervisionRun | null {
  ensureTable();
  const row = getDb().prepare('SELECT * FROM supervision_runs WHERE id = ?').get(id);
  return row ? rowToRun(row) : null;
}

export function listRuns(limit = 50): SupervisionRun[] {
  ensureTable();
  const rows = getDb().prepare('SELECT * FROM supervision_runs ORDER BY created_at DESC LIMIT ?').all(limit);
  return (rows as any[]).map(rowToRun);
}

function insert(run: SupervisionRun): void {
  ensureTable();
  getDb().prepare(`
    INSERT INTO supervision_runs (id, goal, target_dir, loop_id, status, iteration, max_iterations, skills, audit_json, error, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    run.id, run.goal, run.targetDir, run.loopId, run.status, run.iteration, run.maxIterations,
    JSON.stringify(run.skills), run.audit ? JSON.stringify(run.audit) : null, run.error, run.createdAt, run.updatedAt,
  );
}

function update(run: SupervisionRun, patch: Partial<SupervisionRun>): SupervisionRun {
  const next: SupervisionRun = { ...run, ...patch, updatedAt: new Date().toISOString() };
  getDb().prepare(`
    UPDATE supervision_runs SET loop_id = ?, status = ?, iteration = ?, audit_json = ?, error = ?, updated_at = ?
    WHERE id = ?
  `).run(
    next.loopId, next.status, next.iteration, next.audit ? JSON.stringify(next.audit) : null, next.error, next.updatedAt, next.id,
  );
  return next;
}

/** Best-matching skills/tools for a goal, from the fleet catalog + knowledge index. */
export function bestSkillsFor(goal: string, limit = 5): { name: string; kind: string; reason?: string }[] {
  const candidates: Matchable[] = [];
  try {
    const catalog = loadFleetCatalog();
    for (const a of catalog.assets) {
      if (a.kind === 'job') continue;
      candidates.push({ id: `catalog:${a.name}`, name: a.name, kind: a.kind, description: a.description });
    }
  } catch { /* catalog absent — no candidates from it */ }
  try {
    const know = searchKnowledge({ limit: 300 });
    for (const e of know.entries) {
      candidates.push({ id: `know:${e.kind}:${e.key}`, name: e.name, kind: e.kind, description: e.description });
    }
  } catch { /* knowledge index absent */ }
  return matchSkills(goal, candidates, limit).map((s) => ({ name: s.name, kind: s.kind ?? 'tool', reason: s.reason }));
}

/** Recourse self-learning recall folded into the skill set as synergy hints. */
async function synergyHints(goal: string, limit = 3): Promise<{ name: string; kind: string; reason?: string }[]> {
  try {
    const recall = await recourseMemoryRecall(goal);
    if (!recall.available || !recall.data) return [];
    const items: unknown[] = Array.isArray(recall.data)
      ? recall.data
      : Array.isArray(recall.data?.results) ? recall.data.results : Array.isArray(recall.data?.matches) ? recall.data.matches : [];
    return items.slice(0, limit).map((it: any, i: number) => ({
      name: (typeof it?.text === 'string' && it.text) || (typeof it?.content === 'string' && it.content) || `recalled memory ${i + 1}`,
      kind: 'synergy',
      reason: 'recourse memory',
    }));
  } catch {
    return [];
  }
}

function isTerminal(status?: string): boolean {
  if (!status) return false;
  const s = status.toLowerCase();
  return !['running', 'queued', 'starting', 'pending', 'created', 'in_progress', 'in-progress'].includes(s);
}

async function onLoopComplete(id: string): Promise<void> {
  let run = getRun(id);
  if (!run) return;
  run = update(run, { status: 'auditing' });
  // PR-grade gate on every loop: the `standard` preset (LLM grades, SAST via
  // The Deep, SCA, tests, typecheck, lint — diff-scoped when possible).
  // Unavailable scorers report `unavailable` and are excluded from the grade,
  // never zeroed, so a down tool weakens the gate honestly instead of
  // silently passing or failing the loop.
  const audit = await executeAuditSuite({ targetDir: run.targetDir, preset: 'standard', core: true });
  if (audit.overallStatus === 'fail') {
    run = update(run, { status: 'repairing', audit });
    // The fresh, deduped findings are the primary work order — they carry
    // file:line, severity and remediation. Only when the audit produces no
    // file-level findings do we fall back to the newest on-disk agent readouts,
    // so nothing is silently lost.
    const brief = buildRepairBrief(audit);
    let workOrderText = renderRepairBrief(brief, { maxChars: 3500 });
    if (brief.items.length === 0) {
      const readouts = getAgentReadouts(path.basename(run.targetDir));
      const workOrder = buildWorkOrder(readouts);
      const fallback = workOrder.items.slice(0, 25).map((w, i) =>
        `${i + 1}. ${w.file}${w.line ? `:${w.line}` : ''} [${w.category}] ${w.title} — ${w.suggestion}`,
      ).join('\n');
      if (fallback) workOrderText = `REPAIR BRIEF (from on-disk agent readouts — audit produced no file-level findings):\n${fallback}`;
    }
    const detail = [
      `audit verdict: ${audit.overallStatus}`,
      ...audit.results.map((r) => `${r.scorer}: ${r.error || r.summary}`),
      workOrderText ? `\n${workOrderText}` : '',
    ].join('; ').slice(0, 6000);
    const repair = await triggerRepairTriage({ signal: 'openhub:supervised-audit-failed', detail, kind: 'job' });
    if (repair?.ok) {
      update(run, { status: 'complete' });
    } else {
      update(run, { status: 'failed', error: repair?.error ?? 'repair dispatch failed' });
      void reportIncident({
        source: 'supervisor',
        kind: 'repair-dispatch-failed',
        severity: 'high',
        detail: `Repair dispatch failed for run ${run.id}: ${repair?.error ?? 'unknown'}.`,
        dedupKey: `repair:${run.id}`,
      }).catch(() => {});
    }
  } else {
    update(run, { status: 'complete', audit });
  }
  // Self-learning feedback: fold the outcome into Recourse memory (best-effort).
  void recourseMemoryIndex({
    source: 'openhub-supervisor',
    goal: run.goal,
    targetDir: run.targetDir,
    overallStatus: audit.overallStatus,
    scored: audit.results.map((r) => ({ scorer: r.scorer, score: r.score, summary: r.summary })),
  }).catch(() => {});
  // Unified telemetry: one event per completed run with its final verdict.
  recordEvent({
    system: 'supervisor',
    kind: 'run-complete',
    severity: audit.overallStatus === 'fail' ? 'high' : 'info',
    outcome: audit.overallStatus === 'fail' ? 'rejected' : 'accepted',
    goal: run.goal,
    targetDir: run.targetDir,
    data: {
      runId: run.id,
      loopId: run.loopId,
      overallStatus: audit.overallStatus,
      scorers: audit.results.map((r) => ({ scorer: r.scorer, score: r.score })),
    },
  });
  // Self-learning: attribute the outcome to the skills that were applied, so
  // future skill selection is evidence-based.
  recordEpisode({
    kind: 'supervision',
    outcome: audit.overallStatus === 'fail' ? 'rejected' : 'accepted',
    goal: run.goal,
    targetDir: run.targetDir,
    action: 'supervision',
    skills: run.skills.map((s) => s.name),
    signals: {
      overallStatus: audit.overallStatus,
      scorers: audit.results.map((r) => ({ scorer: r.scorer, score: r.score })),
    },
    systems: ['axiom', 'audit'],
  });
  // Persist the project status file so any node can resume from here.
  const owner = runOwners.get(run.id);
  if (owner) saveProjectStatus(owner);
}

async function poll(id: string): Promise<void> {
  const deadline = Date.now() + MAX_POLL_MS;
  while (activePollers.get(id)) {
    const run = getRun(id);
    if (!run || !run.loopId) break;
    try {
      const status = await getAxiomProjectStatus(run.loopId);
      const s = status?.status ?? status?.data?.status;
      const iteration = status?.iteration ?? status?.data?.iteration;
      if (typeof iteration === 'number') update(run, { iteration });
      if (isTerminal(s)) {
        activePollers.set(id, false);
        const failed = typeof s === 'string' && /fail|error|crash|abort|timeout/i.test(s);
        if (failed) {
          void reportIncident({
            source: 'axiom',
            kind: 'loop-failed',
            severity: 'high',
            detail: `Loop ${run.loopId} ended ${s} on "${run.goal.slice(0, 160)}" — auditing the build, then repair.`,
            dedupKey: `loop:${run.loopId}`,
          }).catch(() => {});
        }
        await onLoopComplete(id);
        return;
      }
    } catch { /* status poll failed — keep polling until deadline */ }
    if (Date.now() > deadline) {
      activePollers.set(id, false);
      update(run, { status: 'failed', error: 'Supervision timed out waiting for the loop to finish.' });
      void reportIncident({
        source: 'supervisor',
        kind: 'loop-timeout',
        severity: 'high',
        detail: `Run ${id} ("${run.goal.slice(0, 160)}") timed out waiting for the Axiom loop.`,
        dedupKey: `supervision:${id}`,
      }).catch(() => {});
      return;
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

/** Dispatch a loop + audit + repair chain. Returns the run immediately; the
 *  audit/repair steps run in the background and are persisted as they happen. */
export async function startSupervision(params: {
  goal: string;
  targetDir: string;
  maxIterations?: number;
  modelRoute?: string;
  userId?: string;
}): Promise<SupervisionRun> {
  ensureTable();
  const now = new Date().toISOString();
  // Skill selection is self-improving: learned effectiveness (OpenHub's own
  // episodes) first, then catalog/knowledge matches, then Recourse synergy.
  const learned = advise(params.goal).skills.map((s) => ({ name: s.name, kind: s.kind, reason: s.reason }));
  const matched = bestSkillsFor(params.goal);
  const synergy = await synergyHints(params.goal);
  const seen = new Set<string>();
  const skills = [...learned, ...matched, ...synergy]
    .filter((s) => {
      const key = (s.name || '').toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 12);

  const run: SupervisionRun = {
    id: crypto.randomUUID(),
    goal: params.goal,
    targetDir: params.targetDir,
    loopId: null,
    status: 'looping',
    iteration: 0,
    maxIterations: params.maxIterations ?? 8,
    skills,
    audit: null,
    error: null,
    createdAt: now,
    updatedAt: now,
  };
  try {
    const loop = await startAxiomProjectLoop({
      goal: params.goal,
      targetDir: params.targetDir,
      maxIterations: params.maxIterations,
      modelRoute: params.modelRoute,
      skills: run.skills,
    });
    run.loopId = typeof loop?.id === 'string' ? loop.id : null;
    if (!run.loopId) {
      run.status = 'failed';
      run.error = 'Axiom returned no loop id';
    }
  } catch (err) {
    run.status = 'failed';
    run.error = err instanceof Error ? err.message : String(err);
  }
  insert(run);
  recordEvent({
    system: 'supervisor',
    kind: 'run-start',
    severity: run.status === 'failed' ? 'high' : 'info',
    outcome: run.status === 'failed' ? 'error' : 'pending',
    goal: run.goal,
    targetDir: run.targetDir,
    data: { runId: run.id, loopId: run.loopId, status: run.status, skills: run.skills.map((s) => s.name) },
  });
  if (run.status === 'looping' && run.loopId) {
    if (params.userId) runOwners.set(run.id, params.userId);
    activePollers.set(run.id, true);
    void poll(run.id);
  }
  return run;
}

/** Re-attach a poller to a run left in 'looping' by a server restart. */
export function resumeSupervision(id: string): SupervisionRun | null {
  const run = getRun(id);
  if (!run || run.status !== 'looping' || !run.loopId) return run;
  if (!activePollers.get(id)) {
    activePollers.set(id, true);
    void poll(id);
  }
  return run;
}

/** Stop polling a run; leaves its ledger row for the timeline. */
export function stopSupervision(id: string): boolean {
  activePollers.set(id, false);
  const run = getRun(id);
  if (run && run.status === 'looping') update(run, { error: 'Stopped by operator' });
  return true;
}
