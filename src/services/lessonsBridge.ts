/**
 * lessonsBridge — route the Coding-lessons corpus into the audit core.
 *
 * WHY THIS EXISTS
 * The corpus (`Coding lessons/`) records ~150 falsifiable findings with
 * `file:line`, severity, confidence and a resolution status, plus a converter
 * (`lessons-to-openhub.mjs`) that emits them in OpenHub's shared finding shape.
 * Nothing automated called that converter, so every audit re-derived the same
 * defect shapes from scratch and knew nothing about the recorded history. This
 * loads the converter's output and hands it to `runAuditCore`, so a repo audit
 * surfaces what is already known about the files it is about to judge.
 *
 * TWO THINGS THIS DELIBERATELY DOES NOT DO
 *
 * 1. It does not trust OpenHub's own reachability verdict for the corpus's
 *    citations. `validateFinding` decides staleness by looking the path up in
 *    the walk built by `collectCoreFiles`, which is capped at 800 files and, on
 *    a large or documentation-heavy repo, reports a real file `stale` and then
 *    drops it (see 2026-10-04-openhub-fingerprint-collides-on-source F2/F7).
 *    This module checks each cited path against the filesystem directly, exactly
 *    as `lessons-to-openhub.mjs --verify` does, and reports unverifiable
 *    citations as a named list rather than letting them vanish.
 *
 * 2. It does not silently succeed when the corpus cannot be read. An enabled
 *    bridge with no directory, no converter, or a converter that errors returns
 *    `ran: false` with a reason. A skipped check and a clean check produce
 *    identical empty output otherwise, which is the exact failure this folder
 *    exists to prevent.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import type { Finding } from './findings.js';
import { findingId } from './findings.js';
import type { AuditLessonsConfig } from '../core/config.js';

export interface ResolvedLessons {
  enabled: boolean;
  dir: string | null;
  script: string | null;
  /** The `repo_path` whose entries apply. Defaults to the audited root. */
  repoPath: string;
  /** Why the corpus is unavailable, when `enabled` is true but nothing can run. */
  reason?: string;
}

export interface StaleCitation {
  file: string;
  line?: number;
  reason: string;
  /** Lesson ids (`category: lesson/<id>`) that cite this path. */
  lessons: string[];
}

export interface LessonsLoadResult {
  enabled: boolean;
  ran: boolean;
  dir: string | null;
  script: string | null;
  /** Findings to merge into the core run (citations verified to resolve). */
  findings: Finding[];
  /** Citations whose path/line does not exist in the target tree. Reported, never merged. */
  stale: StaleCitation[];
  /** Total findings the converter emitted, before citation filtering. */
  emitted: number;
  error?: string;
  reason?: string;
}

/** Injectable for tests; the default spawns the converter with the host node. */
export type LessonsRunner = (
  script: string,
  args: string[],
  opts: { cwd: string; timeout: number },
) => Promise<{ stdout: string; stderr: string; ok: boolean; error?: string }>;

/** A compact, transport-safe view of a lessons load for a tool summary. */
export interface LessonsSummary {
  enabled: boolean;
  ran: boolean;
  routed: number;
  emitted: number;
  staleCitations: number;
  stale: StaleCitation[];
  dir: string | null;
  script: string | null;
  reason?: string;
  error?: string;
}

export function summarizeLessons(l: LessonsLoadResult, staleLimit = 25): LessonsSummary {
  return {
    enabled: l.enabled,
    ran: l.ran,
    routed: l.findings.length,
    emitted: l.emitted,
    staleCitations: l.stale.length,
    stale: l.stale.slice(0, staleLimit),
    dir: l.dir,
    script: l.script,
    ...(l.reason ? { reason: l.reason } : {}),
    ...(l.error ? { error: l.error } : {}),
  };
}


const CONVERTER = 'lessons-to-openhub.mjs';
export const DEFAULT_LESSONS_TIMEOUT_MS = 30_000;

function defaultRunner(script: string, args: string[], opts: { cwd: string; timeout: number }) {
  return new Promise<{ stdout: string; stderr: string; ok: boolean; error?: string }>((resolve) => {
    execFile(
      process.execPath,
      [script, ...args],
      { cwd: opts.cwd, timeout: opts.timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        const out = String(stdout ?? '');
        const errOut = String(stderr ?? '');
        if (err) resolve({ stdout: out, stderr: errOut, ok: false, error: err.message });
        else resolve({ stdout: out, stderr: errOut, ok: true });
      },
    );
  });
}

/**
 * Resolve the effective bridge configuration. `config` comes from `openhub.yaml`;
 * the environment is the fallback so a fleet can point every repo at one corpus
 * without editing each config file. An explicit `enabled: false` wins over env.
 */
