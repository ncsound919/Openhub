import fs from 'fs';
import path from 'path';
import { fetchOssReview, type OssReviewReport } from './ossReview.js';

/**
 * Agent readouts — structured, comprehensive findings from the external audit
 * agents (The Deep, CodeNexus, Benchmark Olympics) so the repair team gets an
 * exact work order. Each agent writes its reports to disk; this service reads
 * the newest report per tool and normalizes it into a shared findings schema.
 * Report dirs are env-configurable and default from UPLIFT_ROOT. A tool with
 * no report for the target reports `available: false` — never a fabricated
 * readout.
 */

export interface ReadoutFinding {
  ruleId: string;
  title: string;
  category: string;
  source: string;
  file: string;
  line?: string;
  explanation: string;
  severity: string;
  /** Producer-supplied fix, when the agent's report carried one. */
  remediation?: string;
}

export interface AgentReadout {
  tool: string;
  label: string;
  kind: 'json' | 'text';
  available: boolean;
  matched: boolean;
  scannedFiles: number | null;
  counts: Record<string, number> | null;
  findings: ReadoutFinding[];
  note?: string;
  readout?: string; // for text-based reports (Benchmark Olympics)
  reportPath?: string;
  score?: number | null;
  grade?: string | null;
}

export interface WorkOrderItem {
  file: string;
  line?: string;
  ruleId: string;
  title: string;
  category: string;
  suggestion: string;
  severity: string;
  tool: string;
}

function upliftRoot(env: NodeJS.ProcessEnv = process.env): string {
  return (env.UPLIFT_ROOT || path.join('C:', 'Users', 'User', 'Downloads', 'Uplift')).replace(/[/\\]+$/, '');
}

function reportDirs(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const up = upliftRoot(env);
  return {
    deep: env.OPENHUB_DEEP_REPORT_DIR || path.join(up, 'The Deep', 'deep-audit-reports'),
    codenexus: env.OPENHUB_CODENEXUS_REPORT_DIR || path.join(up, 'Draymond-Orchestrator', 'agents', 'CodeNexus-main', 'deep-audit', 'reports'),
    benchmark: env.OPENHUB_BENCHMARK_REPORT_DIR || path.join(up, 'Benchmark Olympics', 'reports'),
  };
}

/** Parse a "file:line:col" token into file + line, safely. */
function splitLocation(raw: string): { file: string; line?: string } {
  const m = /^(.*?):(\d+)(?::(\d+))?$/.exec(raw.trim());
  if (m) return { file: m[1], line: m[2] };
  return { file: raw.trim() };
}

function newestFiles(dir: string, maxAgeDays = 30): string[] {
  try {
    if (!fs.existsSync(dir)) return [];
    const cutoff = Date.now() - maxAgeDays * 24 * 3600 * 1000;
    return fs.readdirSync(dir)
      .map((name) => ({ name, abs: path.join(dir, name), mtime: (() => { try { return fs.statSync(path.join(dir, name)).mtimeMs; } catch { return 0; } })() }))
      .filter((f) => f.mtime >= cutoff)
      .sort((a, b) => b.mtime - a.mtime)
      .map((f) => f.abs);
  } catch {
    return [];
  }
}

function matchesTarget(candidate: any, targetName: string): boolean {
  if (typeof candidate?.target === 'string') {
    const norm = candidate.target.replace(/\\/g, '/').toLowerCase();
    return norm.endsWith(`/${targetName.toLowerCase()}`) || norm.split('/').pop() === targetName.toLowerCase();
  }
  return false;
}

function normalizeDeepFinding(f: any): ReadoutFinding {
  const { file, line } = splitLocation(typeof f.file === 'string' ? f.file : '');
  // The Deep stores its fix under `suggestedFix` (a string or {description}).
  const fix = f?.suggestedFix;
  const remediation = typeof fix === 'string' ? fix
    : (fix && typeof fix.description === 'string' ? fix.description : undefined);
  return {
    ruleId: typeof f.ruleId === 'string' ? f.ruleId : '',
    title: typeof f.title === 'string' ? f.title : '',
    category: typeof f.category === 'string' ? f.category : 'unknown',
    source: typeof f.source === 'string' ? f.source : 'unknown',
    file,
    line,
    explanation: typeof f.explanation === 'string' ? f.explanation : (typeof f.title === 'string' ? f.title : ''),
    severity: typeof f.severity === 'string' ? f.severity : 'unknown',
    ...(remediation ? { remediation } : {}),
  };
}

