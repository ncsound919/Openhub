/**
 * P2 dimension scorers.
 *
 * Each follows the evidence envelope (score | explicit-uncovered), dedups via
 * the shared Finding model, and honestly reports when its tool is not present
 * instead of fabricating a zero. Some are tool-backed (deps/duplication/
 * licenses/a11y/iac) and some are deterministic static heuristics that always
 * work (perf/API-contract/git-history), so the extra dimensions have real
 * coverage even on a machine with none of the optional CLIs installed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { attach, honest, makeFinding, type ScorerResult } from './evidence.js';
import { collectSourceFiles } from './analyzers.js';
import { runLocalCommand } from './processRunner.js';
import { toolReady, toolReason, type PreflightReport } from './preflight.js';
import type { Finding } from './findings.js';
import type { Dimension } from './dimensions.js';

export interface ExtraScorerContext {
  preflight?: PreflightReport;
  changedFiles?: Set<string>;
}

const JS_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/i;
const PY_EXT = /\.py$/i;

function rel(targetDir: string, abs: string): string {
  return path.relative(targetDir, abs).replace(/\\/g, '/');
}

function readText(file: string, maxBytes = 400_000): string | null {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function parseJson<T = unknown>(text: string | null): T | null {
  if (!text) return null;
  const start = Math.min(
    ...[text.indexOf('{'), text.indexOf('[')].filter((i) => i >= 0),
  );
  if (!Number.isFinite(start) || start < 0) return null;
  try {
    return JSON.parse(text.slice(start)) as T;
  } catch {
    return null;
  }
}

function penaltyScore(penalty: number, cap = 70): number {
  return Math.max(0, Math.round(100 - Math.min(cap, penalty)));
}

// ---------------------------------------------------------------------------
// deps_freshness — npm outdated / pip list --outdated → `dependencies`
// ---------------------------------------------------------------------------

export async function runDepsFreshnessScorer(
  targetDir?: string,
  _ctx?: ExtraScorerContext,
): Promise<ScorerResult> {
  if (!targetDir || !fs.existsSync(targetDir)) {
    return honest('deps_freshness', 'dependency freshness needs an existing targetDir');
  }
  const findings: Finding[] = [];
  const runners: string[] = [];

  if (fs.existsSync(path.join(targetDir, 'package.json'))) {
    const run = await runLocalCommand('npm', ['outdated', '--json'], { cwd: targetDir, timeoutMs: 120_000 });
    const parsed = parseJson<Record<string, { current?: string; latest?: string; wanted?: string }>>(run.output);
    if (parsed) {
      runners.push('npm');
      for (const [name, info] of Object.entries(parsed)) {
        const current = info.current ?? '?';
        const latest = info.latest ?? info.wanted ?? '?';
        const major = String(latest).split('.')[0] !== String(current).split('.')[0];
        findings.push(makeFinding({
          source: 'deps_freshness',
          dimension: 'dependencies',
          category: major ? 'outdated-major' : 'outdated-minor',
          severity: major ? 'medium' : 'low',
          confidence: 0.85,
          determinism: 'static',
          location: { file: 'package.json' },
          evidence: `${name}: ${current} → ${latest}`,
          remediation: `Upgrade ${name} to ${latest}.`,
        }));
      }
    }
  }

  const pythonManifest = ['pyproject.toml', 'requirements.txt', 'setup.py'].some((f) => fs.existsSync(path.join(targetDir, f)));
  if (pythonManifest) {
    const run = await runLocalCommand('pip', ['list', '--outdated', '--format=json'], { cwd: targetDir, timeoutMs: 120_000 });
    const parsed = parseJson<Array<{ name?: string; version?: string; latest_version?: string }>>(run.output);
    if (parsed) {
      runners.push('pip');
      for (const pkg of parsed) {
        const major = String(pkg.latest_version ?? '').split('.')[0] !== String(pkg.version ?? '').split('.')[0];
        findings.push(makeFinding({
          source: 'deps_freshness',
          dimension: 'dependencies',
          category: major ? 'outdated-major' : 'outdated-minor',
          severity: major ? 'medium' : 'low',
          confidence: 0.85,
          determinism: 'static',
          location: { file: 'requirements.txt' },
          evidence: `${pkg.name}: ${pkg.version ?? '?'} → ${pkg.latest_version ?? '?'}`,
          remediation: `Upgrade ${pkg.name} to ${pkg.latest_version ?? 'latest'}.`,
        }));
      }
    }
  }

  if (runners.length === 0) {
    return honest('deps_freshness', 'no package.json or Python manifest, or the package manager could not report outdated deps');
  }
  const penalty = findings.reduce((s, f) => s + (f.severity === 'medium' ? 3 : 1), 0);
  const majors = findings.filter((f) => f.category === 'outdated-major').length;
  return attach({
    scorer: 'deps_freshness',
    score: penaltyScore(penalty, 60),
    summary: `${findings.length} outdated package${findings.length === 1 ? '' : 's'} (${majors} major) via ${runners.join('+')}`,
    details: { outdated: findings.length, majors, runners },
  }, { findings, dimensions: ['dependencies'], analyzers: runners });
}

// ---------------------------------------------------------------------------
// licenses_sbom — license-checker → `licenses`
// ---------------------------------------------------------------------------

const COPYLEFT = /(AGPL|GPL|SSPL|CDDL|EUPL|OSL)/i;

export function parseLicenseChecker(json: unknown): Finding[] {
  if (!json || typeof json !== 'object') return [];
  const findings: Finding[] = [];
  for (const [pkg, info] of Object.entries(json as Record<string, unknown>)) {
    const rec = (info && typeof info === 'object' ? info : {}) as Record<string, unknown>;
    const license = rec.licenses == null ? '' : String(rec.licenses);
    if (!license || /^unknown$/i.test(license)) {
      findings.push(makeFinding({
        source: 'licenses_sbom', dimension: 'licenses', category: 'license-unknown',
        severity: 'low', confidence: 0.7, determinism: 'static',
        location: { file: 'package.json' }, evidence: `${pkg}: unknown license`,
      }));
    } else if (COPYLEFT.test(license)) {
      findings.push(makeFinding({
        source: 'licenses_sbom', dimension: 'licenses', category: 'license-copyleft',
        severity: 'medium', confidence: 0.8, determinism: 'static',
        location: { file: 'package.json' }, evidence: `${pkg}: ${license}`,
        remediation: 'Review copyleft obligations or replace the dependency.',
      }));
    }
  }
  return findings;
}

const LICENSE_FILES = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'COPYING', 'COPYING.txt', 'UNLICENSE', 'LICENSE-MIT', 'LICENSE-APACHE'];
const COPYLEFT_RE = /\b(AGPL|GPL|LGPL|SSPL|CDDL|EUPL|OSL)\b/i;

/** Find and classify the project's own root license file (tool-free). */
export function classifyProjectLicense(targetDir: string): { file: string | null; copyleft: boolean } {
  for (const name of LICENSE_FILES) {
    const text = readText(path.join(targetDir, name), 200_000);
    if (text == null) continue;
    return { file: name, copyleft: COPYLEFT_RE.test(text.slice(0, 4000)) };
  }
  return { file: null, copyleft: false };
}

