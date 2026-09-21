import crypto from 'crypto';
import { getDb } from '../auth/db.js';
import { executeAuditSuite, type AuditReport, type AuditRunParams } from './auditSuite.js';
import { triggerRepairTriage } from './repairClient.js';
import { runTypecheck, type TypecheckResult } from './typecheck.js';
import { startAxiomProjectLoop, getAxiomProjectStatus, stopAxiomProjectLoop, runAxiomAdversary } from './axiomClient.js';
import { buildRepairBrief, renderRepairBrief } from './repairBrief.js';
import { reportIncident } from './incidentBus.js';

/**
 * Project pipeline: one background job that chains the steps a person otherwise
 * has to run by hand — typecheck → audit → repair → agent loop → verify — with
 * per-stage status and real progress, persisted so the UI can poll it and a
 * restart does not leave a job "running" forever.
 *
 * It reuses the same primitives the rest of the server already trusts
 * (executeAuditSuite, triggerRepairTriage, runTypecheck, the Axiom loop). It
 * does not invent results: a stage that could not run is recorded with its
 * error, and the audit/verify verdicts come from the real report.
 */

export type PipelineStageId = 'typecheck' | 'adversary' | 'audit' | 'repair' | 'loop' | 'verify';
export type StageStatus = 'pending' | 'running' | 'done' | 'skipped' | 'failed' | 'cancelled';
export type PipelineStatus = 'running' | 'complete' | 'failed' | 'cancelled';
export type PipelineMode = 'audit' | 'autopilot' | 'custom';

export interface PipelineStage {
  id: PipelineStageId;
  label: string;
  status: StageStatus;
  /** Outcome when the stage ran; null while pending/running or when N/A. */
  ok: boolean | null;
  detail: string;
  /** 0..1 within this stage. */
  progress: number;
  startedAt: string | null;
  endedAt: string | null;
}