function readJsonFindings(targetName: string, dir: string, label: string, kind: 'json'): AgentReadout {
  const files = newestFiles(dir);
  if (files.length === 0) {
    return { tool: label, label, kind, available: false, matched: false, scannedFiles: null, counts: null, findings: [], note: `no report in ${dir}` };
  }
  for (const file of files) {
    let parsed: any = null;
    try { parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { continue; }
    const matched = matchesTarget(parsed, targetName);
    const findings = Array.isArray(parsed?.findings) ? parsed.findings.map(normalizeDeepFinding).slice(0, 400) : [];
    const scannedFiles = typeof parsed?.scannedFiles === 'number' ? parsed.scannedFiles : null;
    const counts = parsed?.counts && typeof parsed.counts === 'object' ? parsed.counts : null;
    return {
      tool: label,
      label,
      kind,
      available: true,
      matched,
      scannedFiles,
      counts,
      findings,
      ...(matched ? {} : { note: `newest report (${path.basename(file)}) may target a different project` }),
      reportPath: file,
    };
  }
  return { tool: label, label, kind, available: false, matched: false, scannedFiles: null, counts: null, findings: [], note: 'no parseable report' };
}

function readTextReadout(targetName: string, dir: string, label: string): AgentReadout {
  const files = newestFiles(dir);
  if (files.length === 0) {
    return { tool: label, label, kind: 'text', available: false, matched: false, scannedFiles: null, counts: null, findings: [], note: `no report in ${dir}` };
  }
  const file = files[0];
  try {
    const text = fs.readFileSync(file, 'utf8');
    return {
      tool: label,
      label,
      kind: 'text',
      available: true,
      matched: text.toLowerCase().includes(targetName.toLowerCase()),
      scannedFiles: null,
      counts: null,
      findings: [],
      readout: text.slice(0, 4000),
      reportPath: file,
    };
  } catch {
    return { tool: label, label, kind: 'text', available: false, matched: false, scannedFiles: null, counts: null, findings: [], note: 'unreadable report' };
  }
}

/** Read the newest report from each audit agent for the given project. */
export function getAgentReadouts(targetName: string, env: NodeJS.ProcessEnv = process.env): AgentReadout[] {
  const dirs = reportDirs(env);
  return [
    readJsonFindings(targetName, dirs.deep, 'the-deep', 'json'),
    readJsonFindings(targetName, dirs.codenexus, 'codenexus', 'json'),
    readTextReadout(targetName, dirs.benchmark, 'benchmark-olympics'),
  ].map(withGrade);
}

/** Derive a 0–100 score + letter grade from a readout's finding load. */
function withGrade(r: AgentReadout): AgentReadout {
  if (!r.available) return r;
  const base = r.findings.length
    ? Math.max(0, 100 - r.findings.length * 0.25)
    : (r.kind === 'text' ? 80 : 95);
  const score = Math.round(base);
  const grade = score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : score >= 40 ? 'D' : 'F';
  return { ...r, score, grade };
}

const SEVERITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4, unknown: 5 };

/** Aggregate every structured finding into a prioritized, actionable work order. */
export function buildWorkOrder(readouts: AgentReadout[]): { items: WorkOrderItem[]; total: number } {
  const items: WorkOrderItem[] = [];
  const seen = new Set<string>();
  for (const r of readouts) {
    for (const f of r.findings) {
      // The same issue reported by two readouts (e.g. The Deep and a cached
      // report) is one work item, not two.
      const key = `${f.file}|${f.line ?? ''}|${f.ruleId || f.category}|${f.title}`.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({
        file: f.file,
        line: f.line,
        ruleId: f.ruleId,
        title: f.title,
        category: f.category,
        suggestion: f.remediation || f.explanation || f.title,
        severity: f.severity,
        tool: r.tool,
      });
    }
  }
  items.sort((a, b) => {
    const sa = SEVERITY_ORDER[a.severity.toLowerCase()] ?? 5;
    const sb = SEVERITY_ORDER[b.severity.toLowerCase()] ?? 5;
    if (sa !== sb) return sa - sb;
    if (a.category !== b.category) return a.category.localeCompare(b.category);
    return (a.file + a.line).localeCompare(b.file + (b.line ?? ''));
  });
  return { items, total: items.length };
}

// ---------------------------------------------------------------------------
// OSS review readouts — OpenCodeReview (`ocr`) + code-review-graph (`crg`).
// Axiom runs the two tools as subprocesses and returns a summarized report
// (see openhub/src/services/ossReview.ts). Here we normalize the graph's
// test gaps / review priorities and OCR's line-level findings into the same
// ReadoutFinding schema The Deep and CodeNexus use, so they flow into the
// repair work order as concrete, line-anchored items. Axiom being down or a
// tool being missing yields available:false with a real note — never a
// fabricated readout.
// ---------------------------------------------------------------------------

/** code-review-graph findings: untested changed functions + high-risk changes.
 *  A function already reported as a test gap is not repeated as a risk item. */