export async function runLicensesSbomScorer(
  targetDir?: string,
  ctx?: ExtraScorerContext,
): Promise<ScorerResult> {
  if (!targetDir || !fs.existsSync(targetDir)) {
    return honest('licenses_sbom', 'license/SBOM scan needs an existing targetDir');
  }

  const findings: Finding[] = [];
  const analyzers = ['license-file'];

  // Always assess the project's own license — works for Python and JS repos
  // alike, so the dimension is never uncovered merely for lacking package.json.
  const own = classifyProjectLicense(targetDir);
  if (!own.file) {
    findings.push(makeFinding({
      source: 'licenses_sbom', dimension: 'licenses', category: 'license-missing',
      severity: 'medium', confidence: 1, determinism: 'static',
      evidence: 'No LICENSE file found at the repository root.',
      remediation: 'Add a LICENSE file declaring the project license.',
    }));
  } else if (own.copyleft) {
    findings.push(makeFinding({
      source: 'licenses_sbom', dimension: 'licenses', category: 'license-copyleft',
      severity: 'low', confidence: 0.7, determinism: 'static',
      location: { file: own.file },
      evidence: `Project license (${own.file}) appears to be copyleft.`,
      remediation: 'Confirm the copyleft terms are intended for this distribution model.',
    }));
  }

  // Dependency licenses when a JS manifest + license-checker are available.
  let pkgCount = 0;
  if (fs.existsSync(path.join(targetDir, 'package.json')) && (!ctx?.preflight || toolReady(ctx.preflight, 'license-checker'))) {
    const run = await runLocalCommand('license-checker', ['--json', '--production'], { cwd: targetDir, timeoutMs: 180_000 });
    const parsed = parseJson(run.output);
    if (parsed) {
      findings.push(...parseLicenseChecker(parsed));
      pkgCount = Object.keys(parsed as Record<string, unknown>).length;
      analyzers.push('license-checker');
    }
  }

  const copyleft = findings.filter((f) => f.category === 'license-copyleft').length;
  const unknown = findings.filter((f) => f.category === 'license-unknown').length;
  const missing = findings.filter((f) => f.category === 'license-missing').length;
  return attach({
    scorer: 'licenses_sbom',
    score: penaltyScore(copyleft * 8 + unknown * 2 + missing * 10, 60),
    summary: `${own.file ?? 'no LICENSE'} · ${pkgCount} package licenses · ${copyleft} copyleft · ${unknown} unknown`,
    details: { projectLicense: own.file, packages: pkgCount, copyleft, unknown, missing },
  }, { findings, dimensions: ['licenses'], analyzers });
}

// ---------------------------------------------------------------------------
// duplication — jscpd (JS/TS) or pylint duplicate-code (Python) → maintainability
// ---------------------------------------------------------------------------

interface JscpdDuplicate {
  tokens?: number;
  lines?: number;
  firstFile?: { name?: string; start?: number };
  secondFile?: { name?: string; start?: number };
}