export function resolveLessonsConfig(
  rootDir: string,
  config: AuditLessonsConfig | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedLessons {
  const envDisabled = /^(0|false|no|off)$/i.test(String(env.OPENHUB_LESSONS ?? ''));
  const enabled = envDisabled ? false : config?.enabled !== false;

  const repoPath = (config?.repoPath || env.OPENHUB_LESSONS_REPO || '').trim() || rootDir;
  const dirRaw = (config?.dir || env.OPENHUB_LESSONS_DIR || env.LESSONS_DIR || '').trim();

  if (!enabled) return { enabled: false, dir: null, script: null, repoPath };

  if (!dirRaw) {
    return {
      enabled: true,
      dir: null,
      script: null,
      repoPath,
      reason: 'no lessons dir configured (set lessons.dir in openhub.yaml or OPENHUB_LESSONS_DIR)',
    };
  }

  const dir = path.isAbsolute(dirRaw) ? dirRaw : path.resolve(rootDir, dirRaw);
  const script = path.join(dir, CONVERTER);
  if (!fs.existsSync(script)) {
    return { enabled: true, dir, script: null, repoPath, reason: `converter not found: ${script}` };
  }
  return { enabled: true, dir, script, repoPath };
}

/** Parse the converter's `--json` output into findings, guaranteeing an identity. */
export function parseLessonsFindings(stdout: string): Finding[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    throw new Error(`converter output is not JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed)) throw new Error('converter output is not a findings array');
  return parsed.map((raw) => {
    const f = asFinding(raw);
    // The converter sets `identity`; if an older copy is on disk it will not, and
    // two lessons touching one file would then collide on dedupKey. Synthesize a
    // stable one from the fields that exist so the routing is never silently lossy.
    if (!f.identity) {
      const line = f.location?.line ?? '';
      f.identity = `lessons|${f.category}|${f.location?.file ?? ''}|${line}`;
    }
    // The converter does not emit a per-tool `id`; derive it the same way
    // `createFinding` would, so a downstream consumer that reads `finding.id`
    // (instead of the fingerprint) gets a real value rather than an empty string.
    f.id = findingId(f);
    return f;
  });
}

function asFinding(raw: unknown): Finding {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const loc = o.location && typeof o.location === 'object' ? (o.location as Record<string, unknown>) : undefined;
  const finding: Finding = {
    id: String(o.id ?? ''),
    source: String(o.source ?? 'lessons'),
    dimension: (o.dimension as Finding['dimension']) ?? 'correctness',
    category: String(o.category ?? 'lesson'),
    severity: (o.severity as Finding['severity']) ?? 'info',
    confidence: typeof o.confidence === 'number' ? o.confidence : 0.5,
    determinism: (o.determinism as Finding['determinism']) ?? 'heuristic',
    locatable: o.locatable !== false,
  };
  if (typeof o.identity === 'string' && o.identity) finding.identity = o.identity;
  if (loc && typeof loc.file === 'string') {
    finding.location = { file: loc.file, ...(typeof loc.line === 'number' ? { line: loc.line } : {}) };
  }
  if (typeof o.evidence === 'string') finding.evidence = o.evidence;
  if (typeof o.remediation === 'string') finding.remediation = o.remediation;
  return finding;
}

/**
 * Check each finding's citation against the target tree. A finding with no
 * location is routeable (nothing to verify); a finding whose file is absent, or
 * whose line is past the end of the file, is reported stale and NOT routed.
 */
export function verifyCitations(
  findings: readonly Finding[],
  rootDir: string,
): { routeable: Finding[]; stale: StaleCitation[] } {
  const routeable: Finding[] = [];
  const stale: StaleCitation[] = [];
  const lineCounts = new Map<string, number>();

  for (const f of findings) {
    const file = f.location?.file;
    if (!file) {
      routeable.push(f);
      continue;
    }
    const abs = path.resolve(rootDir, file);
    let exists = false;
    try {
      exists = fs.statSync(abs).isFile();
    } catch {
      exists = false;
    }
    if (!exists) {
      stale.push({ file, ...(f.location?.line !== undefined ? { line: f.location.line } : {}), reason: 'file absent in target tree', lessons: [f.category] });
      continue;
    }
    if (typeof f.location?.line === 'number') {
      let n = lineCounts.get(abs);
      if (n === undefined) {
        try {
          n = fs.readFileSync(abs, 'utf-8').split(/\r?\n/).length;
        } catch {
          n = 0;
        }
        lineCounts.set(abs, n);
      }
      if (n > 0 && f.location.line > n) {
        stale.push({ file, line: f.location.line, reason: `line ${f.location.line} > ${n}`, lessons: [f.category] });
        continue;
      }
    }
    routeable.push(f);
  }
  return { routeable, stale };
}

/**
 * Load, verify and return the corpus findings for one repo. Never throws: a
 * failure is returned as `ran: false` with an `error`, so the audit can report
 * "the lessons bridge did not run" instead of an empty success.
 */
export async function loadLessonsFindings(
  resolved: ResolvedLessons,
  targetDir: string,
  opts: { runner?: LessonsRunner; timeoutMs?: number } = {},
): Promise<LessonsLoadResult> {
  const base: LessonsLoadResult = {
    enabled: resolved.enabled,
    ran: false,
    dir: resolved.dir,
    script: resolved.script,
    findings: [],
    stale: [],
    emitted: 0,
    ...(resolved.reason ? { reason: resolved.reason } : {}),
  };
  if (!resolved.enabled) return base;
  if (!resolved.script || !resolved.dir) return base;

  const runner = opts.runner ?? defaultRunner;
  const args = ['--json'];
  if (resolved.repoPath) args.push('--repo', resolved.repoPath);

  let result: { stdout: string; stderr: string; ok: boolean; error?: string };
  try {
    result = await runner(resolved.script, args, {
      cwd: resolved.dir,
      timeout: opts.timeoutMs ?? DEFAULT_LESSONS_TIMEOUT_MS,
    });
  } catch (err) {
    return { ...base, error: `converter spawn failed: ${(err as Error).message}` };
  }
  if (!result.ok) {
    return { ...base, error: `converter failed: ${result.error ?? 'unknown error'}${result.stderr ? ` — ${result.stderr.slice(0, 400)}` : ''}` };
  }

  let findings: Finding[];
  try {
    findings = parseLessonsFindings(result.stdout);
  } catch (err) {
    return { ...base, error: (err as Error).message };
  }

  const { routeable, stale } = verifyCitations(findings, targetDir);
  return { ...base, ran: true, emitted: findings.length, findings: routeable, stale };
}
