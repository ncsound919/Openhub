/**
 * Repair brief — the missing link between an audit verdict and actual code
 * correction.
 *
 * Before this, the repair dispatcher (`repairRoutes`) sent only per-scorer
 * summaries to Draymond, and the supervisor rebuilt its work order from stale
 * on-disk agent readouts. The fresh, deduped, corroborated `report.findings`
 * never reached the repair agent, so a failing audit asked for "repair" without
 * saying what to fix. This module turns that evidence into a bounded,
 * prioritized, remediation-carrying brief.
 *
 * Deterministic — no LLM. A finding with no producer-supplied remediation gets a
 * category-derived instruction, so nothing reaches repair as a bare complaint.
 */
import type { AuditReport } from './auditSuite.js';
import { severityRank, type Finding } from './findings.js';

export interface RepairBriefItem {
  /** 1-based position in the prioritized list. */
  rank: number;
  severity: string;
  source: string;
  dimension: string;
  category: string;
  file?: string;
  line?: number;
  title: string;
  evidence?: string;
  remediation: string;
  /** True when the producing analyzer supplied the remediation (vs. derived). */
  remediationFromAnalyzer: boolean;
  /** Independent analyzers that reported the same finding. */
  corroboratedBy: string[];
  cwe?: string;
  cve?: string;
}

export interface RepairBrief {
  /** One-line objective the repair agent can act on. */
  goal: string;
  items: RepairBriefItem[];
  /** Total unique findings in the report (before the brief cap). */
  total: number;
  /** Findings dropped by the item cap (lowest priority first). */
  omitted: number;
  /** Scorers that could not run — configure/install, not scored as zero. */
  blockedTools: Array<{ scorer: string; reason: string }>;
  /** Scorers that moved the score with no file-level evidence behind them. */
  scoreOnlyScorers: Array<{ scorer: string; score: number | null; summary: string }>;
  overallScore: number | null;
  grade: string;
  overallStatus: AuditReport['overallStatus'];
}

export interface RepairBriefOptions {
  maxItems?: number;
  maxChars?: number;
}

const DEFAULT_MAX_ITEMS = 60;
const DEFAULT_MAX_CHARS = 7000;

/** Category/source → deterministic remediation when the analyzer gave none. */
const REMEDIATION_PATTERNS: Array<[RegExp, string]> = [
  [/secret|credential|api[-_]?key|password|token/i, 'Remove the credential from source, rotate it, and load it from Keywire/env at runtime.'],
  [/cve|vulnerab|dependency/i, 'Upgrade the affected dependency to a fixed version and re-scan.'],
  [/coverage|untested|test-gap|missing-test/i, 'Add a test that exercises this code path, then re-run the audit.'],
  [/type|ts\d+|mypy/i, 'Fix the type error at the reported location and re-run typecheck.'],
  [/^lint|lint:/i, "Resolve the lint rule at the reported location (or run the linter's autofix)."],
  [/npe|null|undefined|toctou|race|unchecked/i, 'Guard the failing path (validate/null-check) and add a regression test.'],
  [/duplicat/i, 'Extract the duplicated logic into one shared helper.'],
  [/complex|maintainab|debt/i, 'Split the flagged unit into smaller, testable functions.'],
  [/iac|docker|terraform|k8s|helm/i, 'Apply the hardening recommendation for the flagged resource.'],
];

function deriveRemediation(f: Finding): { text: string; fromAnalyzer: boolean } {
  if (f.remediation && f.remediation.trim()) return { text: f.remediation.trim(), fromAnalyzer: true };
  for (const [re, text] of REMEDIATION_PATTERNS) {
    if (re.test(f.category) || re.test(f.source)) return { text, fromAnalyzer: false };
  }
  return {
    text: 'Inspect the flagged code, resolve the issue, and add a regression test so the next audit can confirm the fix.',
    fromAnalyzer: false,
  };
}