export function parseJscpdReport(report: unknown, targetDir: string): Finding[] {
  if (!report || typeof report !== 'object') return [];
  const dupes = (report as { duplicates?: unknown }).duplicates;
  if (!Array.isArray(dupes)) return [];
  return (dupes as JscpdDuplicate[]).slice(0, 40).flatMap((d): Finding[] => {
    const first = d.firstFile?.name;
    if (!first) return [];
    const relFile = first.startsWith(targetDir) ? rel(targetDir, first) : first;
    const tokens = d.tokens ?? 0;
    const severity = tokens > 400 ? 'high' : tokens > 150 ? 'medium' : 'low';
    return [makeFinding({
      source: 'duplication',
      dimension: 'maintainability',
      category: 'duplicate-code',
      severity,
      confidence: 0.85,
      determinism: 'static',
      location: { file: relFile, ...(typeof d.firstFile?.start === 'number' ? { line: d.firstFile.start } : {}) },
      evidence: `${d.lines ?? '?'} duplicated lines / ${tokens} tokens (also in ${d.secondFile?.name ?? 'another file'})`,
      remediation: 'Extract the duplicated block into a shared helper.',
    })];
  });
}

const DUP_WINDOW = 6;

/**
 * Tool-free duplication detector. Normalizes each source line, slides a fixed
 * window, and flags windows that recur in a *different* file. Deterministic and
 * language-agnostic, so a Python/JS repo still gets a real signal with neither
 * jscpd nor pylint installed.
 */
export function builtinDuplication(targetDir: string, maxFindings = 40): Finding[] {
  const files = collectSourceFiles(targetDir, { maxFiles: 600, maxFileBytes: 512_000, maxDepth: 12 });
  const seen = new Map<string, { file: string; line: number }>();
  const findings: Finding[] = [];
  for (const f of files) {
    // Window over *meaningful* lines only (drop blanks, brace-only lines, and
    // comment-only lines) so real code blocks match despite formatting noise.
    const meaningful: Array<{ text: string; line: number }> = [];
    f.content.split(/\r?\n/).forEach((raw, idx) => {
      const t = raw.trim().replace(/\s+/g, ' ');
      if (t.length < 4) return;
      if (t.startsWith('//') || t.startsWith('#') || t.startsWith('*') || t.startsWith('/*')) return;
      meaningful.push({ text: t, line: idx + 1 });
    });
    let i = 0;
    while (i + DUP_WINDOW <= meaningful.length) {
      const win = meaningful.slice(i, i + DUP_WINDOW);
      const key = win.map((w) => w.text).join('\n');
      const hit = seen.get(key);
      if (!hit) {
        seen.set(key, { file: f.file, line: win[0].line });
        i++;
        continue;
      }
      if (hit.file === f.file) { i++; continue; } // only cross-file duplication

      // Coalesce the whole block: extend while the next overlapping window still
      // matches the SAME source file. Without this, one 12-line clone emitted
      // 7 findings at successive start lines (noise, not signal).
      let end = i + DUP_WINDOW;
      while (end < meaningful.length) {
        const nextKey = meaningful.slice(end - DUP_WINDOW + 1, end + 1).map((w) => w.text).join('\n');
        const next = seen.get(nextKey);
        if (next && next.file === hit.file) { end++; continue; }
        break;
      }
      const span = end - i;
      findings.push(makeFinding({
        source: 'duplication', dimension: 'maintainability', category: 'duplicate-code',
        severity: 'low', confidence: 0.6, determinism: 'heuristic',
        location: { file: f.file, line: meaningful[i].line, endLine: meaningful[end - 1].line },
        evidence: `${span} lines duplicated from ${hit.file}:${hit.line}`,
        remediation: 'Extract the duplicated block into a shared helper.',
      }));
      if (findings.length >= maxFindings) return findings;
      i = end;
    }
  }
  return findings;
}

