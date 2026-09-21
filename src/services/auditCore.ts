/**
 * Audit-core service — the single entry point that makes the shared core usable
 * by every consumer. OpenHub's audit suite (which already ingests The Deep,
 * RepoRank, CodeNexus and local analyzers) calls runAuditCore() to validate,
 * lifecycle and gate a set of findings; RepoRank/CodeNexus/The Deep can call the
 * same function over HTTP/MCP with their own findings.
 *
 * Deterministic and synchronous for the validate/lifecycle/gate stages; the
 * rules stage is async and needs an injected model completer.
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadAuditConfig, type AuditConfigResult } from '../core/config.js';
import { evaluateRules, type RuleCompleter, type RuleEvalFile } from '../core/rules.js';
import { reconcileLifecycle, gateDecision, type FindingTransition, type GateResult, type LifecycleRecord } from '../core/lifecycle.js';
import { validateFinding, type Reachability, type ValidationContext, type ValidationVerdict } from '../core/validator.js';
import type { Finding } from './findings.js';

const CORE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java', '.rb',
  '.php', '.cs', '.kt', '.swift', '.c', '.h', '.cpp', '.hpp', '.cc', '.sol', '.vue', '.svelte',
]);
const CORE_SKIP_DIRS = new Set([
  'node_modules', 'dist', 'build', '.git', 'coverage', '.next', '.turbo', 'vendor',
  '__pycache__', '.venv', 'venv', 'target', '.godot', 'out', '.cache', '.pnpm',
]);
const CORE_MAX_FILES = 800;
const CORE_MAX_FILE_BYTES = 512 * 1024;

/** Walk a repo and return source files (repo-relative path → content), bounded. */
export function collectCoreFiles(rootDir: string, opts: { maxFiles?: number; maxFileBytes?: number } = {}): RuleEvalFile[] {
  const maxFiles = opts.maxFiles ?? CORE_MAX_FILES;
  const maxFileBytes = opts.maxFileBytes ?? CORE_MAX_FILE_BYTES;
  const out: RuleEvalFile[] = [];
  const walk = (dir: string, depth: number): void => {
    if (out.length >= maxFiles || depth > 20) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= maxFiles) return;
      if (entry.name.startsWith('.') && entry.isDirectory()) continue;
      if (entry.isDirectory()) {
        if (CORE_SKIP_DIRS.has(entry.name)) continue;
        walk(path.join(dir, entry.name), depth + 1);
      } else if (entry.isFile()) {
        if (!CORE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
        const abs = path.join(dir, entry.name);
        try {
          if (fs.statSync(abs).size > maxFileBytes) continue;
          const content = fs.readFileSync(abs, 'utf-8');
          out.push({ file: path.relative(rootDir, abs).replace(/\\/g, '/'), content });
        } catch {
          /* unreadable file — skip honestly */
        }
      }
    }
  };
  walk(rootDir, 0);
  return out;
}

/** Direct dependency names declared in package.json (for CVE reachability). */
export function readManifestDependencies(rootDir: string): Set<string> {
  const deps = new Set<string>();
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf-8')) as Record<string, unknown>;
    for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      const table = manifest[section];
      if (table && typeof table === 'object') for (const key of Object.keys(table)) deps.add(key);
    }
  } catch {
    /* no/invalid package.json — empty set */
  }
  return deps;
}

export function coreStateDir(rootDir: string, env: NodeJS.ProcessEnv = process.env): string {
  return env.OPENHUB_CORE_STATE_DIR || path.join(rootDir, '.openhub');
}

const LIFECYCLE_FILE = 'audit-lifecycle.json';

/** Persisted lifecycle records for a repo (empty when none/first run). */
export function loadLifecycle(rootDir: string, env: NodeJS.ProcessEnv = process.env): LifecycleRecord[] {
  try {
    const p = path.join(coreStateDir(rootDir, env), LIFECYCLE_FILE);
    if (!fs.existsSync(p)) return [];
    const parsed = JSON.parse(fs.readFileSync(p, 'utf-8')) as { records?: unknown };
    return Array.isArray(parsed?.records) ? (parsed.records as LifecycleRecord[]) : [];
  } catch {
    return [];
  }
}

