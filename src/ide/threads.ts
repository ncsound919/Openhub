// Pure model for the Threads surface (Zed-style parallel agents).
//
// A "thread" is an Axiom mission run with fan-out: independent tasks execute
// concurrently, each in its own isolated git worktree. This module normalizes
// the untrusted mission payloads from Axiom (`/api/mission/list`,
// `/api/mission/status/:id`) into typed views and derives the progress/liveness
// the UI polls on. No React/DOM so the mapping is unit-testable.

export interface MissionSummary {
  id: string;
  goal: string;
  status: string;
  tasks: number;
  done: number;
  startedAt: number;
  live: boolean;
}

export interface TaskView {
  id: string;
  label: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  loopId?: string;
  targetDir?: string;
  artifactSummary?: string;
  usage?: { calls: number; promptTokens: number; completionTokens: number; totalTokens: number };
  auditVerified: boolean;
  error?: string;
  repo?: string;
  subagentRole?: string;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length ? v : undefined);
const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

/** A mission is "live" while it can still change on its own: running tasks, or
 *  parked awaiting the operator's plan decision. */
export function isMissionLive(status: unknown): boolean {
  return status === 'running' || status === 'awaiting-approval';
}

export function anyLive(missions: MissionSummary[]): boolean {
  return missions.some((m) => isMissionLive(m.status));
}

/** Normalize the `{ count, missions: [...] }` body Axiom returns. Tolerates a
 *  bare array and drops entries without an id. */
export function normalizeMissionList(raw: unknown): MissionSummary[] {
  const body = raw as { missions?: unknown } | unknown[] | null;
  const arr: unknown[] = Array.isArray(body) ? body : Array.isArray((body as { missions?: unknown })?.missions) ? (body as { missions: unknown[] }).missions : [];
  const out: MissionSummary[] = [];
  for (const item of arr) {
    const m = item as Record<string, unknown>;
    if (!m || typeof m !== 'object') continue;
    const id = str(m.id);
    if (!id) continue;
    const tasks = num(m.tasks);
    const done = num(m.done);
    out.push({
      id,
      goal: str(m.goal) ?? '',
      status: str(m.status) ?? 'unknown',
      tasks,
      done,
      startedAt: num(m.startedAt),
      live: m.live === true || isMissionLive(m.status),
    });
  }
  return out.sort((a, b) => b.startedAt - a.startedAt);
}

/** Normalize one mission's tasks from the status payload. */
export function taskViews(state: unknown): TaskView[] {
  const tasks = (state as { tasks?: unknown })?.tasks;
  if (!Array.isArray(tasks)) return [];
  const out: TaskView[] = [];
  for (const t of tasks) {
    const r = t as Record<string, unknown>;
    if (!r || typeof r !== 'object') continue;
    const usage = r.usage as Record<string, unknown> | undefined;
    out.push({
      id: str(r.id) ?? '?',
      label: str(r.label) ?? '',
      status: str(r.status) ?? 'unknown',
      attempts: num(r.attempts),
      maxAttempts: num(r.maxAttempts, 1),
      loopId: str(r.loopId),
      targetDir: str(r.targetDir),
      artifactSummary: str(r.artifactSummary),
      usage: usage && typeof usage === 'object'
        ? {
            calls: num(usage.calls),
            promptTokens: num(usage.promptTokens),
            completionTokens: num(usage.completionTokens),
            totalTokens: num(usage.totalTokens),
          }
        : undefined,
      auditVerified: !!((r.audit as { verified?: unknown } | undefined)?.verified),
      error: str(r.error),
      repo: str(r.repo),
      subagentRole: str(r.subagentRole),
    });
  }
  return out;
}

export interface Progress {
  done: number;
  failed: number;
  running: number;
  total: number;
}

export function taskProgress(tasks: Array<{ status: string }>): Progress {
  let done = 0;
  let failed = 0;
  let running = 0;
  for (const t of tasks) {
    if (t.status === 'done') done += 1;
    else if (t.status === 'failed' || t.status === 'stalled') failed += 1;
    else if (t.status === 'running' || t.status === 'pending') running += 1;
  }
  return { done, failed, running, total: tasks.length };
}

export function tokenTotal(usage?: { totalTokens: number }): number {
  return usage ? usage.totalTokens : 0;
}

/** One-line mission headline for the thread row. */
export function missionHeadline(m: MissionSummary, concurrency?: number): string {
  const base = `${m.done}/${m.tasks} task${m.tasks === 1 ? '' : 's'}`;
  return concurrency && concurrency > 1 ? `${base} · ${concurrency} parallel` : base;
}

// --- Worktree review (hold → diff → merge) ----------------------------------

export interface HeldWorktree {
  taskId: string;
  label: string;
  status: string;
  path: string;
  branch: string;
  repoDir: string;
  baseBranch: string;
  sha?: string;
}

/** Normalize the `{ worktrees: [...] }` body from `/api/axiom/mission/:id/worktrees`. */
export function heldWorktrees(raw: unknown): HeldWorktree[] {
  const list = (raw as { worktrees?: unknown } | null)?.worktrees;
  if (!Array.isArray(list)) return [];
  const out: HeldWorktree[] = [];
  for (const item of list) {
    const w = item as Record<string, unknown>;
    if (!w || typeof w !== 'object') continue;
    const taskId = str(w.taskId);
    const branch = str(w.branch);
    const path = str(w.path);
    if (!taskId || !branch || !path) continue;
    out.push({
      taskId,
      label: str(w.label) ?? '',
      status: str(w.status) ?? 'unknown',
      path,
      branch,
      repoDir: str(w.repoDir) ?? '',
      baseBranch: str(w.baseBranch) ?? '',
      sha: str(w.sha),
    });
  }
  return out;
}

/** Index held worktrees by task id for row lookup. */
export function heldByTask(list: HeldWorktree[]): Record<string, HeldWorktree> {
  const out: Record<string, HeldWorktree> = {};
  for (const w of list) out[w.taskId] = w;
  return out;
}