export async function runDuplicationScorer(
  targetDir?: string,
  ctx?: ExtraScorerContext,
): Promise<ScorerResult> {
  if (!targetDir || !fs.existsSync(targetDir)) {
    return honest('duplication', 'duplication scan needs an existing targetDir');
  }
  const hasJs = fs.existsSync(path.join(targetDir, 'package.json'));
  const hasPy = ['pyproject.toml', 'requirements.txt'].some((f) => fs.existsSync(path.join(targetDir, f)));

  if (hasJs && (!ctx?.preflight || toolReady(ctx.preflight, 'jscpd'))) {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openhub-jscpd-'));
    try {
      await runLocalCommand('jscpd', ['--reporters', 'json', '--output', outDir, '--silent', '--min-tokens', '50', '.'], {
        cwd: targetDir, timeoutMs: 180_000,
      });
      const reportFile = path.join(outDir, 'jscpd-report.json');
      const report = parseJson(readText(reportFile, 4_000_000));
      if (report) {
        const findings = parseJscpdReport(report, targetDir);
        return attach({
          scorer: 'duplication',
          score: penaltyScore(findings.length * 4, 60),
          summary: `jscpd: ${findings.length} duplicated block${findings.length === 1 ? '' : 's'}`,
          details: { blocks: findings.length },
        }, { findings, dimensions: ['maintainability'], analyzers: ['jscpd'] });
      }
    } catch {
      /* fall through to python/available path */
    } finally {
      try { fs.rmSync(outDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }

  if (hasPy && (!ctx?.preflight || toolReady(ctx.preflight, 'pylint'))) {
    const run = await runLocalCommand('pylint', ['--disable=all', '--enable=duplicate-code', '-f', 'text', '.'], {
      cwd: targetDir, timeoutMs: 180_000,
    });
    const findings: Finding[] = [];
    const re = /^(.+?):(\d+):\d+:\s+.*duplicate-code.*$/gm;
    for (const m of run.output.matchAll(re)) {
      findings.push(makeFinding({
        source: 'duplication', dimension: 'maintainability', category: 'duplicate-code',
        severity: 'low', confidence: 0.7, determinism: 'static',
        location: { file: m[1].replace(/\\/g, '/'), line: Number(m[2]) },
        evidence: 'pylint duplicate-code',
      }));
    }
    if (findings.length > 0 || run.ok) {
      return attach({
        scorer: 'duplication',
        score: penaltyScore(findings.length * 4, 60),
        summary: `pylint: ${findings.length} duplicated block${findings.length === 1 ? '' : 's'}`,
        details: { blocks: findings.length },
      }, { findings, dimensions: ['maintainability'], analyzers: ['pylint'] });
    }
  }

  // Tool-free fallback so the dimension is never uncovered for lacking CLIs.
  const builtin = builtinDuplication(targetDir);
  return attach({
    scorer: 'duplication',
    score: penaltyScore(builtin.length * 3, 60),
    summary: `built-in: ${builtin.length} duplicated block${builtin.length === 1 ? '' : 's'} (no jscpd/pylint)`,
    details: { blocks: builtin.length, method: 'builtin-shingle' },
  }, { findings: builtin, dimensions: ['maintainability'], analyzers: ['builtin-shingle'] });
}

// ---------------------------------------------------------------------------
// a11y — pa11y over local HTML → `accessibility`
// ---------------------------------------------------------------------------

export function parsePa11yIssues(json: unknown, file: string): Finding[] {
  if (!Array.isArray(json)) return [];
  return (json as Array<{ type?: string; code?: string; message?: string; selector?: string }>)
    .slice(0, 40)
    .flatMap((issue): Finding[] => [makeFinding({
      source: 'a11y',
      dimension: 'accessibility',
      category: `a11y:${issue.code ?? 'issue'}`,
      severity: issue.type === 'error' ? 'high' : 'medium',
      confidence: 0.85,
      determinism: 'static',
      location: { file },
      evidence: `${issue.message ?? issue.code ?? 'accessibility issue'}${issue.selector ? ` (${issue.selector})` : ''}`,
      remediation: 'Fix the WCAG violation reported by pa11y.',
    })]);
}

export async function runA11yScorer(
  targetDir?: string,
  ctx?: ExtraScorerContext,
): Promise<ScorerResult> {
  if (!targetDir || !fs.existsSync(targetDir)) {
    return honest('a11y', 'accessibility scan needs an existing targetDir');
  }
  const htmlFiles: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 3 || htmlFiles.length >= 5) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (htmlFiles.length >= 5) return;
      if (e.isDirectory()) {
        if (!/^(node_modules|\.git|dist|build|coverage|\.next|vendor)$/.test(e.name) && !e.name.startsWith('.')) {
          walk(path.join(dir, e.name), depth + 1);
        }
      } else if (/\.html?$/i.test(e.name)) {
        htmlFiles.push(path.join(dir, e.name));
      }
    }
  };
  walk(targetDir, 0);

  if (htmlFiles.length === 0) {
    return honest('a11y', 'no HTML/UI surfaces found to run accessibility checks against');
  }
  if (ctx?.preflight && !toolReady(ctx.preflight, 'pa11y')) {
    return honest('a11y', toolReason(ctx.preflight, 'pa11y'));
  }
  const findings: Finding[] = [];
  const scanned: string[] = [];
  for (const file of htmlFiles) {
    const run = await runLocalCommand('pa11y', ['--json', file], { cwd: targetDir, timeoutMs: 120_000 });
    const parsed = parseJson(run.output);
    if (parsed) {
      scanned.push(rel(targetDir, file));
      findings.push(...parsePa11yIssues(parsed, rel(targetDir, file)));
    }
  }
  if (scanned.length === 0) {
    return honest('a11y', 'pa11y is not installed or produced no parseable report');
  }
  const errors = findings.filter((f) => f.severity === 'high').length;
  return attach({
    scorer: 'a11y',
    score: penaltyScore(errors * 6 + (findings.length - errors) * 2, 60),
    summary: `pa11y: ${findings.length} issue${findings.length === 1 ? '' : 's'} across ${scanned.length} page(s)`,
    details: { pages: scanned.length, issues: findings.length, errors },
  }, { findings, dimensions: ['accessibility'], analyzers: ['pa11y'], files: scanned.length, language: 'html' });
}

// ---------------------------------------------------------------------------
// perf — deterministic static heuristic (N+1, nested loops, sync IO in loops)
// ---------------------------------------------------------------------------

