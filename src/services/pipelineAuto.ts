import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getDb } from '../auth/db.js';
import { listPipelines, startPipeline, type PipelineJob } from './pipeline.js';
import { getDispatchPrefs } from './incidentBus.js';

const execFileAsync = promisify(execFile);

/**
 * Unattended Autopilot (Auto autonomy mode).
 *
 * When enabled, a scheduler tick runs the pipeline for the active project — on
 * an interval, on drift (uncommitted / ahead of upstream), or both. It is
 * deliberately conservative and fail-closed:
 *   - the fleet kill switch (OPENHUB_AUTODISPATCH=0) stops it entirely,
 *   - it never starts while another run is in flight or parked,
 *   - interval and drift each honor a cooldown so a single change is not
 *     re-run every tick,
 *   - it needs a loaded project that exists on disk.
 * Every skip is reported with a reason, never silently.
 */

export type AutoMode = 'audit' | 'autopilot';
export type AutoTrigger = 'interval' | 'drift' | 'change' | 'reactive' | 'both';

/** Which signals a trigger reacts to. `both` = everything. */
function triggerIncludes(trigger: AutoTrigger, signal: 'interval' | 'drift' | 'change'): boolean {
  if (trigger === 'both') return true;
  if (trigger === 'reactive') return signal === 'drift' || signal === 'change';
  return trigger === signal;
}

export interface AutoConfig {
  enabled: boolean;
  trigger: AutoTrigger;
  intervalMs: number;
  mode: AutoMode;
  lastRunAt: string | null;
  lastJobId: string | null;
  lastNote: string | null;
}

const KEYS = {
  enabled: 'pipeline.auto.enabled',
  trigger: 'pipeline.auto.trigger',
  intervalMs: 'pipeline.auto.intervalMs',
  mode: 'pipeline.auto.mode',
  lastRunAt: 'pipeline.auto.lastRunAt',
  lastJobId: 'pipeline.auto.lastJobId',
  lastNote: 'pipeline.auto.lastNote',
} as const;

const DEFAULT_INTERVAL_MS = 15 * 60_000;
const MIN_INTERVAL_MS = 60_000;
/** A drift-triggered run waits at least this long after the previous one. */
const DRIFT_COOLDOWN_MS = 5 * 60_000;

function ensure(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS node_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

function readAll(): Record<string, string> {
  ensure();
  const rows = getDb().prepare('SELECT key, value FROM node_settings WHERE key LIKE \'pipeline.auto.%\'').all() as Array<{ key: string; value: string }>;
  const out: Record<string, string> = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

function write(patch: Record<string, string>): void {
  ensure();
  const now = new Date().toISOString();
  const upsert = getDb().prepare('INSERT OR REPLACE INTO node_settings (key, value, updated_at) VALUES (?, ?, ?)');
  for (const [k, v] of Object.entries(patch)) upsert.run(k, v, now);
}

export function getAutoConfig(): AutoConfig {
  const raw = readAll();
  const interval = Number(raw[KEYS.intervalMs]);
  const trigger = raw[KEYS.trigger];
  const valid: AutoTrigger[] = ['interval', 'drift', 'change', 'reactive', 'both'];
  return {
    enabled: raw[KEYS.enabled] === '1',
    trigger: valid.includes(trigger as AutoTrigger) ? (trigger as AutoTrigger) : 'drift',
    intervalMs: Number.isFinite(interval) && interval >= MIN_INTERVAL_MS ? interval : DEFAULT_INTERVAL_MS,
    mode: raw[KEYS.mode] === 'audit' ? 'audit' : 'autopilot',
    lastRunAt: raw[KEYS.lastRunAt] ?? null,
    lastJobId: raw[KEYS.lastJobId] ?? null,
    lastNote: raw[KEYS.lastNote] ?? null,
  };
}

export function setAutoConfig(patch: Partial<Pick<AutoConfig, 'enabled' | 'intervalMs' | 'mode' | 'trigger'>>): AutoConfig {
  const next: Record<string, string> = {};
  if (patch.enabled !== undefined) next[KEYS.enabled] = patch.enabled ? '1' : '0';
  if (patch.intervalMs !== undefined) next[KEYS.intervalMs] = String(Math.max(MIN_INTERVAL_MS, Math.floor(patch.intervalMs)));
  if (patch.mode !== undefined) next[KEYS.mode] = patch.mode === 'audit' ? 'audit' : 'autopilot';
  if (patch.trigger !== undefined) next[KEYS.trigger] = patch.trigger;
  write(next);
  return getAutoConfig();
}

// ---------------------------------------------------------------------------
// On-save watcher (recursive fs.watch; chokidar is not a dependency here).
// ---------------------------------------------------------------------------

let watcher: fs.FSWatcher | null = null;
let watchedPath: string | null = null;
let watchUnsupported = false;
let lastChangeAt = 0;

/** Paths whose churn is not a source change (build output, deps, vcs, our data). */
const IGNORE_RE = /(^|[\\/])(node_modules|\.git|dist|build|\.next|coverage|\.turbo|data|\.vitest|test-results)([\\/]|$)|\.(log|tmp|swp)$/i;

function noteChange(filename: string | null): void {
  if (filename && IGNORE_RE.test(String(filename))) return;
  lastChangeAt = Date.now();
}

/** (Re)watch the active project when it changes. Idempotent per path. */
function ensureWatcher(projectPath: string): void {
  if (watchedPath === projectPath && (watcher || watchUnsupported)) return;
  try { watcher?.close(); } catch { /* already closed */ }
  watcher = null;
  watchedPath = projectPath;
  watchUnsupported = false;
  try {
    watcher = fs.watch(projectPath, { recursive: true }, (_event, filename) => noteChange(filename ? String(filename) : null));
    watcher.on('error', () => { watchUnsupported = true; try { watcher?.close(); } catch { /* ignore */ } watcher = null; });
  } catch {
    // Recursive watch is not supported on every platform (e.g. Linux). Report it
    // honestly rather than silently not watching.
    watchUnsupported = true;
  }
}

export interface WatchState {
  watching: boolean;
  path: string | null;
  lastChangeAt: string | null;
  unsupported: boolean;
}

export function getWatchState(): WatchState {
  return {
    watching: !!watcher,
    path: watchedPath,
    lastChangeAt: lastChangeAt ? new Date(lastChangeAt).toISOString() : null,
    unsupported: watchUnsupported,
  };
}

/** Mark a change manually (tests / external callers). */
export function noteProjectChange(): void { lastChangeAt = Date.now(); }

/** The active project across the node (single-operator: most recent selection). */
function activeProject(): { path: string; name: string } | null {
  try {
    const row = getDb().prepare(
      'SELECT p.path AS path, r.name AS name FROM active_project_context p LEFT JOIN repositories r ON r.id = p.repo_id ORDER BY p.selected_at DESC LIMIT 1',
    ).get() as { path?: string; name?: string } | undefined;
    if (!row?.path) return null;
    return { path: row.path, name: row.name ?? row.path.split(/[\\/]/).pop() ?? 'project' };
  } catch {
    return null;
  }
}

async function gitCount(dir: string, args: string[]): Promise<number> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd: dir, timeout: 8_000, windowsHide: true });
    return Number(String(stdout).trim()) || 0;
  } catch {
    return 0;
  }
}