export interface PipelineJob {
  id: string;
  projectPath: string;
  projectName: string;
  goal: string;
  mode: PipelineMode;
  status: PipelineStatus;
  stages: PipelineStage[];
  loopId: string | null;
  audit: AuditReport | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

const STAGE_LABELS: Record<PipelineStageId, string> = {
  typecheck: 'Typecheck',
  adversary: 'Adversary',
  audit: 'Audit team',
  repair: 'Repair dispatch',
  loop: 'Agent loop',
  verify: 'Verify',
};

/** Relative cost of each stage, used to fold per-stage progress into one bar. */
const STAGE_WEIGHTS: Record<PipelineStageId, number> = {
  typecheck: 1,
  adversary: 4,
  audit: 5,
  repair: 2,
  loop: 3,
  verify: 2,
};

const MODE_STAGES: Record<Exclude<PipelineMode, 'custom'>, PipelineStageId[]> = {
  audit: ['audit', 'repair'],
  // Adversary (mutation testing) and the audit team are part of the autonomous
  // run, not separate screens you have to remember to visit.
  autopilot: ['typecheck', 'adversary', 'audit', 'repair', 'loop', 'verify'],
};

export interface PipelineDeps {
  typecheck: (projectPath: string, timeoutMs?: number) => Promise<TypecheckResult>;
  adversary: (dir: string, maxMutants?: number) => Promise<{ checked?: boolean; verdict?: string; survived?: number; mutantsRun?: number; killRatePct?: number | null; reason?: string } | null | undefined>;
  audit: (params: AuditRunParams) => Promise<AuditReport>;
  repair: (params: { signal: string; detail: string; kind?: 'job' | 'monitor'; repoUrl?: string }) => Promise<{ ok?: boolean; error?: string } | null | undefined>;
  startLoop: (params: { goal: string; targetDir: string; maxIterations?: number }) => Promise<{ id?: string } | null | undefined>;
  loopStatus: (loopId: string) => Promise<Record<string, unknown> | null | undefined>;
  stopLoop: (loopId: string) => Promise<unknown>;
  sleep: (ms: number) => Promise<void>;
  now: () => string;
  pollIntervalMs: number;
  maxLoopMs: number;
}

const defaultDeps: PipelineDeps = {
  typecheck: runTypecheck,
  adversary: runAxiomAdversary,
  audit: executeAuditSuite,
  repair: triggerRepairTriage,
  startLoop: startAxiomProjectLoop,
  loopStatus: getAxiomProjectStatus,
  stopLoop: stopAxiomProjectLoop,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => new Date().toISOString(),
  pollIntervalMs: 5_000,
  maxLoopMs: 20 * 60_000,
};

const activeRunners = new Set<string>();
const cancelFlags = new Map<string, boolean>();

function ensureTable(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS pipeline_jobs (
      id TEXT PRIMARY KEY,
      project_path TEXT NOT NULL,
      project_name TEXT NOT NULL,
      goal TEXT NOT NULL DEFAULT '',
      mode TEXT NOT NULL,
      status TEXT NOT NULL,
      stages_json TEXT NOT NULL,
      loop_id TEXT,
      audit_json TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

function rowToJob(row: Record<string, unknown>): PipelineJob {
  let stages: PipelineStage[] = [];
  try { stages = JSON.parse(String(row.stages_json ?? '[]')) as PipelineStage[]; } catch { stages = []; }
  let audit: AuditReport | null = null;
  try { audit = row.audit_json ? (JSON.parse(String(row.audit_json)) as AuditReport) : null; } catch { audit = null; }
  return {
    id: String(row.id),
    projectPath: String(row.project_path),
    projectName: String(row.project_name),
    goal: String(row.goal ?? ''),
    mode: String(row.mode) as PipelineMode,
    status: String(row.status) as PipelineStatus,
    stages,
    loopId: row.loop_id ? String(row.loop_id) : null,
    audit,
    error: row.error ? String(row.error) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function persist(job: PipelineJob): void {
  ensureTable();
  getDb().prepare(`
    INSERT INTO pipeline_jobs (id, project_path, project_name, goal, mode, status, stages_json, loop_id, audit_json, error, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      status = excluded.status,
      stages_json = excluded.stages_json,
      loop_id = excluded.loop_id,
      audit_json = excluded.audit_json,
      error = excluded.error,
      updated_at = excluded.updated_at
  `).run(
    job.id, job.projectPath, job.projectName, job.goal, job.mode, job.status,
    JSON.stringify(job.stages), job.loopId, job.audit ? JSON.stringify(job.audit) : null,
    job.error, job.createdAt, job.updatedAt,
  );
}

/** Mark jobs left 'running' by a restart as failed, so the UI never shows a
 *  phantom in-flight run. Only jobs whose row has gone stale are reaped: a job
 *  actively running in another process (or another test worker) keeps its
 *  updated_at fresh and is left alone. */
const STALE_MS = 120_000;
function reapStale(): void {
  ensureTable();
  const rows = getDb().prepare("SELECT id, updated_at FROM pipeline_jobs WHERE status = 'running'").all() as Array<{ id: string; updated_at: string }>;
  for (const { id, updated_at } of rows) {
    if (activeRunners.has(id)) continue;
    const age = Date.now() - Date.parse(updated_at);
    if (!Number.isFinite(age) || age < STALE_MS) continue;
    const job = readJob(id);
    if (!job) continue;
    job.status = 'failed';
    job.error = 'interrupted (no progress for 2m)';
    for (const s of job.stages) {
      if (s.status === 'running') { s.status = 'failed'; s.ok = false; s.detail = 'interrupted'; }
    }
    job.updatedAt = new Date().toISOString();
    persist(job);
  }
}

function readJob(id: string): PipelineJob | null {
  ensureTable();
  const row = getDb().prepare('SELECT * FROM pipeline_jobs WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToJob(row) : null;
}

export function getPipeline(id: string): PipelineJob | null {
  reapStale();
  return readJob(id);
}

export function listPipelines(limit = 25): PipelineJob[] {
  reapStale();
  ensureTable();
  const rows = getDb().prepare('SELECT * FROM pipeline_jobs ORDER BY created_at DESC LIMIT ?').all(limit) as Array<Record<string, unknown>>;
  return rows.map(rowToJob);
}

/** 0..1 across the whole job, weighting each stage by relative cost. */
export function overallProgress(job: PipelineJob): number {
  let total = 0;
  let done = 0;
  for (const s of job.stages) {
    const w = STAGE_WEIGHTS[s.id] ?? 1;
    total += w;
    const frac = s.status === 'pending' ? 0 : s.status === 'running' ? Math.max(0, Math.min(1, s.progress)) : 1;
    done += w * frac;
  }
  return total > 0 ? done / total : 0;
}

function resolveStages(mode: PipelineMode, custom?: PipelineStageId[]): PipelineStageId[] {
  if (mode === 'custom') {
    const list = (custom ?? []).filter((s): s is PipelineStageId => s in STAGE_LABELS);
    return list.length ? list : MODE_STAGES.autopilot;
  }
  return MODE_STAGES[mode];
}

export interface StartPipelineParams {
  projectPath: string;
  projectName: string;
  goal?: string;
  mode?: PipelineMode;
  stages?: PipelineStageId[];
}

/** Start a pipeline in the background; returns the job immediately. */
export function startPipeline(params: StartPipelineParams, deps: Partial<PipelineDeps> = {}): PipelineJob {
  const d: PipelineDeps = { ...defaultDeps, ...deps };
  ensureTable();
  const now = d.now();
  const mode: PipelineMode = params.mode ?? 'autopilot';
  const stages: PipelineStage[] = resolveStages(mode, params.stages).map((id) => ({
    id,
    label: STAGE_LABELS[id],
    status: 'pending',
    ok: null,
    detail: '',
    progress: 0,
    startedAt: null,
    endedAt: null,
  }));
  const job: PipelineJob = {
    id: crypto.randomUUID(),
    projectPath: params.projectPath,
    projectName: params.projectName,
    goal: (params.goal ?? '').trim(),
    mode,
    status: 'running',
    stages,
    loopId: null,
    audit: null,
    error: null,
    createdAt: now,
    updatedAt: now,
  };
  persist(job);
  activeRunners.add(job.id);
  void runPipeline(job.id, d).catch((e: unknown) => {
    const j = readJob(job.id);
    if (j) { j.status = 'failed'; j.error = e instanceof Error ? e.message : String(e); j.updatedAt = d.now(); persist(j); }
  }).finally(() => {
    activeRunners.delete(job.id);
    cancelFlags.delete(job.id);
  });
  return job;
}

export function cancelPipeline(id: string): boolean {
  const job = readJob(id);
  if (!job || job.status !== 'running') return false;
  cancelFlags.set(id, true);
  return true;
}

function isTerminal(status?: string): boolean {
  if (!status) return false;
  return !['running', 'queued', 'starting', 'pending', 'created', 'in_progress', 'in-progress'].includes(status.toLowerCase());
}

function isCancelled(id: string): boolean {
  return cancelFlags.get(id) === true;
}

async function runPipeline(id: string, d: PipelineDeps): Promise<void> {
  const job = readJob(id);
  if (!job) return;

  const stopRemaining = (): void => {
    for (const s of job.stages) {
      if (s.status === 'pending' || s.status === 'running') { s.status = 'cancelled'; s.detail = 'cancelled'; }
    }
    job.status = 'cancelled';
    job.updatedAt = d.now();
    persist(job);
  };

  for (const stage of job.stages) {
    if (isCancelled(id)) { stopRemaining(); return; }
    stage.status = 'running';
    stage.startedAt = d.now();
    job.updatedAt = d.now();
    persist(job);
    try {
      if (stage.id === 'typecheck') await runTypecheckStage(job, stage, d);
      else if (stage.id === 'adversary') await runAdversaryStage(job, stage, d);
      else if (stage.id === 'audit') await runAuditStage(job, stage, d);
      else if (stage.id === 'repair') await runRepairStage(job, stage, d);
      else if (stage.id === 'loop') await runLoopStage(job, stage, d);
      else if (stage.id === 'verify') await runVerifyStage(job, stage, d);
      if (stage.status === 'running') stage.status = 'done';
      if (stage.status === 'done' && stage.ok === null) stage.ok = true;
    } catch (e) {
      stage.status = 'failed';
      stage.ok = false;
      stage.detail = e instanceof Error ? e.message : String(e);
    }
    stage.progress = 1;
    stage.endedAt = d.now();
    job.updatedAt = d.now();
    persist(job);
  }

  if (isCancelled(id)) { stopRemaining(); return; }
  const failed = job.stages.find((s) => s.status === 'failed');
  job.status = failed ? 'failed' : 'complete';
  if (failed && !job.error) job.error = `${failed.label}: ${failed.detail}`;
  job.updatedAt = d.now();
  persist(job);
  // Autonomy: a failed stage does not wait for a human. Log it as an incident
  // and hand it to the repair team immediately.
  if (failed) await escalateFailure(job, failed, d);
}

/**
 * Anything that errors gets the repair team, and is logged as an incident.
 * Best-effort dispatch (Draymond may be down) — the incident row is the durable
 * record either way, and the repair stage already ran its own dispatch.
 */
async function escalateFailure(job: PipelineJob, stage: PipelineStage, d: PipelineDeps): Promise<void> {
  const detail = `Pipeline "${job.mode}" stage ${stage.label} failed for ${job.projectName} (${job.projectPath}): ${stage.detail || 'no detail'}`;
  void reportIncident({
    source: 'pipeline',
    kind: `stage-${stage.id}-failed`,
    severity: 'high',
    detail,
    dedupKey: `pipeline:${job.id}:${stage.id}`,
  }).catch(() => {});
  if (stage.id === 'repair') return;
  try {
    await d.repair({ signal: `openhub:pipeline-${stage.id}-failed`, detail, kind: 'job' });
  } catch { /* dispatch is best-effort; the incident is the durable record */ }
}

async function runTypecheckStage(job: PipelineJob, stage: PipelineStage, d: PipelineDeps): Promise<void> {
  const r = await d.typecheck(job.projectPath);
  stage.ok = r.available ? r.errors.length === 0 : null;
  stage.detail = r.available
    ? r.errors.length ? `${r.errors.length} type error${r.errors.length === 1 ? '' : 's'}` : 'clean'
    : r.reason || 'typecheck unavailable';
}

/** Mutation-test the target: a suite that does not catch injected faults is a
 *  blind spot the audit's coverage numbers cannot see. Weak tests are a warn,
 *  not a hard failure. */
async function runAdversaryStage(job: PipelineJob, stage: PipelineStage, d: PipelineDeps): Promise<void> {
  const report = await d.adversary(job.projectPath, 12);
  if (!report || report.checked === false) {
    stage.ok = null;
    stage.detail = report?.reason || 'adversary did not run (no test command)';
    return;
  }
  const survived = Number(report.survived) || 0;
  const ran = Number(report.mutantsRun) || 0;
  const kill = typeof report.killRatePct === 'number' ? `${Math.round(report.killRatePct)}% killed` : 'no kill rate';
  stage.ok = report.verdict === 'strong';
  stage.detail = `${survived}/${ran} mutants survived · ${kill}`;
}

async function runAuditStage(job: PipelineJob, stage: PipelineStage, d: PipelineDeps): Promise<void> {
  const report = await d.audit({
    targetDir: job.projectPath,
    preset: 'standard',
    core: true,
    onProgress: (p) => {
      stage.progress = p.total > 0 ? Math.min(0.99, p.index / p.total) : 0;
      job.updatedAt = d.now();
      persist(job);
    },
  });
  job.audit = report;
  stage.ok = report.overallStatus !== 'fail';
  const score = typeof report.overallScore === 'number' ? ` · score ${Math.round(report.overallScore)}` : '';
  stage.detail = `verdict ${report.overallStatus}${score} · ${report.criticalFindings} critical`;
}

async function runRepairStage(job: PipelineJob, stage: PipelineStage, d: PipelineDeps): Promise<void> {
  const audit = job.audit;
  if (!audit || audit.overallStatus !== 'fail') {
    stage.status = 'skipped';
    stage.ok = true;
    stage.detail = audit ? 'audit passed — no repair needed' : 'no audit report';
    return;
  }
  const brief = buildRepairBrief(audit);
  const detail = renderRepairBrief(brief, { maxChars: 6000 });
  const r = await d.repair({ signal: 'openhub:pipeline-audit-failed', detail, kind: 'job' });
  if (r?.ok) {
    stage.ok = true;
    stage.detail = 'repair dispatched';
  } else {
    // The audit failed and repair could not be dispatched — that is a real
    // failure of the run, reported with the dispatcher's own error.
    stage.status = 'failed';
    stage.ok = false;
    stage.detail = `dispatch failed: ${r?.error ?? 'unknown'}`;
  }
}

async function runLoopStage(job: PipelineJob, stage: PipelineStage, d: PipelineDeps): Promise<void> {
  if (!job.goal) {
    stage.status = 'skipped';
    stage.ok = true;
    stage.detail = 'no goal provided — skipped';
    return;
  }
  const loop = await d.startLoop({ goal: job.goal, targetDir: job.projectPath, maxIterations: 8 });
  const loopId = typeof loop?.id === 'string' ? loop.id : null;
  if (!loopId) {
    stage.status = 'failed';
    stage.ok = false;
    stage.detail = 'Axiom returned no loop id';
    return;
  }
  job.loopId = loopId;
  job.updatedAt = d.now();
  persist(job);

  const deadline = Date.now() + d.maxLoopMs;
  for (;;) {
    if (isCancelled(job.id)) {
      try { await d.stopLoop(loopId); } catch { /* best-effort stop */ }
      stage.status = 'cancelled';
      stage.ok = false;
      stage.detail = 'cancelled';
      return;
    }
    const status = await d.loopStatus(loopId).catch(() => null);
    const s = (status?.status ?? (status?.data as Record<string, unknown> | undefined)?.status) as string | undefined;
    const iteration = (status?.iteration ?? (status?.data as Record<string, unknown> | undefined)?.iteration) as number | undefined;
    const maxIter = ((status?.maxIterations ?? (status?.data as Record<string, unknown> | undefined)?.maxIterations) as number | undefined) ?? 8;
    if (typeof iteration === 'number' && maxIter > 0) stage.progress = Math.min(0.99, iteration / maxIter);
    job.updatedAt = d.now();
    persist(job);
    if (isTerminal(s)) {
      const failed = typeof s === 'string' && /fail|error|crash|abort|timeout/i.test(s);
      stage.ok = !failed;
      stage.detail = `loop ${s ?? 'ended'}`;
      return;
    }
    if (Date.now() > deadline) {
      try { await d.stopLoop(loopId); } catch { /* best-effort stop */ }
      stage.status = 'failed';
      stage.ok = false;
      stage.detail = 'loop timed out';
      return;
    }
    await d.sleep(d.pollIntervalMs);
  }
}

async function runVerifyStage(job: PipelineJob, stage: PipelineStage, d: PipelineDeps): Promise<void> {
  const tc = await d.typecheck(job.projectPath);
  const report = await d.audit({ targetDir: job.projectPath, preset: 'quick', core: true });
  job.audit = report;
  const tcOk = tc.available ? tc.errors.length === 0 : null;
  const auditOk = report.overallStatus !== 'fail';
  stage.ok = auditOk && tcOk !== false;
  const tcText = tc.available ? `${tc.errors.length} type errors` : 'typecheck unavailable';
  stage.detail = `audit ${report.overallStatus} · ${tcText}`;
}
