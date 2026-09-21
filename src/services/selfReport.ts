import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb } from '../auth/db.js';
import { listIncidents, dispatchState } from './incidentBus.js';
import { listRuns } from './supervisor.js';
import { summarizeEvents, listEvents, recordEvent } from './telemetry.js';
import { sourceCounts } from './ecosystemKnowledge.js';
import { recourseStatus, recourseMemoryIndex } from './recourseClient.js';
import { getAxiomStatus } from './axiomClient.js';

/**
 * OpenHub self-report — OpenHub's own first-person status, assembled from real
 * local signals only, written durably, and (optionally) pushed into Recourse's
 * fleet memory so the autonomous system can wire into OpenHub's state.
 *
 * Honesty contract (same discipline as systemSnapshot / telemetry):
 *  - Every section is independently `{ ok: true, ... }` or `{ ok: false, error }`.
 *    A failing subsystem degrades only its own section — nothing is fabricated.
 *  - The report carries a versioned `schema` so an external consumer can pin to
 *    a contract instead of guessing.
 *  - `pushToRecourse` reports whether the write actually landed; a missing
 *    Recourse intake answers `available: false` and is never shown as success.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SELF_REPORT_SCHEMA = 'openhub-self-report-v1';
const ACTIVITY_WINDOW_MS = Number(process.env.OPENHUB_SELF_REPORT_WINDOW_MS) || 24 * 60 * 60 * 1000;
const MAX_HISTORY = Number(process.env.OPENHUB_SELF_REPORT_HISTORY) || 500;

export type ReportSection<T> = ({ ok: true } & T) | { ok: false; error: string };

async function safe<T>(fn: () => T | Promise<T>): Promise<ReportSection<T>> {
  try {
    const value = await fn();
    if (value && typeof value === 'object' && 'ok' in (value as Record<string, unknown>)) {
      return value as ReportSection<T>;
    }
    return { ok: true, ...(value as T) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface SelfReport {
  schema: typeof SELF_REPORT_SCHEMA;
  at: string;
  identity: ReportSection<{
    name: string;
    version: string;
    pid: number;
    uptimeSec: number;
    platform: string;
    node: string;
    port: number | null;
  }>;
  activity: ReportSection<{
    windowMs: number;
    total: number;
    bySystem: Record<string, number>;
    byKind: Record<string, number>;
    byOutcome: Record<string, number>;
    bySeverity: Record<string, number>;
    passRate: number | null;
    recent: Array<{ at: string; system: string; kind: string; outcome?: string; severity?: string }>;
  }>;
  incidents: ReportSection<{ recent: unknown[]; bySeverity: Record<string, number>; dispatch: unknown }>;
  runs: ReportSection<{ total: number; active: number; latest: unknown }>;
  audit: ReportSection<{ verdict: string; reportId: string; at: string }>;
  ecosystem: ReportSection<{ sources: unknown[]; entries: number }>;
  bridges: {
    axiom: ReportSection<{ online: boolean }>;
    recourse: ReportSection<{ available: boolean; status?: number; error?: string }>;
  };
}

function identitySection(): SelfReport['identity'] {
  return {
    ok: true,
    name: 'openhub',
    version: process.env.npm_package_version || '2.0.0',
    pid: process.pid,
    uptimeSec: Math.round(process.uptime()),
    platform: process.platform,
    node: process.version,
    port: Number.isFinite(Number(process.env.PORT)) ? Number(process.env.PORT) : null,
  };
}

function reportDir(): string {
  return process.env.OPENHUB_SELF_REPORT_DIR
    ? path.resolve(process.env.OPENHUB_SELF_REPORT_DIR)
    : path.resolve(__dirname, '..', '..', 'data', 'self-report');
}

export function selfReportFile(): string {
  return path.join(reportDir(), 'openhub-self-report.json');
}

export function selfReportHistoryFile(): string {
  return path.join(reportDir(), 'history.jsonl');
}

function atomicWriteJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/** Assemble a fresh self-report from the live system. Never throws. */
export async function buildSelfReport(): Promise<SelfReport> {
  const identity = await safe(async () => identitySection());

  const activity = await safe(async () => {
    const summary = summarizeEvents({ sinceMs: ACTIVITY_WINDOW_MS, limit: 5000 });
    const recent = listEvents({ sinceMs: ACTIVITY_WINDOW_MS, limit: 20 }).map((e) => ({
      at: e.at,
      system: e.system,
      kind: e.kind,
      ...(e.outcome ? { outcome: e.outcome } : {}),
      ...(e.severity ? { severity: e.severity } : {}),
    }));
    return { ...summary, windowMs: ACTIVITY_WINDOW_MS, recent };
  });

  const incidents = await safe(() => {
    const recent = listIncidents(8);
    const bySeverity: Record<string, number> = {};
    for (const i of recent as Array<{ severity?: string }>) {
      const s = i?.severity ?? 'unknown';
      bySeverity[s] = (bySeverity[s] ?? 0) + 1;
    }
    return { recent, bySeverity, dispatch: dispatchState() };
  });

  const runs = await safe(() => {
    const list = listRuns(5);
    return {
      total: list.length,
      active: list.filter((r) => ['looping', 'auditing', 'repairing'].includes(r.status)).length,
      latest: list[0] ?? null,
    };
  });

  const audit = await safe(() => {
    const row = getDb()
      .prepare('SELECT id, overall_status, created_at FROM audit_reports ORDER BY created_at DESC LIMIT 1')
      .get() as { id: string; overall_status: string; created_at: string } | undefined;
    if (!row) return { ok: false as const, error: 'no audit recorded' };
    return { verdict: row.overall_status, reportId: row.id, at: row.created_at };
  });

  const ecosystem = await safe(() => {
    const sources = sourceCounts();
    return { sources, entries: sources.reduce((n, s) => n + s.entries, 0) };
  });

  const axiom = await safe(async () => {
    const status = await getAxiomStatus();
    return { online: Boolean(status && (status.ok === undefined || status.ok !== false)) };
  });

  const recourse = await safe(async () => {
    const r = await recourseStatus();
    return { available: r.available, ...(r.status !== undefined ? { status: r.status } : {}), ...(r.error ? { error: r.error } : {}) };
  });

  return {
    schema: SELF_REPORT_SCHEMA,
    at: new Date().toISOString(),
    identity,
    activity,
    incidents,
    runs,
    audit,
    ecosystem,
    bridges: { axiom, recourse },
  };
}