function truncate(s: string, n: number): string {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function dedupeBy<T>(items: T[], key: (x: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const it of items) {
    const k = key(it);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}

function compareFindings(a: Finding, b: Finding): number {
  const sev = severityRank(a.severity) - severityRank(b.severity);
  if (sev !== 0) return sev;
  // A finding with real remediation is more actionable than an equal-severity one.
  const ra = a.remediation ? 0 : 1;
  const rb = b.remediation ? 0 : 1;
  if (ra !== rb) return ra - rb;
  const fa = `${a.location?.file ?? ''}:${a.location?.line ?? ''}`;
  const fb = `${b.location?.file ?? ''}:${b.location?.line ?? ''}`;
  if (fa !== fb) return fa.localeCompare(fb);
  return a.category.localeCompare(b.category);
}

export function buildRepairBrief(report: AuditReport, opts: RepairBriefOptions = {}): RepairBrief {
  const maxItems = Math.max(1, opts.maxItems ?? DEFAULT_MAX_ITEMS);
  const findings = Array.isArray(report.findings) ? report.findings : [];
  const kept = [...findings].sort(compareFindings).slice(0, maxItems);

  const items: RepairBriefItem[] = kept.map((f, i) => {
    const { text, fromAnalyzer } = deriveRemediation(f);
    return {
      rank: i + 1,
      severity: f.severity,
      source: f.source,
      dimension: f.dimension,
      category: f.category,
      ...(f.location?.file ? { file: f.location.file } : {}),
      ...(typeof f.location?.line === 'number' ? { line: f.location.line } : {}),
      title: f.evidence || f.category,
      ...(f.evidence ? { evidence: f.evidence } : {}),
      remediation: text,
      remediationFromAnalyzer: fromAnalyzer,
      corroboratedBy: f.corroboratedBy ?? [],
      ...(f.cwe ? { cwe: f.cwe } : {}),
      ...(f.cve ? { cve: f.cve } : {}),
    };
  });

  const blockedTools = dedupeBy(
    (report.results ?? [])
      .filter((r) => r.status === 'unavailable' || (r.score === null && !!r.error))
      .map((r) => ({ scorer: r.scorer, reason: r.error || r.summary || 'unavailable' })),
    (b) => b.scorer,
  );
  const scoreOnlyScorers = dedupeBy(
    (report.results ?? [])
      .filter((r) => typeof r.score === 'number' && !(r.findings && r.findings.length))
      .map((r) => ({ scorer: r.scorer, score: r.score, summary: r.summary })),
    (s) => s.scorer,
  );

  return {
    goal: `OpenHub audit ${report.overallStatus}: raise ${report.overallScore ?? 'N/A'} (${report.grade ?? 'N/A'}) by resolving the ${findings.length} finding(s) below`,
    items,
    total: findings.length,
    omitted: Math.max(0, findings.length - items.length),
    blockedTools,
    scoreOnlyScorers,
    overallScore: report.overallScore ?? null,
    grade: report.grade ?? 'N/A',
    overallStatus: report.overallStatus,
  };
}

/** Render a brief as bounded plain text for a repair dispatch. */
export function renderRepairBrief(brief: RepairBrief, opts: RepairBriefOptions = {}): string {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const lines: string[] = [];
  lines.push(
    `OPENHUB REPAIR BRIEF — ${String(brief.overallStatus).toUpperCase()} · score ${brief.overallScore ?? 'N/A'} (${brief.grade}) · ${brief.total} finding(s)`,
  );
  for (const it of brief.items) {
    const loc = it.file ? `${it.file}${it.line ? `:${it.line}` : ''}` : '(no location)';
    const corroborated = it.corroboratedBy.length ? ` +${it.corroboratedBy.join('+')}` : '';
    lines.push(
      `${it.rank}. [${it.severity}] ${loc} (${it.source}${corroborated} · ${it.category}) ${truncate(it.title, 200)} -> ${truncate(it.remediation, 300)}`,
    );
  }
  if (brief.omitted > 0) lines.push(`… ${brief.omitted} lower-priority finding(s) omitted`);
  if (brief.scoreOnlyScorers.length) {
    lines.push('', 'SCORE-ONLY (moved the grade with no file-level evidence — obtain details before trusting):');
    for (const s of brief.scoreOnlyScorers) lines.push(`- ${s.scorer}: ${s.score} — ${truncate(s.summary, 160)}`);
  }
  if (brief.blockedTools.length) {
    lines.push('', 'BLOCKED TOOLS (configure/install to restore coverage — excluded from the grade, not zeroed):');
    for (const b of brief.blockedTools) lines.push(`- ${b.scorer}: ${truncate(b.reason, 160)}`);
  }
  let out = lines.join('\n');
  if (out.length > maxChars) {
    out = `${out.slice(0, maxChars - 14).replace(/\n[^\n]*$/, '')}\n… truncated`;
  }
  return out;
}
