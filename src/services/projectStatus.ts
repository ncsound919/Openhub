import fs from 'fs';
import path from 'path';
import { getActiveProject } from './projectContext.js';
import { listRuns } from './supervisor.js';
import { getDb } from '../auth/db.js';

/**
 * Per-project status file — `.openhub/status.json` committed into the repo so
 * any OpenHub node (e.g. "localhub") can resume from the last point of work.
 * Read on load, written on every supervised run / audit, and pushed to origin
 * via a dedicated sync so the state travels with the project on GitHub.
 */

export const STATUS_FILE_PATH = '.openhub/status.json';

export interface StatusScores {
  scorer: string;
  score: number | null;
  summary: string;
}

export interface ProjectStatusSnapshot {
  generatedAt: string;
  project: { name: string; path: string; githubFullName: string | null; branch: string | null };
  lastRun: { id: string; status: string; goal: string; auditVerdict: string | null; updatedAt: string } | null;
  lastAudit: { id: string; overallStatus: string; timestamp: string; scores: StatusScores[] } | null;
  todos: number;
  modelRoutes: Record<string, string>;
}

export function statusFilePath(targetDir: string): string {
  return path.join(targetDir, STATUS_FILE_PATH);
}

export function readProjectStatus(targetDir: string): ProjectStatusSnapshot | null {
  try {
    const p = statusFilePath(targetDir);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')) as ProjectStatusSnapshot;
  } catch {
    return null;
  }
}

export function writeProjectStatus(targetDir: string, snapshot: ProjectStatusSnapshot): void {
  try {
    const p = statusFilePath(targetDir);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(snapshot, null, 2), 'utf8');
  } catch { /* status write is best-effort */ }
}

function latestAudit(userId: string): ProjectStatusSnapshot['lastAudit'] {
  try {
    const db = getDb();
    const row = db.prepare('SELECT * FROM audit_reports ORDER BY created_at DESC LIMIT 1').get() as
      | { id: string; created_at: string; overall_status: string; report_json: string }
      | undefined;
    if (!row) return null;
    let report: any = null;
    try { report = JSON.parse(row.report_json); } catch { report = null; }
    const scores: StatusScores[] = Array.isArray(report?.results)
      ? report.results.map((r: any) => ({ scorer: r.scorer, score: r.score, summary: r.summary ?? '' }))
      : [];
    return { id: row.id, overallStatus: row.overall_status, timestamp: row.created_at, scores };
  } catch {
    return null;
  }
}

function latestRun(userId: string): ProjectStatusSnapshot['lastRun'] {
  try {
    const runs = listRuns(1);
    if (!runs.length) return null;
    const r = runs[0];
    return {
      id: r.id,
      status: r.status,
      goal: r.goal,
      auditVerdict: r.audit?.overallStatus ?? null,
      updatedAt: r.updatedAt,
    };
  } catch {
    return null;
  }
}

function readTodos(targetDir: string): number {
  try {
    const p = path.join(targetDir, '.openhub', 'todos.json');
    if (!fs.existsSync(p)) return 0;
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
    return Array.isArray(parsed?.todos) ? parsed.todos.filter((t: any) => !t?.done).length : 0;
  } catch {
    return 0;
  }
}

/** Build the current status snapshot for the active project. */
export function buildProjectStatusSnapshot(userId: string): ProjectStatusSnapshot | null {
  const project = getActiveProject(userId);
  if (!project) return null;
  return {
    generatedAt: new Date().toISOString(),
    project: {
      name: project.repositoryName,
      path: project.path,
      githubFullName: project.githubFullName,
      branch: project.defaultBranch,
    },
    lastRun: latestRun(userId),
    lastAudit: latestAudit(userId),
    todos: readTodos(project.path),
    modelRoutes: {},
  };
}

/** Persist the current state to the project's status file (no git). */
export function saveProjectStatus(userId: string): ProjectStatusSnapshot | null {
  const snapshot = buildProjectStatusSnapshot(userId);
  if (snapshot) writeProjectStatus(snapshot.project.path, snapshot);
  return snapshot;
}