/** Durable write: latest JSON (atomic) + one compact history record. */
export function writeSelfReport(report: SelfReport): { wrote: boolean; file: string; error?: string } {
  try {
    atomicWriteJson(selfReportFile(), report);
    const compact = {
      at: report.at,
      uptimeSec: report.identity.ok ? report.identity.uptimeSec : null,
      activityTotal: report.activity.ok ? report.activity.total : null,
      passRate: report.activity.ok ? report.activity.passRate : null,
      incidents: report.incidents.ok ? (report.incidents.recent as unknown[]).length : null,
      runsActive: report.runs.ok ? report.runs.active : null,
      axiomOnline: report.bridges.axiom.ok ? report.bridges.axiom.online : null,
      recourseAvailable: report.bridges.recourse.ok ? report.bridges.recourse.available : null,
    };
    fs.mkdirSync(path.dirname(selfReportHistoryFile()), { recursive: true });
    fs.appendFileSync(selfReportHistoryFile(), `${JSON.stringify(compact)}\n`, 'utf8');
    trimHistory();
    return { wrote: true, file: selfReportFile() };
  } catch (err) {
    return { wrote: false, file: selfReportFile(), error: err instanceof Error ? err.message : String(err) };
  }
}

function trimHistory(): void {
  try {
    const file = selfReportHistoryFile();
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
    if (lines.length <= MAX_HISTORY) return;
    const kept = lines.slice(lines.length - MAX_HISTORY);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, `${kept.join('\n')}\n`, 'utf8');
    fs.renameSync(tmp, file);
  } catch {
    /* best-effort cap */
  }
}

