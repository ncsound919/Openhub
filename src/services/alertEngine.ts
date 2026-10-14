import fs from 'node:fs';
import path from 'node:path';
import { reportIncident, type IncidentSeverity, type IncidentSource } from './incidentBus.js';

/**
 * Alert bridge — feeds the security spine into OpenHub's incident bus.
 *
 * Two producers append AlertEnvelope lines (interfaces §1):
 *   - Draymond scheduled jobs → <draymond>/.draymond/security-alerts.jsonl
 *   - Keywire scheduled scan  → <keywire>/data/security/alerts.jsonl
 * This loop tails both and reports each new envelope as an incident, flowing
 * through the existing rails: repair auto-dispatch, `alert.raised` webhooks,
 * ntfy channel, dedupe.
 *
 * Read-only on both producers; files are appended by their owners, never here.
 * Gated by OPENHUB_ALERTS=0; cadence via OPENHUB_ALERTS_INTERVAL_MS.
 */

function pollFiles(): string[] {
  const upliftRoot = process.env.UPLIFT_ROOT || 'C:/Users/User/Downloads/Uplift';
  const draymondDir =
    process.env.OPENHUB_DRAYMOND_DIR ||
    process.env.DRAYMOND_REGISTRY_DIR ||
    path.join(upliftRoot, 'Draymond-Orchestrator', '.draymond');
  const keywireAlerts =
    process.env.OPENHUB_KEYWIRE_ALERTS_FILE ||
    path.join(process.env.KEYWIRE_ROOT || 'C:/Users/User/Downloads/BUSINESS/INFRASTRUCTURE/Keywire', 'data', 'security', 'alerts.jsonl');
  return [path.join(draymondDir, 'security-alerts.jsonl'), keywireAlerts];
}

const SEVERITY_MAP: Record<string, IncidentSeverity> = {
  critical: 'critical',
  high: 'high',
  medium: 'medium',
  low: 'low',
  info: 'low',
};

const SOURCE_MAP: Record<string, IncidentSource> = {
  draymond: 'draymond',
  keywire: 'ecosystem',
  backup: 'system',
  ci: 'system',
  agentbrowser: 'system',
};

interface RawEnvelope {
  source?: string;
  kind?: string;
  severity?: string;
  detail?: string;
  dedupKey?: string;
  ts?: string;
}

// Per-file cursor + a one-time baseline so a restart does not replay history
// into the incident bus (dedupe is only 15m).
const cursors = new Map<string, number>();
const baselined = new Set<string>();

async function processFile(file: string): Promise<number> {
  let lines: string[];
  try {
    lines = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean);
  } catch {
    return 0; // producer has not written yet — honest no-op
  }

  if (!baselined.has(file)) {
    baselined.add(file);
    cursors.set(file, lines.length);
    return 0;
  }

  let cursor = cursors.get(file) ?? 0;
  if (lines.length < cursor) cursor = 0; // rotation / truncation
  const fresh = lines.slice(cursor);
  cursors.set(file, lines.length);
  if (fresh.length === 0) return 0;

  let reported = 0;
  for (const line of fresh) {
    let env: RawEnvelope;
    try {
      env = JSON.parse(line) as RawEnvelope;
    } catch {
      continue;
    }
    const severity = SEVERITY_MAP[String(env.severity ?? 'info').toLowerCase()] ?? 'low';
    const source = SOURCE_MAP[String(env.source ?? 'system').toLowerCase()] ?? 'system';
    try {
      await reportIncident({
        source,
        kind: (env.kind ?? 'security-alert').slice(0, 120),
        severity,
        detail: String(env.detail ?? '').slice(0, 4000),
        dedupKey: typeof env.dedupKey === 'string' && env.dedupKey ? env.dedupKey.slice(0, 200) : undefined,
      });
      reported += 1;
    } catch {
      /* a single bad envelope must not stop the batch */
    }
  }
  return reported;
}

async function tick(): Promise<number> {
  let reported = 0;
  for (const file of pollFiles()) reported += await processFile(file);
  return reported;
}

/** Start the security-alert bridge. Returns a stop function. */
export function startAlertEngine(intervalMs = Number(process.env.OPENHUB_ALERTS_INTERVAL_MS || 120_000)): () => void {
  if (process.env.OPENHUB_ALERTS === '0') {
    console.log('[alertEngine] disabled (OPENHUB_ALERTS=0)');
    return () => {};
  }
  let running = false;
  const run = () => {
    if (running) return; // single-flight
    running = true;
    tick()
      .catch((err) => console.warn('[alertEngine] tick failed:', err instanceof Error ? err.message : err))
      .finally(() => { running = false; });
  };
  const timer = setInterval(run, Math.max(30_000, intervalMs));
  if (typeof timer.unref === 'function') timer.unref();
  run();
  console.log(`[alertEngine] bridging Draymond + Keywire security alerts every ${Math.max(30_000, intervalMs)}ms`);
  return () => clearInterval(timer);
}
