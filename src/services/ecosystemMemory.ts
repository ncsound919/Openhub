import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

/**
 * OpenHub → fleet dual-write memory (`.draymond` brain state).
 *
 * Pipeline completions and audit events APPEND (never overwrite) to the fleet's
 * `learning-lessons.json` and `recaps.json` so Draymond agents that read brain
 * state can see OpenHub/Axiom work (per MEMORY.md).
 *
 * Directory resolution, in order:
 *   1. env OPENHUB_DRAYMOND_DIR (explicit override)
 *   2. env OPENHUB_ECOSYSTEM_ROOT/Draymond-Orchestrator/.draymond
 *
 * There is no hardcoded machine path: writes are explicit configuration only.
 * An explicitly configured entry that cannot be used fails loudly instead of
 * silently redirecting writes to a different fleet brain. When no directory can
 * be found, writers return `{ wrote: false, file: null, error }` — they never
 * throw and never create directories.
 */

/** Fleet brain files OpenHub may append to (a subset of the MEMORY.md protocol). */
const BRAIN_LESSONS_FILE = 'learning-lessons.json';
const BRAIN_RECAPS_FILE = 'recaps.json';

/** Guard: never read/rewrite a brain file that has already grown past 10 MB. */
export const MAX_BRAIN_FILE_BYTES = 10 * 1024 * 1024;

export interface MemoryWriteResult {
  wrote: boolean;
  file: string | null;
  error?: string;
}

export interface PipelineRunInput {
  id: string;
  repoId?: string;
  status?: string;
  duration?: string;
  pillar?: string;
}

export interface PipelineLessonRecord {
  id: string;
  agentId: 'openhub';
  pattern: string;
  lesson: string;
  evidenceCount: number;
  lastSeen: string;
  source: 'pipeline';
  repoId?: string;
  pillar?: string;
}

export interface AuditEventInput {
  userId: string;
  action: string;
  details?: string;
  repoId?: string;
}

export interface AuditEventRecord {
  id: string;
  agentId: 'openhub';
  action: string;
  details?: string;
  repoId?: string;
  userId: string;
  createdAt: string;
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Resolve the `.draymond` directory to append fleet memory to, or null when the
 * operator has not provided (or points at) a usable directory. An env-configured
 * path that does not exist yields null — writes never silently fall through to a
 * different fleet brain than the one the operator configured.
 */
export function resolveDraymondDir(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.OPENHUB_DRAYMOND_DIR) {
    return isDirectory(env.OPENHUB_DRAYMOND_DIR) ? env.OPENHUB_DRAYMOND_DIR : null;
  }
  if (env.OPENHUB_ECOSYSTEM_ROOT) {
    const candidate = path.join(env.OPENHUB_ECOSYSTEM_ROOT, 'Draymond-Orchestrator', '.draymond');
    if (isDirectory(candidate)) return candidate;
  }
  // Canonical workspace fallback: UPLIFT_ROOT/Draymond-Orchestrator/.draymond.
  const up = env.UPLIFT_ROOT;
  if (up) {
    const candidate = path.join(up, 'Draymond-Orchestrator', '.draymond');
    if (isDirectory(candidate)) return candidate;
  }
  return null;
}

/**
 * Append-only write core: read the existing array (or an object-wrapped array,
 * e.g. `{"lessons":[...]}` — the real fleet format), push the new record, and
 * write the file back. Missing files are created (bare array, or object-wrapped
 * when `wrapperKey` is given); corrupt JSON recovers as a fresh empty container;
 * valid JSON that is neither a plain array nor a wrapper-object array is refused
 * rather than overwritten; oversized files are skipped, never truncated.
 */
function appendRecord<T extends object>(
  dir: string,
  fileName: string,
  record: T,
  wrapperKey?: string,
): MemoryWriteResult {
  const file = path.join(dir, fileName);
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > MAX_BRAIN_FILE_BYTES) {
      // Explicit size guard: skip the write — no truncation, no rewrite.
      return { wrote: false, file, error: 'file too large' };
    }

    let value: unknown = null;
    if (fs.existsSync(file)) {
      let raw: string;
      try {
        raw = fs.readFileSync(file, 'utf-8');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { wrote: false, file, error: `cannot read ${fileName}: ${message}` };
      }
      try {
        value = JSON.parse(raw) as unknown;
      } catch {
        value = null; // corrupt content → recover with a fresh container
      }
    }

    let container: unknown[] | Record<string, unknown[]>;
    if (value === null || value === undefined) {
      container = wrapperKey ? { [wrapperKey]: [] as unknown[] } : [];
    } else if (Array.isArray(value)) {
      container = value as unknown[];
    } else if (
      wrapperKey &&
      typeof value === 'object' &&
      Array.isArray((value as Record<string, unknown>)[wrapperKey])
    ) {
      // Real fleet format: learning-lessons.json is "{"lessons":[...]}" etc.
      container = value as Record<string, unknown[]>;
    } else {
      return {
        wrote: false,
        file,
        error: `${fileName} is neither a JSON array${wrapperKey ? ` nor a {"${wrapperKey}": [...]} object` : ''}; refusing to overwrite it (append-only)`,
      };
    }

    if (Array.isArray(container)) {
      container.push(record);
    } else {
      container[wrapperKey!].push(record);
    }
    fs.writeFileSync(file, JSON.stringify(container, null, 2), 'utf-8');
    return { wrote: true, file };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { wrote: false, file, error: message };
  }
}

/**
 * Append a lesson record to `.draymond/learning-lessons.json` after a pipeline
 * run. Returns `{ wrote: false, file: null, error }` (no throw) when no
 * `.draymond` directory can be resolved.
 */
export function recordPipelineLesson(
  run: PipelineRunInput,
  env: NodeJS.ProcessEnv = process.env,
): MemoryWriteResult {
  const dir = resolveDraymondDir(env);
  if (!dir) {
    return {
      wrote: false,
      file: null,
      error: 'no .draymond directory found (set OPENHUB_DRAYMOND_DIR or OPENHUB_ECOSYSTEM_ROOT)',
    };
  }
  const status = run.status ?? 'unknown';
  const record: PipelineLessonRecord = {
    id: `lesson-${randomUUID()}`,
    agentId: 'openhub',
    pattern: `pipeline.${status}`,
    lesson: `Pipeline ${run.id} finished ${status}`,
    evidenceCount: 1,
    lastSeen: new Date().toISOString(),
    source: 'pipeline',
    repoId: run.repoId,
    pillar: run.pillar,
  };
  return appendRecord(dir, BRAIN_LESSONS_FILE, record, 'lessons');
}

/**
 * Append an audit recap to `.draymond/recaps.json`. Returns
 * `{ wrote: false, file: null, error }` (no throw) when no `.draymond`
 * directory can be resolved.
 */
export function recordAuditEvent(
  entry: AuditEventInput,
  env: NodeJS.ProcessEnv = process.env,
): MemoryWriteResult {
  const dir = resolveDraymondDir(env);
  if (!dir) {
    return {
      wrote: false,
      file: null,
      error: 'no .draymond directory found (set OPENHUB_DRAYMOND_DIR or OPENHUB_ECOSYSTEM_ROOT)',
    };
  }
  const record: AuditEventRecord = {
    id: `recap-${randomUUID()}`,
    agentId: 'openhub',
    action: entry.action,
    details: entry.details,
    repoId: entry.repoId,
    userId: entry.userId,
    createdAt: new Date().toISOString(),
  };
  return appendRecord(dir, BRAIN_RECAPS_FILE, record, 'recaps');
}