/** Drift = uncommitted changes or commits ahead of the upstream. */
export async function hasDrift(dir: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd: dir, timeout: 8_000, windowsHide: true });
    if (String(stdout).trim().length > 0) return true;
  } catch {
    return false; // not a git worktree / git missing — no drift signal
  }
  const ahead = await gitCount(dir, ['rev-list', '--count', '@{u}..HEAD']);
  return ahead > 0;
}

export interface AutoTickResult {
  started: boolean;
  skipped?: 'disabled' | 'kill-switch' | 'busy' | 'not-due' | 'no-drift' | 'no-change' | 'no-project';
  job?: PipelineJob;
  nextRunAt?: string;
  drift?: boolean;
}

/** One scheduler tick. Safe to call manually (tests / operator). */
export async function runAutoTick(now = Date.now()): Promise<AutoTickResult> {
  const cfg = getAutoConfig();
  if (!cfg.enabled) return { started: false, skipped: 'disabled' };
  if (getDispatchPrefs().killSwitch) return { started: false, skipped: 'kill-switch' };

  // Never start while a run is in flight or parked for approval.
  const busy = listPipelines(5).some((j) => j.status === 'running' || j.status === 'awaiting-approval');
  if (busy) return { started: false, skipped: 'busy' };

  const project = activeProject();
  if (!project || !fs.existsSync(project.path)) return { started: false, skipped: 'no-project' };

  // Keep the on-save watcher pointed at the active project.
  ensureWatcher(project.path);

  const last = cfg.lastRunAt ? Date.parse(cfg.lastRunAt) : NaN;
  const sinceLast = Number.isFinite(last) ? now - last : Infinity;
  const cooldownOk = sinceLast >= DRIFT_COOLDOWN_MS;

  const wantDrift = triggerIncludes(cfg.trigger, 'drift');
  const wantChange = triggerIncludes(cfg.trigger, 'change');
  const wantInterval = triggerIncludes(cfg.trigger, 'interval');

  const drift = wantDrift ? await hasDrift(project.path) : false;
  const changed = wantChange && lastChangeAt > (Number.isFinite(last) ? last : 0);
  const dueByInterval = wantInterval && sinceLast >= cfg.intervalMs;
  const reactiveDue = (drift || changed) && cooldownOk;

  if (!reactiveDue && !dueByInterval) {
    if (cfg.trigger === 'drift') return { started: false, skipped: 'no-drift', drift };
    if (cfg.trigger === 'change') return { started: false, skipped: 'no-change', drift };
    return {
      started: false,
      skipped: 'not-due',
      drift,
      nextRunAt: wantInterval && Number.isFinite(last) ? new Date(last + cfg.intervalMs).toISOString() : undefined,
    };
  }

  const job = startPipeline({ projectPath: project.path, projectName: project.name, mode: cfg.mode });
  const why = changed ? ' (change)' : drift ? ' (drift)' : ' (timer)';
  write({
    [KEYS.lastRunAt]: new Date(now).toISOString(),
    [KEYS.lastJobId]: job.id,
    [KEYS.lastNote]: `started ${cfg.mode} for ${project.name}${why}`,
  });
  return { started: true, job, drift };
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Start the scheduler (idempotent). Ticks are cheap and skip early. */
export function startPipelineAutoScheduler(intervalMs = 30_000): void {
  if (timer) return;
  timer = setInterval(() => {
    void runAutoTick().catch(() => { /* a failed tick must not kill the scheduler */ });
  }, intervalMs);
  timer.unref?.();
}