const LOOP_RE = /^\s*(?:for\s*\(|while\s*\(|\.forEach\s*\(|\.map\s*\(|for\s+\w+\s+in\s+|for\s+\w+\s+of\s+)/;
const DB_CALL_RE = /\.(find|findOne|findMany|findById|query|aggregate|save|insert|update|delete|fetch)\s*\(|await\s+(?:prisma|db|knex|conn|connection|client|repo|axios|fetch)\b|(?:axios|fetch)\s*\(/;
const SYNC_IO_RE = /\b(?:readFileSync|writeFileSync|existsSync|execSync|readdirSync)\s*\(/;

export interface PerfScanResult {
  findings: Finding[];
  files: number;
}

/** Line-window heuristic scanner. Deterministic, deliberately conservative. */
export function scanPerformance(content: string, file: string): Finding[] {
  const lines = content.split('\n');
  const findings: Finding[] = [];
  let loopDepthStart = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isLoop = LOOP_RE.test(line);
    if (isLoop) {
      if (loopDepthStart >= 0 && i - loopDepthStart <= 12) {
        findings.push(makeFinding({
          source: 'perf', dimension: 'performance', category: 'nested-loop',
          severity: 'medium', confidence: 0.5, determinism: 'heuristic',
          location: { file, line: i + 1 },
          evidence: `loop nested within ${i - loopDepthStart} lines of another loop`,
          remediation: 'Consider flattening or indexing to avoid O(n²) work.',
        }));
      }
      loopDepthStart = i;
      const window = lines.slice(i, i + 12).join('\n');
      if (DB_CALL_RE.test(window)) {
        findings.push(makeFinding({
          source: 'perf', dimension: 'performance', category: 'n-plus-one',
          severity: 'high', confidence: 0.55, determinism: 'heuristic',
          location: { file, line: i + 1 },
          evidence: 'database/network call inside a loop (possible N+1)',
          remediation: 'Batch the query or hoist it out of the loop.',
        }));
      }
      if (SYNC_IO_RE.test(window)) {
        findings.push(makeFinding({
          source: 'perf', dimension: 'performance', category: 'sync-io-in-loop',
          severity: 'medium', confidence: 0.6, determinism: 'heuristic',
          location: { file, line: i + 1 },
          evidence: 'synchronous filesystem call inside a loop',
          remediation: 'Use async IO or cache the read outside the loop.',
        }));
      }
    } else if (line.trim() === '' || /^\s*[)\]}]/.test(line)) {
      loopDepthStart = -1;
    }
  }
  return findings.slice(0, 30);
}

export async function runPerfScorer(targetDir?: string, _ctx?: ExtraScorerContext): Promise<ScorerResult> {
  if (!targetDir || !fs.existsSync(targetDir)) {
    return honest('perf', 'performance scan needs an existing targetDir');
  }
  const files: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 6 || files.length >= 120) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (files.length >= 120) return;
      if (e.isDirectory()) {
        if (!/^(node_modules|\.git|dist|build|coverage|\.next|__pycache__|\.venv|venv|target|vendor|\.turbo)$/.test(e.name) && !e.name.startsWith('.')) {
          walk(path.join(dir, e.name), depth + 1);
        }
      } else if (JS_EXT.test(e.name) || PY_EXT.test(e.name)) {
        files.push(path.join(dir, e.name));
      }
    }
  };
  walk(targetDir, 0);
  if (files.length === 0) return honest('perf', 'no JS/TS/Python sources to scan for performance hotspots');

  const findings: Finding[] = [];
  for (const file of files) {
    const content = readText(file, 300_000);
    if (content) findings.push(...scanPerformance(content, rel(targetDir, file)));
  }
  const nPlusOne = findings.filter((f) => f.category === 'n-plus-one').length;
  return attach({
    scorer: 'perf',
    score: penaltyScore(findings.length * 3 + nPlusOne * 2, 60),
    summary: `perf heuristics: ${findings.length} hotspot${findings.length === 1 ? '' : 's'} (${nPlusOne} N+1) across ${files.length} file(s)`,
    details: { files: files.length, hotspots: findings.length, nPlusOne },
  }, { findings, dimensions: ['performance'], analyzers: ['perf-heuristic'], files: files.length });
}

// ---------------------------------------------------------------------------
// api_contract — OpenAPI breaking-change check vs HEAD → `architecture`
// ---------------------------------------------------------------------------

export interface ApiSurface {
  paths: string[];
  operations: string[];
  source: 'json' | 'yaml';
}

export function parseApiSurface(content: string, name: string): ApiSurface | null {
  if (/\.json$/i.test(name)) {
    const json = parseJson<{ paths?: Record<string, Record<string, unknown>> }>(content);
    if (!json?.paths) return null;
    const paths: string[] = [];
    const operations: string[] = [];
    for (const [p, methods] of Object.entries(json.paths)) {
      paths.push(p);
      for (const method of Object.keys(methods)) {
        if (/^(get|post|put|patch|delete|options|head|trace)$/i.test(method)) operations.push(`${method.toLowerCase()} ${p}`);
      }
    }
    return { paths, operations, source: 'json' };
  }
  const paths: string[] = [];
  const operations: string[] = [];
  let inPaths = false;
  for (const line of content.split('\n')) {
    if (/^paths:\s*$/.test(line)) { inPaths = true; continue; }
    if (inPaths && /^\S/.test(line) && !/^paths:/.test(line)) inPaths = false;
    if (!inPaths) continue;
    const pathMatch = /^\s{1,4}(\/[^:]+):\s*$/.exec(line);
    if (pathMatch) { paths.push(pathMatch[1]); continue; }
    const opMatch = /^\s{3,8}(get|post|put|patch|delete|options|head|trace):\s*$/i.exec(line);
    if (opMatch && paths.length) operations.push(`${opMatch[1].toLowerCase()} ${paths[paths.length - 1]}`);
  }
  return paths.length ? { paths, operations, source: 'yaml' } : null;
}

