import fs from 'fs';
import { getDb } from '../auth/db.js';
import { listPipelines, startPipeline, type PipelineJob } from './pipeline.js';
import { getDispatchPrefs } from './incidentBus.js';

/**
 * Unattended Autopilot (Auto autonomy mode).
 *
 * When enabled, a scheduler tick runs the pipeline for the active project on an
 * interval — no button, no plan gate. It is deliberately conservative and
 * fail-closed:
 *   - the fleet kill switch (OPENHUB_AUTODISPATCH=0) stops it entirely,
 *   - it never starts while another run is in flight or parked,
 *   - it honors the configured interval,
 *   - it needs a loaded project that exists on disk.
 * Every skip is reported with a reason, never silently.
 */

export type AutoMode = 'audit' | 'autopilot';

export interface AutoConfig {
  enabled: boolean;
  intervalMs: number;
  mode: AutoMode;
  lastRunAt: string | null;
  lastJobId: string | null;
  lastNote: string | null;
}

const KEYS = {
  enabled: 'pipeline.auto.enabled',
  intervalMs: 'pipeline.auto.intervalMs',
  mode: 'pipeline.auto.mode',
  lastRunAt: 'pipeline.auto.lastRunAt',
  lastJobId: 'pipeline.auto.lastJobId',
  lastNote: 'pipeline.auto.lastNote',
} as const;

const DEFAULT_INTERVAL_MS = 15 * 60_000;
const MIN_INTERVAL_MS = 60_000;

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
  return {
    enabled: raw[KEYS.enabled] === '1',
    intervalMs: Number.isFinite(interval) && interval >= MIN_INTERVAL_MS ? interval : DEFAULT_INTERVAL_MS,
    mode: raw[KEYS.mode] === 'audit' ? 'audit' : 'autopilot',
    lastRunAt: raw[KEYS.lastRunAt] ?? null,
    lastJobId: raw[KEYS.lastJobId] ?? null,
    lastNote: raw[KEYS.lastNote] ?? null,
  };
}

export function setAutoConfig(patch: Partial<Pick<AutoConfig, 'enabled' | 'intervalMs' | 'mode'>>): AutoConfig {
  const next: Record<string, string> = {};
  if (patch.enabled !== undefined) next[KEYS.enabled] = patch.enabled ? '1' : '0';
  if (patch.intervalMs !== undefined) next[KEYS.intervalMs] = String(Math.max(MIN_INTERVAL_MS, Math.floor(patch.intervalMs)));
  if (patch.mode !== undefined) next[KEYS.mode] = patch.mode === 'audit' ? 'audit' : 'autopilot';
  write(next);
  return getAutoConfig();
}

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

export interface AutoTickResult {
  started: boolean;
  skipped?: 'disabled' | 'kill-switch' | 'busy' | 'not-due' | 'no-project';
  job?: PipelineJob;
  nextRunAt?: string;
}

/** One scheduler tick. Safe to call manually (tests / operator). */
export function runAutoTick(now = Date.now()): AutoTickResult {
  const cfg = getAutoConfig();
  if (!cfg.enabled) return { started: false, skipped: 'disabled' };
  if (getDispatchPrefs().killSwitch) return { started: false, skipped: 'kill-switch' };

  // Never start while a run is in flight or parked for approval.
  const busy = listPipelines(5).some((j) => j.status === 'running' || j.status === 'awaiting-approval');
  if (busy) return { started: false, skipped: 'busy' };

  const last = cfg.lastRunAt ? Date.parse(cfg.lastRunAt) : NaN;
  if (Number.isFinite(last) && now - last < cfg.intervalMs) {
    return { started: false, skipped: 'not-due', nextRunAt: new Date(last + cfg.intervalMs).toISOString() };
  }

  const project = activeProject();
  if (!project || !fs.existsSync(project.path)) return { started: false, skipped: 'no-project' };

  const job = startPipeline({ projectPath: project.path, projectName: project.name, mode: cfg.mode });
  write({ [KEYS.lastRunAt]: new Date(now).toISOString(), [KEYS.lastJobId]: job.id, [KEYS.lastNote]: `started ${cfg.mode} for ${project.name}` });
  return { started: true, job };
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Start the scheduler (idempotent). Ticks are cheap and skip early. */
export function startPipelineAutoScheduler(intervalMs = 30_000): void {
  if (timer) return;
  timer = setInterval(() => {
    try { runAutoTick(); } catch { /* a failed tick must not kill the scheduler */ }
  }, intervalMs);
  timer.unref?.();
}