export function readSelfReport(): SelfReport | null {
  try {
    const raw = fs.readFileSync(selfReportFile(), 'utf8');
    const parsed = JSON.parse(raw) as SelfReport;
    return parsed && parsed.schema === SELF_REPORT_SCHEMA ? parsed : null;
  } catch {
    return null;
  }
}

export function readSelfReportHistory(limit = 50): unknown[] {
  try {
    const lines = fs.readFileSync(selfReportHistoryFile(), 'utf8').split(/\r?\n/).filter(Boolean);
    const out: unknown[] = [];
    for (const line of lines.slice(-Math.max(1, limit))) {
      try {
        out.push(JSON.parse(line));
      } catch {
        /* skip corrupt line */
      }
    }
    return out.reverse();
  } catch {
    return [];
  }
}

/** Push a compact self-report into Recourse's fleet memory. Honest about failure. */
export async function pushSelfReport(report: SelfReport): Promise<{ pushed: boolean; available: boolean; error?: string }> {
  const summary = [
    `OpenHub self-report ${report.at}`,
    report.identity.ok ? `uptime=${report.identity.uptimeSec}s v${report.identity.version}` : 'identity unavailable',
    report.activity.ok ? `events=${report.activity.total} passRate=${report.activity.passRate ?? 'n/a'}` : 'activity unavailable',
    report.incidents.ok ? `incidents=${(report.incidents.recent as unknown[]).length}` : 'incidents unavailable',
    report.runs.ok ? `runsActive=${report.runs.active}` : 'runs unavailable',
  ].join(' · ');
  const r = await recourseMemoryIndex({ kind: 'openhub-self-report', text: summary, data: report });
  return { pushed: r.available, available: r.available, ...(r.error ? { error: r.error } : {}) };
}

export interface RefreshResult {
  ok: boolean;
  report: SelfReport;
  write: { wrote: boolean; file: string; error?: string };
  push?: { pushed: boolean; available: boolean; error?: string };
}

/** Build → persist → (optionally) push → record a telemetry event. */
export async function refreshSelfReport(opts: { push?: boolean } = {}): Promise<RefreshResult> {
  const report = await buildSelfReport();
  const write = writeSelfReport(report);
  let push: RefreshResult['push'];
  if (opts.push) {
    try {
      push = await pushSelfReport(report);
    } catch (err) {
      push = { pushed: false, available: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  recordEvent({
    system: 'openhub',
    kind: 'self-report',
    severity: 'info',
    outcome: write.wrote ? 'accepted' : 'rejected',
    data: {
      schema: report.schema,
      wrote: write.wrote,
      pushed: push?.pushed ?? false,
      axiomOnline: report.bridges.axiom.ok ? report.bridges.axiom.online : null,
      recourseAvailable: report.bridges.recourse.ok ? report.bridges.recourse.available : null,
    },
  });
  return { ok: write.wrote, report, write, ...(push ? { push } : {}) };
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Continuously refresh + push the self-report; unref'd so it never blocks exit. */
export function startSelfReportLoop(intervalMs = Number(process.env.OPENHUB_SELF_REPORT_INTERVAL_MS) || 300_000): void {
  if (timer) return;
  const tick = () => {
    void refreshSelfReport({ push: true }).catch((err) => {
      console.warn('[self-report] refresh failed:', err instanceof Error ? err.message : err);
    });
  };
  timer = setInterval(tick, Math.max(30_000, intervalMs));
  if (typeof timer.unref === 'function') timer.unref();
  tick();
}

export function stopSelfReportLoop(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