export function saveLifecycle(rootDir: string, records: readonly LifecycleRecord[], env: NodeJS.ProcessEnv = process.env): void {
  const dir = coreStateDir(rootDir, env);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, LIFECYCLE_FILE), `${JSON.stringify({ records }, null, 2)}\n`, 'utf-8');
}

export interface AuditCoreGateSummary {
  passed: boolean;
  /** False when the gate did not evaluate findings (diff cap / always-pass /
   *  ignored label) — `passed` is then not a verdict on the diff. */
  evaluated: boolean;
  reason: string;
  considered: number;
  failing: Array<{ fingerprint: string; severity: string; file?: string; line?: number; transition: FindingTransition }>;
}

/** JSON-serializable summary of a core run (Maps/records flattened for transport). */
export interface AuditCoreResult {
  configSource: string | null;
  configErrors: string[];
  configWarnings: string[];
  validation: {
    confirmed: number;
    unconfirmed: number;
    stale: number;
    notApplicable: number;
    droppedStale: number;
    items: Array<{
      fingerprint: string;
      verdict: ValidationVerdict;
      confidence: number;
      rationale: string;
      reachability?: Reachability;
      fixEffort: number;
      file?: string;
      line?: number;
    }>;
  };
  lifecycle: {
    created: number;
    persisting: number;
    reopened: number;
    resolvedNow: number;
    suppressed: number;
    records: LifecycleRecord[];
  };
  gate: AuditCoreGateSummary;
}

export interface AuditCoreRunParams {
  rootDir: string;
  findings: readonly Finding[];
  changedLines?: number;
  labels?: readonly string[];
  now?: string;
  /** Persist the reconciled lifecycle (default true). */
  persist?: boolean;
  /** Pre-loaded records; otherwise read from disk. */
  previous?: readonly LifecycleRecord[];
  /** Pre-collected files; otherwise the repo is walked. */
  files?: readonly RuleEvalFile[];
  env?: NodeJS.ProcessEnv;
}

function summarizeGate(gate: GateResult): AuditCoreGateSummary {
  return {
    passed: gate.passed,
    evaluated: gate.evaluated,
    reason: gate.reason,
    considered: gate.considered,
    failing: gate.failing.map((f) => ({
      fingerprint: f.record.fingerprint,
      severity: f.record.severity,
      ...(f.record.file ? { file: f.record.file } : {}),
      ...(typeof f.record.line === 'number' ? { line: f.record.line } : {}),
      transition: f.transition,
    })),
  };
}

/**
 * Validate → lifecycle → gate a set of findings for a repo. Deterministic;
 * never throws (a failure to persist is swallowed so an audit cannot be lost to
 * a state-dir permission error).
 */
