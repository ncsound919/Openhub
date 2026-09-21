import fs from 'fs';
import path from 'path';

const UPLIFT_ROOT = process.env.UPLIFT_ROOT || 'C:\\Users\\User\\Downloads\\Uplift';
const DRAYMOND_URL = process.env.DRAYMOND_PUBLIC_URL || 'http://127.0.0.1:3444';
const DRAYMOND_DIR = path.join(UPLIFT_ROOT, 'Draymond-Orchestrator');
const BRAIN_STATE_DIR = path.join(DRAYMOND_DIR, '.draymond');

export interface RepairLogEntry {
  timestamp?: string;
  signal?: string;
  detail?: string;
  action?: string;
  status?: string;
  crew?: any;
}

export function readRepairLogs(): { repairLog: RepairLogEntry[]; teamLog: RepairLogEntry[] } {
  let repairLog: RepairLogEntry[] = [];
  let teamLog: RepairLogEntry[] = [];

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
    return await res.json();
  } catch (err: any) {
    // Draymond is down — report the honest failure. The triage is recorded
    // by Draymond only when it actually runs; nothing is fabricated here.
    return {
      ok: false,
      error: `Draymond unreachable at ${DRAYMOND_URL}: ${err.message}`,
    };
  }
}