export function diffApiSurfaces(base: ApiSurface, current: ApiSurface): Finding[] {
  const findings: Finding[] = [];
  const currentOps = new Set(current.operations);
  for (const op of base.operations) {
    if (!currentOps.has(op)) {
      findings.push(makeFinding({
        source: 'api_contract', dimension: 'architecture', category: 'api-breaking',
        severity: 'high', confidence: 0.8, determinism: 'static',
        location: { file: 'openapi' },
        evidence: `operation removed: ${op}`,
        remediation: 'Restore the operation or version the API and document the break.',
      }));
    }
  }
  return findings;
}

function findOpenApiSpec(targetDir: string): string | null {
  const names = ['openapi.yaml', 'openapi.yml', 'openapi.json', 'swagger.yaml', 'swagger.yml', 'swagger.json'];
  for (const n of names) {
    const p = path.join(targetDir, n);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export async function runApiContractScorer(
  targetDir?: string,
  ctx?: ExtraScorerContext,
): Promise<ScorerResult> {
  if (!targetDir || !fs.existsSync(targetDir)) return honest('api_contract', 'API contract needs an existing targetDir');
  const specPath = findOpenApiSpec(targetDir);
  if (!specPath) return honest('api_contract', 'no OpenAPI/Swagger spec found');
  const currentText = readText(specPath, 4_000_000);
  const current = currentText ? parseApiSurface(currentText, specPath) : null;
  if (!current) return honest('api_contract', 'could not parse the OpenAPI spec');

  const specRel = rel(targetDir, specPath);
  const baseRun = await runLocalCommand('git', ['show', `HEAD:${specRel}`], { cwd: targetDir, timeoutMs: 20_000 });
  if (!baseRun.ok) {
    // No baseline exists, so there is nothing to diff and nothing to score.
    // Reporting 100 here inflated the reconciled score with an unearned pass.
    return honest('api_contract', `no prior OpenAPI spec at HEAD:${specRel} — baseline cannot be scored`);
  }
  const base = parseApiSurface(baseRun.output, specPath);
  if (!base) return honest('api_contract', 'baseline OpenAPI spec could not be parsed');
  const findings = diffApiSurfaces(base, current);
  return attach({
    scorer: 'api_contract',
    score: penaltyScore(findings.length * 20, 60),
    summary: `${findings.length} breaking API change${findings.length === 1 ? '' : 's'} vs HEAD (${current.operations.length} operations)`,
    details: { operations: current.operations.length, breaking: findings.length },
  }, { findings, dimensions: ['architecture'], analyzers: ['openapi-diff'], files: 1 });
}

// ---------------------------------------------------------------------------
// git_history — large files, commit hygiene, high-signal secret scan → security
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: Array<{ category: string; re: RegExp; severity: string }> = [
  { category: 'secret-aws-key', re: /\bAKIA[0-9A-Z]{16}\b/, severity: 'high' },
  { category: 'secret-private-key', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/, severity: 'high' },
  { category: 'secret-generic', re: /\b(?:api[_-]?key|secret|token|password)\s*[:=]\s*['"][^'"]{12,}['"]/i, severity: 'medium' },
];

/** Paths whose "secrets" are almost always fixtures, not leaks. The heuristic
 *  scan skips these; the authoritative gitleaks scan still covers them. */
const TEST_PATH_RE = /(^|\/)(tests?|__tests__|__mocks__|fixtures?|e2e|spec)(\/|$)|[._-](test|spec)\.[cm]?[jt]sx?$/i;
/** Values that are obviously placeholders, not credentials. */
const PLACEHOLDER_RE = /(example|dummy|fake|sample|placeholder|changeme|redacted|your[_-]|xxxx|not[_-]?a[_-]?real|(?:sk|pk|rk)_test_|test[_-]?key|test[_-]?token)/i;

/**
 * Heuristic secret scan for one file's content. Pure, so it is unit-testable:
 * test/fixture paths and obvious placeholder values are skipped, and only the
 * first match per pattern is reported (a file with one leak is not counted 5×).
 */
export function scanSecretContent(content: string, file: string): Finding[] {
  if (TEST_PATH_RE.test(file)) return [];
  const findings: Finding[] = [];
  for (const pattern of SECRET_PATTERNS) {
    const match = pattern.re.exec(content);
    if (!match) continue;
    if (PLACEHOLDER_RE.test(match[0])) continue;
    const line = content.slice(0, match.index).split('\n').length;
    findings.push(makeFinding({
      source: 'git_history', dimension: 'security', category: pattern.category,
      severity: pattern.severity as Finding['severity'], confidence: 0.6, determinism: 'static',
      location: { file: file.replace(/\\/g, '/'), line },
      evidence: `potential secret committed at ${file}:${line}`,
      remediation: 'Rotate the secret and purge it from history (git filter-repo / BFG).',
    }));
    break;
  }
  return findings;
}

export async function runGitHistoryScorer(
  targetDir?: string,
  ctx?: ExtraScorerContext,
): Promise<ScorerResult> {
  if (!targetDir || !fs.existsSync(targetDir)) return honest('git_history', 'git history scan needs an existing targetDir');
  const inside = await runLocalCommand('git', ['rev-parse', '--is-inside-work-tree'], { cwd: targetDir, timeoutMs: 15_000 });
  if (!inside.ok || inside.output.trim() !== 'true') return honest('git_history', 'not a git worktree');

  const findings: Finding[] = [];
  const notes: string[] = [];

  // 1. Large tracked files.
  const list = await runLocalCommand('git', ['ls-files', '-z'], { cwd: targetDir, timeoutMs: 20_000 });
  const tracked = list.output.split('\u0000').map((s) => s.trim()).filter(Boolean).slice(0, 800);
  for (const file of tracked) {
    try {
      const stat = fs.statSync(path.join(targetDir, file));
      if (stat.isFile() && stat.size > 1_000_000) {
        findings.push(makeFinding({
          source: 'git_history', dimension: 'security', category: 'large-file',
          severity: 'low', confidence: 0.9, determinism: 'static',
          location: { file: file.replace(/\\/g, '/') },
          evidence: `${(stat.size / 1_048_576).toFixed(1)} MB tracked file`,
          remediation: 'Move large binaries out of the repository (Git LFS or external storage).',
        }));
      }
    } catch { /* skip */ }
  }

  // 2. Commit hygiene (vague messages).
  const log = await runLocalCommand('git', ['log', '-n', '30', '--format=%s'], { cwd: targetDir, timeoutMs: 20_000 });
  const vague = log.output.split('\n').map((s) => s.trim()).filter((s) => s && (s.length < 5 || /^(wip|fix|fixes|update|changes?|stuff|misc|test|\.+)$/i.test(s)));
  if (vague.length) {
    findings.push(makeFinding({
      source: 'git_history', dimension: 'security', category: 'commit-hygiene',
      severity: 'low', confidence: 0.6, determinism: 'heuristic',
      evidence: `${vague.length} of the last 30 commits have vague messages (e.g. "${vague[0]}")`,
      remediation: 'Use descriptive commit messages for auditability.',
    }));
  }

  // 3. High-signal secret scan of tracked text files (bounded).
  let scanned = 0;
  for (const file of tracked) {
    if (scanned >= 200) break;
    if (!/\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|php|json|ya?ml|env|toml|ini|sh|txt|properties)$/i.test(file)) continue;
    const content = readText(path.join(targetDir, file), 200_000);
    if (content == null) continue;
    scanned += 1;
    findings.push(...scanSecretContent(content, file));
  }
  if (scanned === 0) notes.push('no tracked text files scanned');

  // 4. gitleaks history scan when available (authoritative).
  if (ctx?.preflight && toolReady(ctx.preflight, 'gitleaks')) {
    const reportPath = path.join(os.tmpdir(), `openhub-gitleaks-${process.pid}-${Date.now()}.json`);
    await runLocalCommand('gitleaks', ['detect', '--no-banner', '--report-format', 'json', '--report-path', reportPath], {
      cwd: targetDir, timeoutMs: 180_000,
    });
    const parsed = parseJson<Array<{ RuleID?: string; Description?: string; File?: string; StartLine?: number }>>(readText(reportPath, 4_000_000));
    try { fs.rmSync(reportPath, { force: true }); } catch { /* best-effort */ }
    if (Array.isArray(parsed)) {
      for (const leak of parsed.slice(0, 25)) {
        findings.push(makeFinding({
          source: 'git_history', dimension: 'security', category: `secret:${leak.RuleID ?? 'gitleaks'}`,
          severity: 'high', confidence: 0.95, determinism: 'static',
          ...(leak.File ? { location: { file: leak.File, ...(leak.StartLine ? { line: leak.StartLine } : {}) } } : {}),
          evidence: leak.Description ?? leak.RuleID ?? 'gitleaks finding',
          remediation: 'Rotate the secret and purge it from history.',
        }));
      }
      notes.push('gitleaks history scan');
    }
  }

  const secrets = findings.filter((f) => f.category.startsWith('secret')).length;
  const large = findings.filter((f) => f.category === 'large-file').length;
  return attach({
    scorer: 'git_history',
    score: penaltyScore(secrets * 8 + large * 2 + (vague.length ? 2 : 0), 70),
    summary: `git history: ${secrets} secret(s), ${large} large file(s), ${vague.length} vague commit(s)`,
    details: { secrets, largeFiles: large, vagueCommits: vague.length, notes },
  }, { findings, dimensions: ['security'], analyzers: ['git'], files: scanned });
}

// ---------------------------------------------------------------------------
// iac — tfsec/trivy when present, else a deterministic Dockerfile/Terraform ruleset
// ---------------------------------------------------------------------------

const DOCKERFILE_RULES: Array<{ id: string; re: RegExp; severity: string; message: string }> = [
  { id: 'iac-docker-latest', re: /^FROM\s+\S+:latest\b/im, severity: 'low', message: 'base image uses the mutable :latest tag' },
  { id: 'iac-docker-root', re: /^USER\s+root\b/im, severity: 'medium', message: 'container runs as root' },
  { id: 'iac-docker-add-url', re: /^ADD\s+https?:\/\//im, severity: 'medium', message: 'ADD from a URL is not verified (use COPY + checksum)' },
  { id: 'iac-docker-secret-env', re: /^ENV\s+\S*(SECRET|TOKEN|PASSWORD|API_KEY)\S*\s*=/im, severity: 'high', message: 'secret material baked into an image ENV' },
  { id: 'iac-docker-curl-sh', re: /(?:curl|wget)[^\n]*\|\s*(?:ba)?sh\b/im, severity: 'medium', message: 'remote script piped to a shell' },
];

const TERRAFORM_RULES: Array<{ id: string; re: RegExp; severity: string; message: string }> = [
  { id: 'iac-tf-open-ingress', re: /cidr_blocks\s*=\s*\[[^\]]*"0\.0\.0\.0\/0"/im, severity: 'high', message: 'security group open to 0.0.0.0/0' },
  { id: 'iac-tf-public-acl', re: /\bacl\s*=\s*"(public-read|public-read-write)"/im, severity: 'high', message: 'bucket ACL is public' },
  { id: 'iac-tf-unencrypted', re: /\bencrypted\s*=\s*false\b/im, severity: 'medium', message: 'resource explicitly disables encryption' },
];

export function scanIacContent(content: string, file: string): Finding[] {
  const rules = /Dockerfile/i.test(path.basename(file)) ? DOCKERFILE_RULES
    : /\.tf$/i.test(file) ? TERRAFORM_RULES : [];
  const findings: Finding[] = [];
  for (const rule of rules) {
    const match = rule.re.exec(content);
    if (!match) continue;
    const line = content.slice(0, match.index).split('\n').length;
    findings.push(makeFinding({
      source: 'iac', dimension: 'security', category: rule.id,
      severity: rule.severity, confidence: 0.7, determinism: 'static',
      location: { file, line },
      evidence: rule.message,
      remediation: 'Apply the CIS/hardening recommendation for this resource.',
    }));
  }
  return findings;
}

export async function runIacScorer(targetDir?: string, ctx?: ExtraScorerContext): Promise<ScorerResult> {
  if (!targetDir || !fs.existsSync(targetDir)) return honest('iac', 'IaC scan needs an existing targetDir');
  const files: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 4 || files.length >= 60) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (files.length >= 60) return;
      if (e.isDirectory()) {
        if (!/^(node_modules|\.git|dist|build|coverage|\.next|\.terraform|vendor)$/.test(e.name) && !e.name.startsWith('.')) {
          walk(path.join(dir, e.name), depth + 1);
        }
      } else if (/^Dockerfile/i.test(e.name) || /\.tf$/i.test(e.name) || /^docker-compose\.ya?ml$/i.test(e.name)) {
        files.push(path.join(dir, e.name));
      }
    }
  };
  walk(targetDir, 0);
  if (files.length === 0) return honest('iac', 'no Dockerfile, docker-compose or Terraform files found');

  // Prefer a real scanner when one is live.
  const scanner = ctx?.preflight
    ? (['tfsec', 'trivy', 'checkov'] as const).find((t) => toolReady(ctx.preflight, t))
    : undefined;
  if (scanner === 'tfsec') {
    const run = await runLocalCommand('tfsec', ['--format', 'json', '.'], { cwd: targetDir, timeoutMs: 180_000 });
    const parsed = parseJson<{ results?: Array<{ rule_id?: string; rule_description?: string; severity?: string; location?: { filename?: string; start_line?: number } }> }>(run.output);
    if (parsed?.results) {
      const findings = parsed.results.slice(0, 40).flatMap((r): Finding[] => [makeFinding({
        source: 'iac', dimension: 'security', category: `iac:${r.rule_id ?? 'tfsec'}`,
        severity: r.severity ?? 'medium', confidence: 0.9, determinism: 'static',
        ...(r.location?.filename ? { location: { file: r.location.filename, ...(r.location.start_line ? { line: r.location.start_line } : {}) } } : {}),
        evidence: r.rule_description ?? r.rule_id ?? 'tfsec finding',
      })]);
      return attach({
        scorer: 'iac',
        score: penaltyScore(findings.length * 5, 60),
        summary: `tfsec: ${findings.length} misconfiguration${findings.length === 1 ? '' : 's'}`,
        details: { issues: findings.length, scanner: 'tfsec' },
      }, { findings, dimensions: ['security'], analyzers: ['tfsec'], files: files.length });
    }
  }

  const findings: Finding[] = [];
  for (const file of files) {
    const content = readText(file, 300_000);
    if (content) findings.push(...scanIacContent(content, rel(targetDir, file)));
  }
  return attach({
    scorer: 'iac',
    score: penaltyScore(findings.length * 5, 60),
    summary: `IaC built-in rules: ${findings.length} issue${findings.length === 1 ? '' : 's'} across ${files.length} file(s)`,
    details: { issues: findings.length, files: files.length, scanner: 'builtin' },
  }, { findings, dimensions: ['security', 'build_ci'], analyzers: ['iac-rules'], files: files.length });
}

/** Scorer ids added by P2 — used to decide whether a preflight is worthwhile. */
export const P2_SCORERS = [
  'deps_freshness', 'licenses_sbom', 'duplication', 'perf', 'a11y', 'api_contract', 'git_history', 'iac',
] as const;

export type P2ScorerName = (typeof P2_SCORERS)[number];

export function isP2Scorer(name: string): name is P2ScorerName {
  return (P2_SCORERS as readonly string[]).includes(name);
}

/** Dimension each P2 scorer reports into, for coverage wiring. */
export const P2_DIMENSIONS: Record<P2ScorerName, Dimension[]> = {
  deps_freshness: ['dependencies'],
  licenses_sbom: ['licenses'],
  duplication: ['maintainability'],
  perf: ['performance'],
  a11y: ['accessibility'],
  api_contract: ['architecture'],
  git_history: ['security'],
  iac: ['security', 'build_ci'],
};