export function codegraphFindings(rep?: OssReviewReport): ReadoutFinding[] {
  const g = rep?.graph?.report;
  if (!g) return [];
  const findings: ReadoutFinding[] = [];
  const gapKeys = new Set<string>();
  for (const gap of g.test_gaps ?? []) {
    const file = String(gap.file ?? '');
    const line = gap.line_start != null ? String(gap.line_start) : undefined;
    gapKeys.add(`${gap.name ?? ''}|${file}|${line ?? ''}`);
    findings.push({
      ruleId: 'crg:test-gap',
      title: `Untested changed function: ${gap.name ?? '(anonymous)'}`,
      category: 'test-coverage',
      source: 'code-review-graph',
      file,
      line,
      explanation: `Changed function ${gap.name ?? ''} in ${file}${line ? `:${line}` : ''} has no test reference — add coverage before merge.`,
      severity: 'medium',
    });
  }
  for (const p of g.review_priorities ?? []) {
    const file = String(p.file_path ?? '');
    const line = p.line_start != null ? String(p.line_start) : undefined;
    if (gapKeys.has(`${p.name ?? ''}|${file}|${line ?? ''}`)) continue;
    const risk = typeof p.risk_score === 'number' ? p.risk_score : 0;
    findings.push({
      ruleId: 'crg:change-risk',
      title: `Review priority: ${p.name ?? '(anonymous)'} (risk ${risk.toFixed(2)})`,
      category: 'change-risk',
      source: 'code-review-graph',
      file,
      line,
      explanation: `High-risk changed function ${p.name ?? ''} in ${file}${line ? `:${line}` : ''} — inspect callers and tests before merge.`,
      severity: risk >= 0.7 ? 'high' : risk >= 0.4 ? 'medium' : 'low',
    });
  }
  return findings;
}

/** OpenCodeReview line-level findings (only present when an LLM endpoint is
 *  configured). Shape is upstream-versioned, so every field is read
 *  defensively and anything unrecognized degrades to a generic review item. */
export function ocrFindings(rep?: OssReviewReport): ReadoutFinding[] {
  const raw = rep?.llmReview?.findings;
  const list: unknown[] = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as Record<string, unknown>).findings)
      ? ((raw as Record<string, unknown>).findings as unknown[])
      : [];
  return list.slice(0, 200).map((entry): ReadoutFinding => {
    const f = (entry ?? {}) as Record<string, unknown>;
    const file = String(f.file ?? f.path ?? f.file_path ?? '');
    const line = f.line != null ? String(f.line) : f.line_start != null ? String(f.line_start) : undefined;
    const title = String(f.title ?? f.message ?? f.description ?? f.comment ?? 'Review comment');
    return {
      ruleId: String(f.ruleId ?? f.rule ?? f.rule_id ?? 'ocr:review'),
      title,
      category: String(f.category ?? 'code-review'),
      source: 'open-code-review',
      file,
      line,
      explanation: String(f.explanation ?? f.suggestion ?? f.message ?? title),
      severity: String(f.severity ?? f.level ?? 'unknown').toLowerCase(),
    };
  });
}

const OSS_UNAVAILABLE_NOTE = 'Axiom oss-review unreachable';

/** Live OSS review readouts for a local project dir. `fetcher` is injectable
 *  for tests; production uses the shared Axiom bridge. */
export async function getOssReviewReadouts(
  targetDir: string,
  fetcher: typeof fetchOssReview = fetchOssReview,
): Promise<AgentReadout[]> {
  const unavailable = (note: string): AgentReadout[] => [
    { tool: 'codegraph', label: 'code-review-graph', kind: 'json', available: false, matched: false, scannedFiles: null, counts: null, findings: [], note },
    { tool: 'ocr', label: 'open-code-review', kind: 'json', available: false, matched: false, scannedFiles: null, counts: null, findings: [], note },
  ];

  const fetched = await fetcher(targetDir, { timeoutMs: 30_000 });
  if (!fetched.ok || !fetched.report) return unavailable(fetched.error || OSS_UNAVAILABLE_NOTE);
  const rep = fetched.report;
  const g = rep.graph;
  const ocr = rep.ocr;

  const graphReadout: AgentReadout = {
    tool: 'codegraph',
    label: 'code-review-graph',
    kind: 'json',
    available: g?.available === true,
    matched: true,
    scannedFiles: g?.report?.changed_functions?.length ?? null,
    counts: g?.report
      ? {
          testGaps: g.report.test_gaps?.length ?? 0,
          changedFunctions: g.report.changed_functions?.length ?? 0,
          affectedFlows: g.report.affected_flows?.length ?? 0,
        }
      : null,
    findings: codegraphFindings(rep),
    note: g?.available === true ? g.error : g?.error || 'code-review-graph unavailable in Axiom',
  };

  const ocrReadout: AgentReadout = {
    tool: 'ocr',
    label: 'open-code-review',
    kind: 'json',
    available: ocr?.available === true,
    matched: true,
    scannedFiles: ocr?.preview?.reviewable_count ?? null,
    counts: ocr?.preview ? { reviewable: ocr.preview.reviewable_count ?? 0, total: ocr.preview.total_files ?? 0 } : null,
    findings: ocrFindings(rep),
    note:
      ocr?.available === true
        ? rep.llmReview?.configured
          ? rep.llmReview.error
          : 'LLM review off — deterministic file selection only (set OCR_LLM_* or DEEPSEEK_API_KEY)'
        : ocr?.error || 'OpenCodeReview unavailable in Axiom',
  };

  return [graphReadout, ocrReadout].map(withGrade);
}
