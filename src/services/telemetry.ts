import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

/**
 * Unified telemetry — one append-only event stream across every system OpenHub
 * drives (Axiom loops, Game Maker/Godot actions, audits, repairs, incidents,
 * Recourse bridge calls). This is the substrate the trends/insights engine and
 * Recourse's memory write-back read from.
 *
 * Deliberately file-based JSONL (like ecosystemMemory) so it is dependency-free
 * and survives restarts; a corrupt or absent dir degrades to explicit no-ops,
 * never a fabricated event. The file rotates once at a size cap so it cannot
 * grow without bound.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAX_FILE_BYTES = Number(process.env.OPENHUB_TELEMETRY_MAX_BYTES) || 5 * 1024 * 1024;

export type TelemetrySeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface TelemetryEvent {
  id: string;
  at: string;
  /** Emitting system, e.g. `axiom`, `gamemaker`, `supervisor`, `incidents`, `recourse`. */
  system: string;
  /** Event kind, e.g. `loop-start`, `godot-gate`, `audit`, `repair`, `capability`. */
  kind: string;
  severity?: TelemetrySeverity;
  outcome?: string;
  correlationId?: string;
  goal?: string;
  targetDir?: string;
  durationMs?: number;
  data?: Record<string, unknown>;
}

export type TelemetryInput = Omit<TelemetryEvent, 'id' | 'at'> & Partial<Pick<TelemetryEvent, 'id' | 'at'>>;

export interface TelemetrySummary {
  total: number;
  bySystem: Record<string, number>;
  byKind: Record<string, number>;
  byOutcome: Record<string, number>;
  bySeverity: Record<string, number>;
  /** accepted / (accepted + rejected) over the window; null when no verdicts. */
  passRate: number | null;
  windowMs: number;
  since: string;
}

function telemetryDir(): string {
  return process.env.OPENHUB_TELEMETRY_DIR
    ? path.resolve(process.env.OPENHUB_TELEMETRY_DIR)
    : path.resolve(__dirname, '..', '..', 'data', 'telemetry');
}

function eventsFile(): string {
  return path.join(telemetryDir(), 'events.jsonl');
}

function rotatedFile(): string {
  return path.join(telemetryDir(), 'events.1.jsonl');
}

function rotateIfNeeded(): void {
  try {
    const file = eventsFile();
    const stat = fs.statSync(file);
    if (stat.size < MAX_FILE_BYTES) return;
    const rotated = rotatedFile();
    try {
      fs.rmSync(rotated, { force: true });
    } catch {
      /* best-effort */
    }
    fs.renameSync(file, rotated);
  } catch {
    /* absent file — nothing to rotate */
  }
}

/** Append one event. Never throws; reports `{ wrote:false, error }` honestly. */
export function recordEvent(input: TelemetryInput): { wrote: boolean; id?: string; file?: string; error?: string } {
  if (!input || typeof input.system !== 'string' || typeof input.kind !== 'string' || !input.system || !input.kind) {
    return { wrote: false, error: 'telemetry event requires system and kind' };
  }
  try {
    const dir = telemetryDir();
    fs.mkdirSync(dir, { recursive: true });
    rotateIfNeeded();
    const event: TelemetryEvent = {
      id: input.id ?? crypto.randomUUID(),
      at: input.at ?? new Date().toISOString(),
      system: input.system,
      kind: input.kind,
      ...(input.severity ? { severity: input.severity } : {}),
      ...(input.outcome ? { outcome: input.outcome } : {}),
      ...(input.correlationId ? { correlationId: input.correlationId } : {}),
      ...(input.goal ? { goal: String(input.goal).slice(0, 500) } : {}),
      ...(input.targetDir ? { targetDir: String(input.targetDir) } : {}),
      ...(typeof input.durationMs === 'number' && Number.isFinite(input.durationMs) ? { durationMs: input.durationMs } : {}),
      ...(input.data && typeof input.data === 'object' ? { data: input.data } : {}),
    };
    fs.appendFileSync(eventsFile(), `${JSON.stringify(event)}\n`, 'utf8');
    return { wrote: true, id: event.id, file: eventsFile() };
  } catch (err) {
    return { wrote: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function readFile(file: string): TelemetryEvent[] {
  let raw = '';
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: TelemetryEvent[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as TelemetryEvent;
      if (parsed && typeof parsed === 'object' && typeof parsed.system === 'string' && typeof parsed.kind === 'string') {
        out.push(parsed);
      }
    } catch {
      /* skip corrupt line, keep the rest of the stream */
    }
  }
  return out;
}

export interface TelemetryQuery {
  limit?: number;
  system?: string;
  kind?: string;
  severity?: string;
  correlationId?: string;
  sinceMs?: number;
}

/** Read events (newest first) with optional filters. */
export function listEvents(query: TelemetryQuery = {}): TelemetryEvent[] {
  const events = [...readFile(rotatedFile()), ...readFile(eventsFile())];
  const cutoff = query.sinceMs && query.sinceMs > 0 ? Date.now() - query.sinceMs : null;
  let filtered = events;
  if (query.system) filtered = filtered.filter((e) => e.system === query.system);
  if (query.kind) filtered = filtered.filter((e) => e.kind === query.kind);
  if (query.severity) filtered = filtered.filter((e) => e.severity === query.severity);
  if (query.correlationId) filtered = filtered.filter((e) => e.correlationId === query.correlationId);
  if (cutoff !== null) {
    filtered = filtered.filter((e) => {
      const t = Date.parse(e.at);
      return Number.isFinite(t) && t >= cutoff;
    });
  }
  filtered.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const limit = typeof query.limit === 'number' && query.limit >= 0 ? query.limit : 200;
  return filtered.slice(0, limit);
}

/** Deterministic roll-up over a time window; the input to trends/insights. */
export function summarizeEvents(opts: { sinceMs?: number; limit?: number } = {}): TelemetrySummary {
  const windowMs = opts.sinceMs && opts.sinceMs > 0 ? opts.sinceMs : 7 * 24 * 60 * 60 * 1000;
  const events = listEvents({ sinceMs: windowMs, limit: opts.limit ?? 5000 });
  const bySystem: Record<string, number> = {};
  const byKind: Record<string, number> = {};
  const byOutcome: Record<string, number> = {};
  const bySeverity: Record<string, number> = {};
  for (const e of events) {
    bySystem[e.system] = (bySystem[e.system] ?? 0) + 1;
    byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
    if (e.outcome) byOutcome[e.outcome] = (byOutcome[e.outcome] ?? 0) + 1;
    if (e.severity) bySeverity[e.severity] = (bySeverity[e.severity] ?? 0) + 1;
  }
  const accepted = byOutcome.accepted ?? 0;
  const rejected = byOutcome.rejected ?? 0;
  const verdicts = accepted + rejected;
  return {
    total: events.length,
    bySystem,
    byKind,
    byOutcome,
    bySeverity,
    passRate: verdicts > 0 ? accepted / verdicts : null,
    windowMs,
    since: new Date(Date.now() - windowMs).toISOString(),
  };
}

export { MAX_FILE_BYTES };