export function runAuditCore(params: AuditCoreRunParams): AuditCoreResult {
  const env = params.env ?? process.env;
  const configResult: AuditConfigResult = loadAuditConfig(params.rootDir);
  const files = params.files ?? collectCoreFiles(params.rootDir);
  const ctx: ValidationContext = {
    files: new Map(files.map((f) => [f.file, f.content])),
    directDependencies: readManifestDependencies(params.rootDir),
  };

  const perFinding = params.findings.map((finding) => ({ finding, v: validateFinding(finding, ctx) }));
  const kept = perFinding.filter((x) => x.v.verdict !== 'stale').map((x) => x.finding);
  const droppedStale = perFinding.length - kept.length;

  const previous = params.previous ?? loadLifecycle(params.rootDir, env);
  const lifecycle = reconcileLifecycle(previous, kept, params.now);
  if (params.persist !== false) {
    try {
      saveLifecycle(params.rootDir, lifecycle.records, env);
    } catch {
      /* persistence is best-effort; the result is still returned */
    }
  }
  const gate = gateDecision(lifecycle, configResult.config.gate, {
    ...(params.changedLines !== undefined ? { changedLines: params.changedLines } : {}),
    ...(params.labels ? { labels: params.labels } : {}),
  });

  const counts = { confirmed: 0, unconfirmed: 0, stale: 0, not_applicable: 0 } as Record<ValidationVerdict, number>;
  const items: AuditCoreResult['validation']['items'] = [];
  for (const { finding, v } of perFinding) {
    counts[v.verdict] += 1;
    items.push({
      fingerprint: v.fingerprint,
      verdict: v.verdict,
      confidence: v.confidence,
      rationale: v.rationale,
      ...(v.reachability ? { reachability: v.reachability } : {}),
      fixEffort: v.fixEffort,
      ...(finding.location?.file ? { file: finding.location.file } : {}),
      ...(typeof finding.location?.line === 'number' ? { line: finding.location.line } : {}),
    });
  }

  let created = 0;
  let persisting = 0;
  let reopened = 0;
  for (const transition of lifecycle.transitions.values()) {
    if (transition === 'new') created += 1;
    else if (transition === 'persisting') persisting += 1;
    else if (transition === 'reopened') reopened += 1;
  }

  return {
    configSource: configResult.source,
    configErrors: configResult.errors,
    configWarnings: configResult.warnings,
    validation: {
      confirmed: counts.confirmed,
      unconfirmed: counts.unconfirmed,
      stale: counts.stale,
      notApplicable: counts.not_applicable,
      droppedStale,
      items,
    },
    lifecycle: {
      created,
      persisting,
      reopened,
      resolvedNow: lifecycle.resolvedNow.length,
      suppressed: lifecycle.suppressed.length,
      records: lifecycle.records,
    },
    gate: summarizeGate(gate),
  };
}

export interface RulesRunResult {
  findings: Finding[];
  evaluated: string[];
  skipped: Array<{ rule: string; reason: string }>;
  errors: string[];
  promptChars: number;
  configSource: string | null;
}

/** Evaluate repo rules (plain-English) against a target dir with a completer. */
export async function runRulesForRepo(
  rootDir: string,
  complete: RuleCompleter,
  opts: { files?: readonly RuleEvalFile[]; maxPromptChars?: number } = {},
): Promise<RulesRunResult> {
  const configResult = loadAuditConfig(rootDir);
  const files = opts.files ?? collectCoreFiles(rootDir);
  const r = await evaluateRules(
    configResult.config,
    files,
    rootDir,
    complete,
    opts.maxPromptChars !== undefined ? { maxPromptChars: opts.maxPromptChars } : {},
  );
  return {
    findings: r.findings,
    evaluated: r.rulesEvaluated,
    skipped: r.rulesSkipped,
    errors: r.errors,
    promptChars: r.promptChars,
    configSource: configResult.source,
  };
}

/** A provider-agnostic system+user text completion. */
export type TextCompleter = (system: string, prompt: string) => Promise<string>;

/**
 * Build an OpenAI-compatible completer from env, or null when unconfigured.
 * Reads OPENHUB_LLM_BASE_URL / _MODEL / _KEY (falling back to AXIOM_*).
 */
export function makeTextCompleter(env: NodeJS.ProcessEnv = process.env): TextCompleter | null {
  const base = env.OPENHUB_LLM_BASE_URL || env.AXIOM_LLM_BASE_URL || '';
  const model = env.OPENHUB_LLM_MODEL || env.AXIOM_LLM_MODEL || '';
  if (!base || !model) return null;
  const key = env.OPENHUB_LLM_KEY || env.AXIOM_LLM_KEY || '';
  const endpoint = `${base.replace(/\/+$/, '')}/chat/completions`;
  return async (system, prompt) => {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ model, temperature: 0, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
    return String(json?.choices?.[0]?.message?.content ?? '');
  };
}

/** Rule-shaped completer adapter over makeTextCompleter. */
export function makeCoreCompleter(env: NodeJS.ProcessEnv = process.env): RuleCompleter | null {
  const text = makeTextCompleter(env);
  if (!text) return null;
  return ({ system, prompt }) => text(system, prompt);
}
