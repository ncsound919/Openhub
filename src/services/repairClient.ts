import fs from 'fs';
import path from 'path';

const UPLIFT_ROOT = process.env.UPLIFT_ROOT || 'C:\\Users\\User\\Downloads\\Uplift';
const DRAYMOND_URL = process.env.DRAYMOND_PUBLIC_URL || 'http://127.0.0.1:3444';
const DRAYMOND_DIR = path.join(UPLIFT_ROOT, 'Draymond-Orchestrator');
const BRAIN_STATE_DIR = path.join(DRAYMOND_DIR, '.draymond');

export interface RepairLogEntry {
  id?: string;
  detectedAt?: string;
  signal?: string;
  detail?: string;
  /** OBJECT `{name, service, command, safe}` in `.draymond/repair-log.json`. */
  action?: unknown;
  status?: string;
}

/**
 * One entry of `.draymond/repair-team-log.json` — the repair team's real
 * per-incident record. The fields are `repairedAt` / `failureKind` / `error` /
 * `crew` / `dispatch`, NOT `timestamp` / `signal` / `status`: this type used to
 * declare the latter, so every team-log field read by the UI was `undefined`
 * and 200 real entries rendered as blank. Kept in sync with
 * Draymond-Orchestrator `src/lib/draymond/repair-team.ts` (`RepairReport`).
 */
export interface RepairTeamLogEntry {
  jobId?: string;
  jobName?: string;
  failureKind?: string;
  error?: string;
  crew?: { lead?: string; members?: string[]; reason?: string };
  repairedAt?: string;
  lessonHints?: unknown[];
  /** `'fixed'` = repaired, `'escalated'` = not repaired, `'handed-off'` = dispatched. */
  action?: string;
  detail?: string;
  dispatch?: { kind?: string; result?: string };
}

export function readRepairLogs(): { repairLog: RepairLogEntry[]; teamLog: RepairTeamLogEntry[] } {
  let repairLog: RepairLogEntry[] = [];
  let teamLog: RepairTeamLogEntry[] = [];

  try {
    const p1 = path.join(BRAIN_STATE_DIR, 'repair-log.json');
    if (fs.existsSync(p1)) {
      const parsed = JSON.parse(fs.readFileSync(p1, 'utf8'));
      if (Array.isArray(parsed)) repairLog = parsed.slice(-50).reverse();
    }
  } catch {}

  try {
    const p2 = path.join(BRAIN_STATE_DIR, 'repair-team-log.json');
    if (fs.existsSync(p2)) {
      const parsed = JSON.parse(fs.readFileSync(p2, 'utf8'));
      if (Array.isArray(parsed)) teamLog = parsed.slice(-50).reverse();
    }
  } catch {}

  return { repairLog, teamLog };
}

export async function triggerRepairTriage(params: {
  signal: string;
  detail: string;
  kind?: 'job' | 'monitor';
  repoUrl?: string;
}): Promise<any> {
  const cronSecret = process.env.CRON_SECRET || process.env.DRAYMOND_CRON_SECRET || '';
  const url = `${DRAYMOND_URL}/api/ops/repair-triage`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cronSecret ? { Authorization: `Bearer ${cronSecret}` } : {}),
      },
      body: JSON.stringify({
        signal: params.signal,
        detail: params.detail,
        kind: params.kind || 'job',
        repoUrl: params.repoUrl,
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, error: `Draymond HTTP ${res.status}: ${text || res.statusText}` };
    }
    // A 200 without `ok:true` is a declined triage, not a transport success.
    // Never return an error-less failure — downstream renders `error` verbatim
    // and an empty one used to surface as the opaque "dispatch failed: unknown".
    let data: unknown = null;
    try { data = await res.json(); } catch { /* non-JSON 200 below */ }
    if (data && typeof data === 'object' && (data as { ok?: unknown }).ok) return data;
    const snippet = (() => {
      try {
        const s = data === null || data === undefined ? '' : String(typeof data === 'string' ? data : JSON.stringify(data));
        return s.slice(0, 200);
      } catch { return ''; }
    })();
    return { ok: false, error: `Draymond declined triage (HTTP ${res.status} without ok:true)${snippet ? `: ${snippet}` : `: ${res.statusText}`}` };
  } catch (err: any) {
    // Draymond is down — report the honest failure. The triage is recorded
    // by Draymond only when it actually runs; nothing is fabricated here.
    return {
      ok: false,
      error: `Draymond unreachable at ${DRAYMOND_URL}: ${err.message}`,
    };
  }
}
