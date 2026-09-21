import crypto from 'crypto';
import { getDb } from '../auth/db.js';
import { triggerRepairTriage } from './repairClient.js';
import { recordEvent } from './telemetry.js';

/**
 * Incident bus — every failure (Axiom loop, copilot task, MCP/UFC offline,
 * ecosystem/recourse offline, pipeline) is reported here as an incident.
 * High/critical incidents auto-dispatch the repair team; everything else
 * queues visibly. Dispatch is single-flight (one at a time, FIFO) and
 * deduped per key within a window, and can be toggled per severity from the
 * Repair screen (persisted in node_settings) or killed via OPENHUB_AUTODISPATCH=0.
 */

export type IncidentSeverity = 'low' | 'medium' | 'high' | 'critical';
export type IncidentSource = 'axiom' | 'copilot' | 'pipeline' | 'mcp' | 'ecosystem' | 'supervisor' | 'system';

export interface Incident {
  id: string;
  source: IncidentSource;
  kind: string;
  severity: IncidentSeverity;
  detail: string;
  dedupKey: string;
  dispatched: boolean;
  dispatchResult: string | null;
  createdAt: string;
}

export interface DispatchPrefs {
  low: boolean;
  medium: boolean;
  high: boolean;
  critical: boolean;
}

const DEDUP_WINDOW_MS = 15 * 60_000;
const DEFAULT_PREFS: DispatchPrefs = { low: false, medium: false, high: true, critical: true };

let dispatchInFlight = false;
const dispatchQueue: string[] = [];

function ensureTables(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS incidents (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      kind TEXT NOT NULL,
      severity TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      dedup_key TEXT NOT NULL DEFAULT '',
      dispatched INTEGER DEFAULT 0,
      dispatch_result TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS node_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

function killSwitch(): boolean {
  return process.env.OPENHUB_AUTODISPATCH === '0';
}

export function getDispatchPrefs(): DispatchPrefs & { killSwitch: boolean } {
  ensureTables();
  try {
    const rows = getDb().prepare('SELECT key, value FROM node_settings WHERE key LIKE \'autodispatch.%\'').all() as { key: string; value: string }[];
    const prefs = { ...DEFAULT_PREFS };
    for (const r of rows) {
      const sev = r.key.replace('autodispatch.', '') as keyof DispatchPrefs;
      if (sev in prefs) prefs[sev] = r.value === '1';
    }
    return { ...prefs, killSwitch: killSwitch() };
  } catch {
    return { ...DEFAULT_PREFS, killSwitch: killSwitch() };
  }
}

export function setDispatchPrefs(patch: Partial<DispatchPrefs>): DispatchPrefs {
  ensureTables();
  const current = getDispatchPrefs();
  const next: DispatchPrefs = { low: current.low, medium: current.medium, high: current.high, critical: current.critical, ...patch };
  const now = new Date().toISOString();
  const upsert = getDb().prepare('INSERT OR REPLACE INTO node_settings (key, value, updated_at) VALUES (?, ?, ?)');
  for (const k of Object.keys(next) as (keyof DispatchPrefs)[]) {
    upsert.run(`autodispatch.${k}`, next[k] ? '1' : '0', now);
  }
  return next;
}

function rowToIncident(row: any): Incident {
  return {
    id: row.id,
    source: row.source,
    kind: row.kind,
    severity: row.severity,
    detail: row.detail ?? '',
    dedupKey: row.dedup_key ?? '',
    dispatched: !!row.dispatched,
    dispatchResult: row.dispatch_result,
    createdAt: row.created_at,
  };
}

export function listIncidents(limit = 50): Incident[] {
  ensureTables();
  const rows = getDb().prepare('SELECT * FROM incidents ORDER BY created_at DESC LIMIT ?').all(limit);
  return (rows as any[]).map(rowToIncident);
}

/** Queue depth + in-flight flag for the single-flight indicator. */
export function dispatchState(): { inFlight: boolean; queued: number } {
  return { inFlight: dispatchInFlight, queued: dispatchQueue.length };
}

async function pumpQueue(): Promise<void> {
  if (dispatchInFlight) return;
  const id = dispatchQueue.shift();
  if (!id) return;
  dispatchInFlight = true;
  try {
    ensureTables();
    const row = getDb().prepare('SELECT * FROM incidents WHERE id = ?').get(id) as any;
    if (row && !row.dispatched) {
      const outcome = await triggerRepairTriage({
        signal: `openhub:incident:${row.kind}`,
        detail: `[${row.source}/${row.severity}] ${row.detail}`.slice(0, 4000),
        kind: 'job',
      });
      // Only mark dispatched on success so a failed attempt stays retryable.
      getDb().prepare('UPDATE incidents SET dispatched = ?, dispatch_result = ? WHERE id = ?').run(
        outcome?.ok ? 1 : 0,
        outcome?.ok ? 'dispatched' : (outcome?.error ?? 'dispatch failed'),
        id,
      );
    }
  } catch {
    /* dispatch must never crash the bus */
  } finally {
    dispatchInFlight = false;
    if (dispatchQueue.length > 0) void pumpQueue();
  }
}

/**
 * Report an incident. Returns the incident plus whether a dispatch was
 * queued. Dedupe: same dedup_key within the window reuses the open incident.
 */
export async function reportIncident(params: {
  source: IncidentSource;
  kind: string;
  severity: IncidentSeverity;
  detail: string;
  dedupKey?: string;
}): Promise<{ incident: Incident; dispatchQueued: boolean }> {
  ensureTables();
  const now = new Date().toISOString();
  const dedupKey = params.dedupKey ?? `${params.source}:${params.kind}`;
  const cutoff = new Date(Date.now() - DEDUP_WINDOW_MS).toISOString();
  const recent = getDb().prepare(
    'SELECT * FROM incidents WHERE dedup_key = ? AND created_at > ? ORDER BY created_at DESC LIMIT 1',
  ).get(dedupKey, cutoff) as any;
  if (recent) {
    return { incident: rowToIncident(recent), dispatchQueued: false };
  }
  const id = crypto.randomUUID();
  getDb().prepare(
    'INSERT INTO incidents (id, source, kind, severity, detail, dedup_key, dispatched, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)',
  ).run(id, params.source, params.kind, params.severity, params.detail.slice(0, 4000), dedupKey, now);
  const incident = rowToIncident(getDb().prepare('SELECT * FROM incidents WHERE id = ?').get(id));

  // Feed the unified telemetry stream (deduped incidents only appear once).
  recordEvent({
    system: 'incidents',
    kind: params.kind,
    severity: params.severity,
    outcome: 'pending',
    data: { source: params.source, dedupKey },
  });

  let dispatchQueued = false;
  const prefs = getDispatchPrefs();
  if (!prefs.killSwitch && prefs[params.severity]) {
    dispatchQueue.push(id);
    dispatchQueued = true;
    void pumpQueue();
  }
  return { incident, dispatchQueued };
}

export { DEDUP_WINDOW_MS };
