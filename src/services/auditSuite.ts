import path from 'path';
import fs from 'fs';
import os from 'os';
import { fetchOssReview, countFindings, type OssReviewReport } from './ossReview.js';
import {
  DIMENSIONS,
  DIMENSION_META,
  SIGNAL_GROUPS,
  GROUP_WEIGHTS,
  GROUP_LABELS,
  buildCoverageFromResults,
  clampDimensionScore,
  determinismForScorer,
  dimensionsForScorer,
  primaryDimension,
  type CoverageReport,
  type Dimension,
} from './dimensions.js';
import {
  createFinding,
  dedupeFindings,
  type DedupStats,
  type Determinism,
  type Finding,
} from './findings.js';
import { runAuditCore, type AuditCoreResult } from './auditCore.js';
import {
  SUPPORTED_EXTENSIONS,
  collectSourceFiles,
  formatLanguageBreakdown,
} from './analyzers.js';
import { parseTestOutput, scoreTestSummary, type TestFailure, type TestSummary } from './testReport.js';
import { resolveAuditScope, FULL_SCOPE, type AuditScope } from './auditScope.js';
import { buildAuditDelta, type AuditDelta } from './auditDelta.js';
import {
  runDepsFreshnessScorer,
  runLicensesSbomScorer,
  runDuplicationScorer,
  runPerfScorer,
  runA11yScorer,
  runApiContractScorer,
  runGitHistoryScorer,
  runIacScorer,
  isP2Scorer,
} from './p2Scorers.js';
import { preflightAuditTools, type PreflightReport } from './preflight.js';
import {
  auditCacheEnabled,
  auditModelConfig,
  getCachedScorer,
  scorerCacheKey,
  setCachedScorer,
  signatureForDir,
  type AuditModelConfig,
} from './auditRuntime.js';
import { runLocalCommand as runProcessCommand } from './processRunner.js';
import { anchorHead, enterReceiptContext, listReceipts, runWithReceipts } from './receipts.js';
import {
  auditFeedbackEnabled,
  recordAuditFeedback,
  type AuditFeedbackResult,
} from './auditFeedback.js';

/** Every scorer the audit suite can dispatch. */
export type ScorerName =
  | 'reporank' | 'grader' | 'claw' | 'sca' | 'codenexus' | 'local_qa'
  | 'codegraph' | 'ocr' | 'deep' | 'codegang' | 'typecheck' | 'lint'
  | 'deps_freshness' | 'licenses_sbom' | 'duplication' | 'perf'
  | 'a11y' | 'api_contract' | 'git_history' | 'iac' | 'sonarqube' | 'cmake';

export interface AuditRunParams {
  repoUrl?: string;
  targetDir?: string;
  scorers?: ScorerName[];
  /** Base ref for a diff-scoped audit (default: HEAD). */
  base?: string;
  /** Force a full-tree audit (default: diff-scoped when the target is a git tree). */
  full?: boolean;
  /** Depth preset (quick/standard/deep/release). Explicit `scorers` always win. */
  preset?: AuditPresetName;
  /**
   * Build lifecycle stage (pre-commit/pr/merge/nightly/release). Implies its
   * preset unless `scorers` are explicit, evaluates a gate, and always feeds
   * the learning loop. This is how the build stays honest at designated times.
   */
  stage?: AuditStageName;
  /** Prior report for this target, used to compute the delta/trend. */
  previousReport?: AuditReport;
  /**
   * Emit the run into telemetry + self-learning (the recursive-learning loop).
   * Defaults to the `AUDIT_FEEDBACK` env flag (off unless set to 1/true/yes).
   */
  feedback?: boolean;
  /**
   * Scorers whose absence leaves a blind spot. When any of these is in the plan
   * but returns unavailable, the run fails closed (see `AUDIT_REQUIRE_SCORERS`,
   * default `sca,claw`). Explicit `[]` disables the coverage check for this run.
   */
  requiredScorers?: ScorerName[];
  /**
   * Run the shared audit core over the report's findings: deterministic
   * validation (reachability/staleness), persistent finding lifecycle, and the
   * configured PR/release gate. Off by default so existing runs are unchanged.
   */
  core?: boolean;
  /**
   * Optional progress hook, called before each scorer runs (and once more with
   * `index === total` when the sweep finishes). Lets a background job surface
   * "scorer i of n" instead of a silent multi-minute wait. Throwing from it
   * never breaks the audit.
   */
  onProgress?: (p: { scorer: ScorerName; index: number; total: number }) => void;
}

/**
 * Evidence envelope returned by every scorer (P0). `score` is the legacy
 * numeric verdict; `findings`/`coverage`/`dimension` make a tool's *blind
 * spots* first-class so an unavailable analyzer surfaces as an explicit gap
 * instead of silently disappearing from the report.
 */
export interface ScorerCoverage {
  language?: string;
  files: number;
  analyzers: string[];
  dimensions: Dimension[];
}

export interface ScorerResult {
  scorer: string;
  score: number | null;
  grade?: string;
  summary: string;
  details?: unknown;
  error?: string;
  /** Primary dimension the numeric score rolls into. */
  dimension?: Dimension;
  /** All dimensions this scorer produced evidence for (coverage matrix). */
  dimensions?: Dimension[];
  determinism?: Determinism;
  findings?: Finding[];
  coverage?: ScorerCoverage;
  status?: 'ok' | 'partial' | 'unavailable';
  durationMs?: number;
  /** True when the result was served from the runtime cache (G2). */
  cached?: boolean;
}

/** One dimension's rolled-up score and the contributions behind it. */
export interface DimensionContribution {
  /** Scorer name, or the human label of a collapsed signal group. */
  scorer: string;
  score: number;
  weight: number;
  determinism: Determinism;
  /** Share of this dimension's score the contribution ultimately held. */
  share: number;
  /** Member scorers when this contribution is a collapsed signal group. */
  members?: string[];
}

export interface DimensionScore {
  dimension: Dimension;
  label: string;
  score: number | null;
  weight: number;
  deterministic: number | null;
  llm: number | null;
  /** Share of the dimension score that came from LLM-derived evidence. */
  llmShare: number;
  /** True when the LLM cap reduced the model's influence. */
  llmCapped: boolean;
  contributions: DimensionContribution[];
}

export interface Reconciliation {
  weightedScore: number | null;
  grade: string;
  contributing: Array<{ scorer: string; score: number; weight: number; members?: string[] }>;
  excluded: Array<{ scorer: string; reason: string }>;
  dimensions: DimensionScore[];
  /** Overall score with every LLM-derived contribution removed. */
  deterministicScore: number | null;
  /** Overall share of the score attributable to LLM evidence (0..1). */
  llmShare: number;
  model: 'dimension-v2';
}

export interface AuditReport {
  id: string;
  timestamp: string;
  target: string;
  results: ScorerResult[];
  overallStatus: 'pass' | 'warn' | 'fail';
  /** Reconciled 0-100 across the dimensions that produced a real score. */
  overallScore: number | null;
  /** Same rollup with LLM-derived evidence excluded (always computable offline). */
  overallScoreDeterministic: number | null;
  /** Letter grade for the reconciled score (A+ … F, or N/A when nothing scored). */
  grade: string;
  /** Which scorers fed the reconciled score, and which were excluded (and why). */
  reconciliation: Reconciliation;
  /** Per-dimension subscores behind `overallScore`. */
  dimensions: DimensionScore[];
  /** Dimension × tool matrix with explicit `uncovered` entries. */
  coverage: CoverageReport;
  /** Share of the 12 dimensions that produced evidence (0..100). */
  coveragePercent: number;
  /** Deduplicated, cross-tool-corroborated findings. */
  findings: Finding[];
  /** Dedup accounting (input vs unique, corroboration ratio). */
  dedup: DedupStats;
  /** Deduplicated critical-severity findings — a non-zero count forces fail. */
  criticalFindings: number;
  /** Scorers that produced a real score, out of the plan's attempted total. */
  scorersRun: number;
  scorersTotal: number;
  /** Scorers that could not run (score null) — the honest coverage gap. */
  unavailableScorers: string[];
  /** Required scorers that were in the plan but unavailable (fail-closed gap). */
  requiredUnavailableScorers: string[];
  /** WHY the verdict is what it is — so "fail" is never ambiguous between real
   *  findings and an audit that could not verify (missing scanners). Optional so
   *  report fixtures/consumers built before this field stay valid. */
  verdictReason?: 'ok' | 'below-threshold' | 'critical-findings' | 'required-scanners-unavailable' | 'unscored';
  /** Human-readable one-liner for `verdictReason`. */
  verdictDetail?: string;
  /** Whether this audit was diff-scoped or full-tree, and the guard notes. */
  scope: AuditScope;
  /** Change vs the previous audit for the same target (null when no baseline). */
  delta: AuditDelta | null;
  /** Validation + lifecycle + gate from the shared audit core (opt-in via params.core). */
  core?: AuditCoreResult;
  /** Lifecycle stage this run was recorded under (absent for ad-hoc runs). */
  stage?: AuditStageName;
  /** Gate verdict when a stage was requested (absent otherwise). */
  gate?: AuditGate;
  /** Tool capability grid for the P2 analyzers (missing tools are explicit gaps). */
  preflight?: PreflightReport;
  /** Pinned LLM model/seed + cache state for this run (G2 determinism). */
  determinismConfig?: AuditModelConfig;
  /** Where this run was recorded for the learning loop (null when disabled). */
  feedback?: AuditFeedbackResult;
  /** Evidence spine: the run id every executed-command receipt is tagged with. */
  receiptRunId?: string;
  /** Ordered receipt ids for the commands that actually ran during this audit. */
  receiptIds?: string[];
}

/** Relative importance of each scorer in the reconciled grade. A scorer with
 *  no numeric score never contributes (it is listed as excluded, never folded
 *  in as a zero — that would silently punish a missing tool). */
const SCORER_WEIGHTS: Record<string, number> = {
  sca: 3,             // dependency CVEs + secrets + misconfigs
  claw: 2,            // secret scan
  'claw-protect': 2,  // secret scan (result scorer name)
  deep: 2,            // static analysis / bug taxonomy
  codegraph: 2,       // blast radius / test gaps
  grader: 2,          // LLM grade
  reporank: 2,        // LLM grade
  ocr: 1,             // line-level review
  codegang: 1,        // structure/complexity
  local_qa: 1,        // tests actually run
  cmake: 2,           // native C/C++ build + ctest
  typecheck: 2,       // compilers / type checkers
  lint: 2,            // linters
  deps_freshness: 2,  // stale dependencies
  licenses_sbom: 1,   // license policy
  duplication: 1,     // duplicated code
  perf: 1,            // performance hotspots
  a11y: 1,            // accessibility
  api_contract: 1,    // breaking API changes
  git_history: 2,     // committed secrets / large files / hygiene
  iac: 2,             // infra misconfiguration
  sonarqube: 2,       // server-side quality + security gate
  codenexus: 0,       // capability probe, never scores a local dir
};

const GRADE_SCALE: Array<{ min: number; grade: string }> = [
  { min: 93, grade: 'A' }, { min: 90, grade: 'A-' },
  { min: 87, grade: 'B+' }, { min: 83, grade: 'B' }, { min: 80, grade: 'B-' },
  { min: 77, grade: 'C+' }, { min: 73, grade: 'C' }, { min: 70, grade: 'C-' },
  { min: 65, grade: 'D+' }, { min: 60, grade: 'D' },
  { min: 0, grade: 'F' },
];

export function gradeFor(score: number): string {
  return GRADE_SCALE.find((g) => score >= g.min)?.grade ?? 'F';
}

function weightedMean(items: Array<{ value: number; weight: number }>): number | null {
  const totalW = items.reduce((s, i) => s + i.weight, 0);
  if (totalW <= 0) return null;
  return items.reduce((s, i) => s + i.value * i.weight, 0) / totalW;
}

/**
 * Scoring v2 — deterministic-first reconciliation.
 *
 * Instead of a flat weighted mean over scorers, each numeric score rolls into
 * its PRIMARY dimension; dimensions roll up into the overall score by
 * configurable weight. Within a dimension, LLM-derived evidence is capped by
 * `DIMENSION_META[dim].llmCap` (it can never carry the dimension on its own),
 * and an LLM-free `deterministicScore` is always computed alongside. Scorers
 * that could not run are reported as excluded, never folded in as a zero.
 */
export function reconcileResults(results: ScorerResult[]): Reconciliation {
  const contributing: Array<{ scorer: string; score: number; weight: number; members?: string[] }> = [];
  const excluded: Array<{ scorer: string; reason: string }> = [];
  const buckets = new Map<Dimension, DimensionContribution[]>();

  // Partition scored results into collapsed signal groups + standalone scorers,
  // so correlated opinions (reporank + grader are both LLM repo grades) cast a
  // single weighted vote instead of double-counting the same signal.
  const groupMembers = new Map<string, ScorerResult[]>();
  const standalones: ScorerResult[] = [];
  for (const r of results) {
    const weight = SCORER_WEIGHTS[r.scorer] ?? 1;
    const scored = typeof r.score === 'number' && Number.isFinite(r.score);
    if (!scored) {
      if (weight > 0) excluded.push({ scorer: r.scorer, reason: r.error || r.summary || 'no score' });
      continue;
    }
    const group = SIGNAL_GROUPS[r.scorer];
    if (group) {
      const list = groupMembers.get(group) ?? [];
      list.push(r);
      groupMembers.set(group, list);
    } else {
      standalones.push(r);
    }
  }

  const addContribution = (
    label: string,
    score: number,
    weight: number,
    dimension: Dimension,
    determinism: Determinism,
    members?: string[],
  ): void => {
    const collapsed = members && members.length > 1;
    contributing.push({ scorer: label, score, weight, ...(collapsed ? { members } : {}) });
    if (weight <= 0) return;
    const list = buckets.get(dimension) ?? [];
    list.push({ scorer: label, score, weight, determinism, share: 0, ...(collapsed ? { members } : {}) });
    buckets.set(dimension, list);
  };

  for (const r of standalones) {
    addContribution(
      r.scorer,
      r.score as number,
      SCORER_WEIGHTS[r.scorer] ?? 1,
      r.dimension ?? primaryDimension(r.scorer),
      r.determinism ?? determinismForScorer(r.scorer),
    );
  }

  for (const [group, members] of groupMembers) {
    const mean = weightedMean(
      members.map((m) => ({ value: m.score as number, weight: SCORER_WEIGHTS[m.scorer] ?? 1 })),
    );
    if (mean === null) continue;
    const lead = members[0];
    addContribution(
      GROUP_LABELS[group] ?? group,
      Math.round(mean),
      GROUP_WEIGHTS[group] ?? Math.max(...members.map((m) => SCORER_WEIGHTS[m.scorer] ?? 1)),
      lead.dimension ?? primaryDimension(lead.scorer),
      lead.determinism ?? determinismForScorer(lead.scorer),
      members.map((m) => m.scorer),
    );
  }

  const dimensions: DimensionScore[] = [];
  for (const dimension of DIMENSIONS) {
    const contributions = buckets.get(dimension);
    if (!contributions || contributions.length === 0) continue;

    const totalW = contributions.reduce((s, c) => s + c.weight, 0);
    const detContribs = contributions.filter((c) => c.determinism !== 'llm');
    const llmContribs = contributions.filter((c) => c.determinism === 'llm');
    const detWeight = detContribs.reduce((s, c) => s + c.weight, 0);
    const llmWeight = llmContribs.reduce((s, c) => s + c.weight, 0);
    const deterministic = weightedMean(detContribs.map((c) => ({ value: c.score, weight: c.weight })));
    const llm = weightedMean(llmContribs.map((c) => ({ value: c.score, weight: c.weight })));

    let score: number | null;
    let llmShare: number;
    let llmCapped = false;
    if (deterministic !== null && llm !== null) {
      const rawLlmShare = totalW > 0 ? llmWeight / totalW : 0;
      llmShare = Math.min(DIMENSION_META[dimension].llmCap, rawLlmShare);
      llmCapped = llmShare < rawLlmShare;
      score = deterministic * (1 - llmShare) + llm * llmShare;
    } else if (deterministic !== null) {
      score = deterministic;
      llmShare = 0;
    } else {
      score = llm;
      llmShare = 1;
    }

    for (const c of contributions) {
      const group = c.determinism === 'llm' ? llmWeight : detWeight;
      const groupShare = c.determinism === 'llm' ? llmShare : 1 - llmShare;
      c.share = group > 0 ? groupShare * (c.weight / group) : 0;
    }

    dimensions.push({
      dimension,
      label: DIMENSION_META[dimension].label,
      score:
        score === null
          ? null
          : Math.round(clampDimensionScore(dimension, score, contributions.length)),
      weight: DIMENSION_META[dimension].weight,
      deterministic: deterministic === null ? null : Math.round(deterministic),
      llm: llm === null ? null : Math.round(llm),
      llmShare,
      llmCapped,
      contributions,
    });
  }

  const scoredDims = dimensions.filter((d) => d.score !== null);
  const dimWeightTotal = scoredDims.reduce((s, d) => s + d.weight, 0);
  const weightedScore = dimWeightTotal > 0
    ? Math.round(scoredDims.reduce((s, d) => s + (d.score as number) * d.weight, 0) / dimWeightTotal)
    : null;

  const detDims = dimensions.filter((d) => d.deterministic !== null);
  const detWeightTotal = detDims.reduce((s, d) => s + d.weight, 0);
  const deterministicScore = detWeightTotal > 0
    ? Math.round(detDims.reduce((s, d) => s + (d.deterministic as number) * d.weight, 0) / detWeightTotal)
    : null;

  const llmShare = dimWeightTotal > 0
    ? scoredDims.reduce((s, d) => s + d.llmShare * d.weight, 0) / dimWeightTotal
    : 0;

  return {
    weightedScore,
    grade: weightedScore === null ? 'N/A' : gradeFor(weightedScore),
    contributing,
    excluded,
    dimensions,
    deterministicScore,
    llmShare: Math.round(llmShare * 1000) / 1000,
    model: 'dimension-v2',
  };
}

const REPORANK_URL = process.env.REPORANK_URL || 'http://127.0.0.1:3200';
const GRADER_URL = process.env.GRADER_URL || 'http://127.0.0.1:3201';
const CLAW_URL = process.env.CLAW_URL || 'http://127.0.0.1:3300';
// Service URLs resolve per call so env overrides (and tests) always apply.
// The Deep speaks HTTP only when DEEP_URL points at its dedicated server
// (same convention as Axiom); unset means the scorer honestly skips.
export function deepUrl(): string {
  return (process.env.DEEP_URL || '').replace(/\/+$/, '');
}
// CodeGang runs as a Next dev server (repoPath analysis). Default matches the
// port its dev logs show; override via CODEGANG_URL when it moves.
export function codegangUrl(): string {
  return (process.env.CODEGANG_URL || 'http://127.0.0.1:3011').replace(/\/+$/, '');
}
// CodeNexus is a GitHub-webhook PR platform (:3205 control plane); there is no
// local-dir review endpoint, so this scorer reports capability, not a grade.
export function codenexusUrl(): string {
  return (process.env.CODENEXUS_URL || 'http://127.0.0.1:3205').replace(/\/+$/, '');
}

const DEFAULT_POLL_INTERVAL_MS = 3_000;
const DEFAULT_POLL_TIMEOUT_MS = 120_000;

/** RepoRank/Grader accept a GitHub URL; shorthand `owner/repo` expands. */
function normalizeRepoUrl(repoUrl?: string): string | null {
  if (!repoUrl || typeof repoUrl !== 'string') return null;
  const trimmed = repoUrl.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^[^/\s]+\/[^/\s]+$/.test(trimmed)) return `https://github.com/${trimmed}`;
  return null;
}

async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
  timeoutMs = 15_000
): Promise<{ ok: boolean; status: number; json: any; error?: string }> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { ok: res.ok, status: res.status, json: await res.json().catch(() => null) };
  } catch (err: any) {
    return { ok: false, status: 0, json: null, error: err.message };
  }
}

async function getJson(
  url: string,
  headers: Record<string, string> = {},
  timeoutMs = 15_000
): Promise<{ ok: boolean; status: number; json: any; error?: string }> {
  try {
    const res = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(timeoutMs) });
    return { ok: res.ok, status: res.status, json: await res.json().catch(() => null) };
  } catch (err: any) {
    return { ok: false, status: 0, json: null, error: err.message };
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface EvidenceExtras {
  findings?: Finding[];
  dimensions?: Dimension[];
  determinism?: Determinism;
  files?: number;
  language?: string;
  analyzers?: string[];
  status?: ScorerResult['status'];
}

/** Stamp the P0 evidence envelope onto a scorer result. */
function attach(result: ScorerResult, extras: EvidenceExtras = {}): ScorerResult {
  const findings = result.findings ?? extras.findings ?? [];
  const dimensions = result.dimensions ?? extras.dimensions ?? dimensionsForScorer(result.scorer);
  return {
    ...result,
    dimension: result.dimension ?? dimensions[0] ?? primaryDimension(result.scorer),
    dimensions,
    determinism: result.determinism ?? extras.determinism ?? determinismForScorer(result.scorer),
    findings,
    coverage: result.coverage ?? {
      ...(extras.language ? { language: extras.language } : {}),
      files: extras.files ?? 0,
      analyzers: extras.analyzers ?? [result.scorer],
      dimensions,
    },
    status: result.status ?? extras.status ?? (result.score === null ? 'unavailable' : 'ok'),
  };
}

function honest(scorer: string, error: string, summary = ''): ScorerResult {
  return attach({ scorer, score: null, summary: summary || error, error }, { status: 'unavailable' });
}

/** Build a normalized, fingerprinted finding (shared model in findings.ts). */
export const makeFinding = createFinding;

// ---------------------------------------------------------------------------
// RepoRank — asynchronous scan (submit + poll), matching Draymond's contract.
// ---------------------------------------------------------------------------

export async function runRepoRankScorer(repoUrl: string): Promise<ScorerResult> {
  const repo = normalizeRepoUrl(repoUrl);
  if (!repo) return honest('reporank', 'no GitHub repo URL to score (local dirs use the audit/QA gate instead)');

  const apiKey = process.env.REPORANK_API_KEY;
  if (!apiKey) return honest('reporank', 'REPORANK_API_KEY not set (create a gr_ key in RepoRank org settings)');
  // RepoRank validates the raw `gr_…` key against the Authorization header
  // (no `Bearer ` prefix) — unlike Grader/Claw, which strip `Bearer `.
  const auth = { Authorization: apiKey };

  const submit = await postJson(
    `${REPORANK_URL.replace(/\/+$/, '')}/api/v1/scans`,
    { repoUrl: repo, branch: 'main', buildSource: 'github' },
    auth,
    30_000
  );
  if (!submit.ok) return honest('reporank', `scan submit: ${submit.error || `HTTP ${submit.status}`}`);
  const scanId = submit.json?.data?.scanId;
  if (!scanId) return honest('reporank', 'scan submit returned no scanId');

  const interval = Number(process.env.REPORANK_POLL_INTERVAL_MS ?? DEFAULT_POLL_INTERVAL_MS);
  const timeout = Number(process.env.REPORANK_POLL_TIMEOUT_MS ?? DEFAULT_POLL_TIMEOUT_MS);
  const deadline = Date.now() + timeout;
  let lastStatus = 'queued';
  while (Date.now() < deadline) {
    await sleep(interval);
    const poll = await getJson(`${REPORANK_URL.replace(/\/+$/, '')}/api/v1/scans/${scanId}`, auth);
    if (!poll.ok) { lastStatus = `poll ${poll.error || poll.status}`; continue; }
    const data = poll.json?.data;
    lastStatus = String(data?.status ?? 'unknown');
    if (lastStatus === 'complete') {
      // RepoRank stores the score in the scan row AND in a `report` blob. The
      // poll endpoint returns `result` (the report), which may arrive as a JSON
      // string; the flat `overallScore`/`gradeCategory` live on the report
      // object (or on the scan row via the list endpoint).
      let report: unknown = data?.result;
      if (typeof report === 'string') { try { report = JSON.parse(report); } catch { report = null; } }
      const rep = (report && typeof report === 'object' ? report : {}) as Record<string, unknown>;
      const score = typeof rep.overallScore === 'number' ? rep.overallScore
        : typeof data?.overallScore === 'number' ? data.overallScore : null;
      const grade = typeof rep.gradeCategory === 'string' ? rep.gradeCategory : undefined;
      if (score === null) return honest('reporank', 'scan completed without an overallScore', `grade ${grade ?? '?'}`);
      return attach({ scorer: 'reporank', score, grade, summary: grade ? `grade ${grade}` : 'reporank scan complete', details: rep });
    }
    if (lastStatus === 'error') {
      return honest('reporank', String(data?.error ?? 'scan failed'), 'reporank scan error');
    }
  }
  return honest('reporank', `scan timed out (last status: ${lastStatus})`);
}

// ---------------------------------------------------------------------------
// Grader — synchronous POST /api/grade, real HealthReport only.
// ---------------------------------------------------------------------------

export async function runGraderScorer(repoUrl: string): Promise<ScorerResult> {
  const repo = normalizeRepoUrl(repoUrl);
  if (!repo) return honest('grader', 'no GitHub repo URL to grade');

  const apiKey = process.env.GRADER_API_KEY;
  if (!apiKey) return honest('grader', 'GRADER_API_KEY not set (create a gr_ key in Grader)');

  const res = await postJson(
    `${GRADER_URL.replace(/\/+$/, '')}/api/grade`,
    { repoUrl: repo },
    { Authorization: `Bearer ${apiKey}` },
    Number(process.env.GRADER_TIMEOUT_MS ?? 90_000)
  );
  if (!res.ok) return honest('grader', `grade failed: HTTP ${res.status}${res.json?.error ? ` (${res.json.error})` : ''}`);

  const score = typeof res.json?.overallScore === 'number' ? res.json.overallScore : null;
  const grade = typeof res.json?.gradeCategory === 'string' ? res.json.gradeCategory : undefined;
  if (score === null) return honest('grader', 'grader responded without an overallScore', `grade ${grade ?? '?'}`);
  return attach({
    scorer: 'grader',
    score,
    grade,
    summary: grade ? `grade ${grade}` : typeof res.json?.summary === 'string' ? res.json.summary : 'grader scored',
    details: res.json,
  });
}

// ---------------------------------------------------------------------------
// Claw-Protect — real SCA secrets scan. Requires CLAW_PROTECT_SYSTEM_AGENT_KEY.
// Never returns a score when the scan could not run.
// ---------------------------------------------------------------------------

const CLAW_MAX_CONTENT_CHARS = 20_000;
const CLAW_MAX_FILES = 50;
const CLAW_MAX_DEPTH = 4;

/** Filenames worth a secrets scan (secrets concentrate in env/config/key files). */
const CLAW_SECRET_PATTERNS: RegExp[] = [
  /^\.env(\..+)?$/,            // .env, .env.local, .env.production
  /\.env$/i,                   // *.env
  /^package\.json$/,           // package.json
  /^readme(\.md)?$/i,          // README.md
  /^dockerfile$/i,             // Dockerfile
  /^docker-compose.*\.ya?ml$/i,
  /^secrets?\b/i,              // secrets.json etc.
  /\.(pem|key|p12|pfx|jks)$/i, // private keys / keystores
  /^id_rsa/i,                  // id_rsa
  /^credentials?\./i,          // credentials.*
  /^\.npmrc$/i,                // npm auth token
  /^\.pypirc$/i,               // PyPI token
  /^\.netrc$/i,                // .netrc
  /^\.aws\/(credentials|config)$/i, // AWS creds
  /\.config\.(js|json|ts|yaml|yml)$/i,
];

/**
 * Collect secret-bearing files for a local dir. Walks a bounded depth/count,
 * skipping vendored/build dirs, so nested projects (e.g. a `ui-v2/` frontend
 * inside a Python backend) are still scanned. Deterministic and honest: an
 * unreadable or oversized file is skipped, never invented.
 */
function collectScannableFiles(targetDir: string): Array<{ path: string; content: string }> {
  const out: Array<{ path: string; content: string }> = [];
  const skipDirs = new Set([
    'node_modules', '.git', 'dist', '.next', 'build', '__pycache__',
    '.venv', 'venv', 'env', '.idea', '.vscode', '.pytest_cache', 'release',
  ]);
  const walk = (dir: string, depth: number): void => {
    if (depth > CLAW_MAX_DEPTH || out.length >= CLAW_MAX_FILES) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= CLAW_MAX_FILES) return;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!skipDirs.has(e.name)) walk(p, depth + 1);
      } else if (e.isFile()) {
        if (!CLAW_SECRET_PATTERNS.some((re) => re.test(e.name))) continue;
        try {
          if (fs.statSync(p).size > 1_000_000) continue;
          const content = fs.readFileSync(p, 'utf8').slice(0, CLAW_MAX_CONTENT_CHARS);
          out.push({ path: p, content });
        } catch { /* unreadable file — skip honestly */ }
      }
    }
  };
  walk(targetDir, 0);
  return out;
}

export async function runClawProtectScorer(params: { repoUrl?: string; targetDir?: string }): Promise<ScorerResult> {
  const apiKey = process.env.CLAW_PROTECT_SYSTEM_AGENT_KEY;
  if (!apiKey) return honest('claw-protect', 'CLAW_PROTECT_SYSTEM_AGENT_KEY not set — SCA scan skipped');

  let scanned = 0;
  let secretsFound = 0;
  let lastError: string | null = null;
  const findings: Finding[] = [];

  if (params.targetDir && fs.existsSync(params.targetDir)) {
    const files = collectScannableFiles(params.targetDir);
    for (const f of files) {
      const res = await postJson(
        `${CLAW_URL.replace(/\/+$/, '')}/api/v1/scan/secrets`,
        { content: f.content, location: f.path },
        { Authorization: `Bearer ${apiKey}` },
        20_000
      );
      if (!res.ok) { lastError = `HTTP ${res.status}`; continue; }
      scanned += 1;
      const found = typeof res.json?.secretsFound === 'number' ? res.json.secretsFound : 0;
      secretsFound += found;
      const rel = path.relative(params.targetDir, f.path).replace(/\\/g, '/');
      const items = Array.isArray(res.json?.secrets) ? res.json.secrets
        : Array.isArray(res.json?.findings) ? res.json.findings : [];
      for (const item of items) {
        const rec = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
        findings.push(makeFinding({
          source: 'claw-protect',
          dimension: 'security',
          category: 'secret',
          severity: 'high',
          confidence: 0.75,
          determinism: 'static',
          location: { file: rel, ...(typeof rec.line === 'number' ? { line: rec.line } : {}) },
          evidence: String(rec.rule ?? rec.type ?? rec.category ?? rec.name ?? 'potential secret'),
          remediation: 'Remove the credential from source, rotate it, and load it from Keywire/env at runtime.',
        }));
      }
    }
    if (scanned === 0) {
      return honest('claw-protect', lastError || 'no scannable files in target dir', 'SCA scan could not run');
    }
    const summary = `SCA scanned ${scanned} files, ${secretsFound} potential secret${secretsFound === 1 ? '' : 's'} found`;
    return attach(
      { scorer: 'claw-protect', score: secretsFound === 0 ? 100 : Math.max(0, 100 - secretsFound * 10), summary },
      { findings, files: scanned, analyzers: ['claw-protect'], status: lastError ? 'partial' : 'ok' },
    );
  }

  // Repo URL path: Claw-Protect scans content, not repositories; there is no
  // honest repo-wide scan here yet, so report that instead of inventing one.
  return honest('claw-protect', 'repo-wide SCA scan not available — pass a local targetDir to scan key files', 'SCA scan skipped');
}

// ---------------------------------------------------------------------------
// OSS review scorers — OpenCodeReview (`ocr`) + code-review-graph (`crg`).
// These are evidence producers, not graders: they call Axiom's
// `/api/harness/oss-review` bridge (which runs the two tools as subprocesses)
// and normalize the deterministic results into the shared ScorerResult shape.
// A numeric score is derived only from defensible signals (untested changed
// code / line-level findings), never from a fabricated grade — and a tool that
// is missing or unreachable reports score=null with a real error.
// ---------------------------------------------------------------------------

export function codegraphScorerResult(rep?: OssReviewReport, error?: string): ScorerResult {
  if (error) return honest('codegraph', error);
  const graph = rep?.graph;
  if (!graph?.available) return honest('codegraph', 'code-review-graph unavailable (Axiom down, or install `code-review-graph`)');
  if (!graph.report) return honest('codegraph', graph.error || 'code-review-graph returned no report');
  const gaps = graph.report.test_gaps ?? [];
  const untested = gaps.length;
  // Cap the deduction: a large repo naturally has many untested functions; a
  // hard 15/untested unit drove the score to 0 on any non-trivial codebase.
  const score = untested === 0 ? 100 : Math.max(0, 100 - Math.min(80, untested * 15));
  const findings: Finding[] = gaps.map((g) => makeFinding({
    source: 'codegraph',
    dimension: 'tests',
    category: 'coverage-gap',
    severity: 'medium',
    confidence: 0.6,
    determinism: 'heuristic',
    ...(g.file ? { location: { file: g.file, ...(typeof g.line_start === 'number' ? { line: g.line_start } : {}) } } : {}),
    evidence: `untested: ${g.name ?? 'function'}`,
    remediation: 'Add a test covering this changed function.',
  }));
  return attach({
    scorer: 'codegraph',
    score,
    summary: `graph risk ${(graph.report.risk_score ?? 0).toFixed(2)} · ${graph.report.changed_functions?.length ?? 0} changed fn · ${untested} untested · ${graph.report.affected_flows?.length ?? 0} affected flows`,
    details: graph.report,
  }, { findings, analyzers: ['codegraph'] });
}

/** Normalize the OCR LLM review findings (shape-tolerant) into the model. */
function llmReviewFindings(rep?: OssReviewReport): Finding[] {
  const raw = rep?.llmReview?.findings;
  if (!Array.isArray(raw)) return [];
  const out: Finding[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const file = typeof rec.file === 'string' ? rec.file : typeof rec.path === 'string' ? rec.path : undefined;
    const line = typeof rec.line === 'number' ? rec.line
      : typeof rec.line_start === 'number' ? rec.line_start : undefined;
    const fixRaw = rec.remediation ?? rec.suggestion ?? rec.fix;
    const remediation = typeof fixRaw === 'string' ? fixRaw
      : fixRaw && typeof (fixRaw as { description?: unknown }).description === 'string'
        ? String((fixRaw as { description: string }).description)
        : undefined;
    out.push(makeFinding({
      source: 'ocr',
      dimension: 'maintainability',
      category: String(rec.category ?? rec.ruleId ?? rec.type ?? 'review-comment'),
      severity: String(rec.severity ?? 'medium'),
      confidence: 0.6,
      determinism: 'llm',
      ...(file ? { location: { file, ...(line !== undefined ? { line } : {}) } } : {}),
      evidence: String(rec.message ?? rec.title ?? rec.comment ?? rec.description ?? 'review finding'),
      ...(remediation ? { remediation } : {}),
    }));
  }
  return out;
}

export function ocrScorerResult(rep?: OssReviewReport, error?: string): ScorerResult {
  if (error) return honest('ocr', error);
  const ocr = rep?.ocr;
  if (!ocr?.available) return honest('ocr', 'OpenCodeReview unavailable (Axiom down, or install `@alibaba-group/open-code-review`)');
  const reviewable = ocr.preview?.reviewable_count ?? 0;
  const llmConfigured = rep?.llmReview?.configured === true;
  const findings = countFindings(rep?.llmReview?.findings);
  // Normalize by review surface: a raw count saturates any non-trivial change set
  // at 0 (e.g. 66 findings -> 0). Findings per reviewed file stays informative:
  // ~1 finding/file => 80, 5+/file => 0.
  const perFile = findings !== null ? (reviewable > 0 ? findings / reviewable : findings) : 0;
  const score = llmConfigured && findings !== null ? Math.max(0, Math.round(100 - perFile * 20)) : null;
  return attach({
    scorer: 'ocr',
    score,
    summary: `deterministic: ${reviewable} reviewable file(s) · LLM review ${llmConfigured ? `on (${findings ?? '?'} findings)` : 'off (no endpoint)'}`,
    details: { preview: ocr.preview, llmReview: rep?.llmReview },
  }, { findings: llmReviewFindings(rep), files: reviewable, analyzers: ['ocr'] });
}

async function fetchOssReviewForAudit(targetDir: string): Promise<{ ok: boolean; report?: OssReviewReport; error?: string }> {
  // Operator-triggered audit: refresh the code graph first so the risk report
  // reflects the current tree. Passive readouts read the existing graph.
  return fetchOssReview(targetDir, { build: true });
}

// ---------------------------------------------------------------------------
// The Deep — direct HTTP audit (static-analysis + bug-taxonomy + deep-intent).
// Same contract Axiom uses: walk the target, POST {files:[{file,content,language}]},
// merge findings. Needs DEEP_URL; offline/unset degrades honestly.
// ---------------------------------------------------------------------------

/** Extensions The Deep sends. Derived from the analyzer registry so `.py` (and
 *  go/rs/java) are no longer silently skipped by a hard-coded TS/JS list. */
const DEEP_EXTENSIONS = new Set(SUPPORTED_EXTENSIONS);
const DEEP_SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage', '.turbo', 'build', '.next', '.godot', 'vendor', '.vs', '__pycache__', '.venv', 'venv', '.pytest_cache', '.mypy_cache', '.ruff_cache', 'target']);
const DEEP_MAX_FILES = 400;
const DEEP_MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Per-language analyzer options forwarded to The Deep. Browser-facing TS/JS
 *  gets DOM libs so `document`/`window` are not reported as undefined globals. */
function deepLanguageOptions(): Record<string, Record<string, unknown>> {
  return {
    typescript: { lib: ['DOM', 'DOM.Iterable', 'ES2022'], strict: true, allowJs: true, noEmit: true },
    javascript: { lib: ['DOM', 'DOM.Iterable', 'ES2022'], allowJs: true, noEmit: true },
  };
}

/** Forward the pinned LLM model/seed (G2) to The Deep's LLM pass when set. */
function deepModelFields(): Record<string, unknown> {
  const { model, seed } = auditModelConfig();
  return { ...(model ? { model } : {}), ...(seed !== null ? { seed } : {}) };
}

export interface DeepFile { file: string; content: string; language: string }

export function collectDeepFiles(targetDir: string, opts: { includeFiles?: Set<string> } = {}): DeepFile[] {
  const files = collectSourceFiles(targetDir, {
    extensions: DEEP_EXTENSIONS,
    maxFiles: DEEP_MAX_FILES,
    maxFileBytes: DEEP_MAX_FILE_BYTES,
    skipDirs: DEEP_SKIP_DIRS,
    skipDotDirs: true,
  });
  if (!opts.includeFiles) return files;
  return files.filter((f) => opts.includeFiles!.has(f.file));
}

/** Map a raw Deep finding into the normalized model. */
function deepFindingToFinding(f: DeepFinding): Finding {
  const file = typeof f.file === 'string' ? f.file : typeof f.path === 'string' ? f.path : undefined;
  const line = typeof f.line === 'number' ? f.line : undefined;
  const title = String(f.title ?? f.message ?? f.description ?? 'deep finding');
  // The Deep stores its fix under `suggestedFix` (string or {description}); a
  // finding that arrives with remediation is actionable instead of a complaint.
  const rawFix = f.suggestedFix ?? f.remediation ?? f.fix;
  const remediation = typeof rawFix === 'string' ? rawFix
    : rawFix && typeof (rawFix as { description?: unknown }).description === 'string'
      ? String((rawFix as { description: string }).description)
      : undefined;
  return makeFinding({
    // Preserve the upstream analyzer's provenance when it names itself; only fall
    // back to the aggregate 'deep' label. Clobbering it lost tool attribution.
    source: typeof f.source === 'string' && f.source.trim() ? f.source.trim().slice(0, 40) : 'deep',
    dimension: 'correctness',
    category: String(f.category ?? f.ruleId ?? f.rule ?? 'deep-finding'),
    severity: String(f.severity ?? 'info'),
    confidence: typeof f.confidence === 'number' ? (f.confidence > 1 ? f.confidence / 100 : f.confidence) : 0.6,
    determinism: 'static',
    ...(file ? { location: { file, ...(line !== undefined ? { line } : {}) } } : {}),
    evidence: title,
    ...(remediation ? { remediation } : {}),
  });
}

export interface DeepFinding { title?: unknown; category?: unknown; severity?: unknown; source?: unknown; [k: string]: unknown }

const DEEP_SEVERITY_WEIGHTS: Record<string, number> = { critical: 25, high: 10, medium: 4, low: 1 };

export async function runDeepScorer(
  targetDir?: string,
  opts: { includeFiles?: Set<string> } = {},
): Promise<ScorerResult> {
  if (!targetDir || !fs.existsSync(targetDir)) return honest('deep', 'The Deep needs a local targetDir');
  if (!deepUrl()) return honest('deep', 'DEEP_URL not set — point it at The Deep server to enable this scorer');

  const files = collectDeepFiles(targetDir, opts);
  if (!files.length) {
    return honest('deep', opts.includeFiles ? 'no changed source files in this diff scope' : 'no scannable source files in target dir');
  }

  // 10MB server body cap — shrink honestly.
  let payload = files;
  let capped = false;
  while (JSON.stringify(payload).length > 9_000_000 && payload.length > 1) {
    payload = payload.slice(0, payload.length - 1);
    capped = true;
  }

  const passes = [
    ['static-analysis', '/api/v1/static-analysis'],
    ['bug-taxonomy', '/api/v1/bug-taxonomy'],
    ['deep-intent', '/api/v1/deep-intent'],
  ] as const;
  const findings: DeepFinding[] = [];
  const failed: string[] = [];
  for (const [label, route] of passes) {
    try {
      const res = await fetch(`${deepUrl()}${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: payload, languageOptions: deepLanguageOptions(), ...deepModelFields() }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) {
        failed.push(`${label} HTTP ${res.status}`);
        continue;
      }
      const body = (await res.json().catch(() => null)) as { findings?: unknown } | null;
      if (Array.isArray(body?.findings)) findings.push(...(body.findings as DeepFinding[]));
      else failed.push(`${label}: no findings array`);
    } catch (err) {
      failed.push(`${label}: ${(err instanceof Error ? err.message : String(err)).slice(0, 80)}`);
    }
  }

  if (!findings.length && failed.length === passes.length) {
    return honest('deep', `The Deep unreachable (${failed.join('; ')})`);
  }

  const counts: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0, other: 0 };
  let penalty = 0;
  for (const f of findings) {
    const sev = String(f?.severity ?? '').toLowerCase();
    if (sev in DEEP_SEVERITY_WEIGHTS) {
      counts[sev] += 1;
      penalty += DEEP_SEVERITY_WEIGHTS[sev];
    } else {
      counts.other += 1;
    }
  }
  // Uncategorized findings are common in a large codebase; count at most 20 so a
  // noisy scan cannot single-handedly zero the grade, and cap the total deduction.
  penalty += Math.min(counts.other, 20);
  const score = Math.max(0, 100 - Math.min(75, penalty));
  const breakdown = formatLanguageBreakdown(payload);
  const note = [capped ? 'payload capped for 10MB limit' : '', failed.length ? `passes failed: ${failed.join('; ')}` : '']
    .filter(Boolean).join(' | ') || undefined;

  return attach({
    scorer: 'deep',
    score,
    summary: `The Deep: ${findings.length} findings across ${payload.length} files (${counts.critical} critical, ${counts.high} high) · ${breakdown.summary}`,
    details: {
      scannedFiles: payload.length,
      totalFindings: findings.length,
      counts,
      languageBreakdown: breakdown,
      sample: findings.slice(0, 10),
      ...(note ? { note } : {}),
    },
  }, {
    findings: findings.map(deepFindingToFinding),
    files: payload.length,
    analyzers: ['deep'],
    language: Object.keys(breakdown.counts).sort().join(','),
    status: failed.length ? 'partial' : 'ok',
  });
}

// ---------------------------------------------------------------------------
// CodeGang — repo-structure analysis (Scout) on a local repoPath. The service
// answers JSON when Accept is not SSE. Score is structural (avg complexity),
// clearly labeled — not a grade.
// ---------------------------------------------------------------------------

export async function runCodeGangScorer(targetDir?: string): Promise<ScorerResult> {
  if (!targetDir || !fs.existsSync(targetDir)) return honest('codegang', 'CodeGang needs a local targetDir (repoPath)');

  // CodeGang guards /api/analyze; it accepts `Authorization: Bearer <SECRET_KEY>`
  // when SECRET_KEY is configured (see its .env.example).
  const cgKey = process.env.CODEGANG_API_KEY || process.env.CODEGANG_SECRET;
  const cgHeaders: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (cgKey) cgHeaders.Authorization = `Bearer ${cgKey}`;
  let res: Response;
  try {
    res = await fetch(`${codegangUrl()}/api/analyze`, {
      method: 'POST',
      headers: cgHeaders,
      body: JSON.stringify({ repoPath: targetDir }),
      signal: AbortSignal.timeout(180_000),
    });
  } catch (err) {
    return honest('codegang', `CodeGang unreachable at ${codegangUrl()} (${err instanceof Error ? err.message : String(err)})`);
  }
  if (!res.ok) return honest('codegang', `CodeGang analyze: HTTP ${res.status}`);

  const body = (await res.json().catch(() => null)) as {
    success?: boolean;
    repoMap?: { files?: Array<{ complexity?: unknown; path?: unknown; file?: unknown; name?: unknown }>; dependencies?: unknown[] };
    message?: string;
  } | null;
  if (!body?.success || !body.repoMap) {
    return honest('codegang', typeof body?.message === 'string' && body.message ? body.message : 'CodeGang analyze returned no repo map');
  }

  const files = Array.isArray(body.repoMap.files) ? body.repoMap.files : [];
  const deps = Array.isArray(body.repoMap.dependencies) ? body.repoMap.dependencies.length : 0;
  const complexities = files.map((f) => (typeof f.complexity === 'number' ? f.complexity : 0));
  const avg = complexities.length ? complexities.reduce((a, b) => a + b, 0) / complexities.length : 0;
  const score = Math.max(0, Math.round(100 - Math.max(0, avg - 10) * 5));

  const findings: Finding[] = [];
  for (const f of files) {
    if (typeof f.complexity !== 'number' || f.complexity <= 20) continue;
    const file = typeof f.path === 'string' ? f.path : typeof f.file === 'string' ? f.file : typeof f.name === 'string' ? f.name : undefined;
    findings.push(makeFinding({
      source: 'codegang',
      dimension: 'architecture',
      category: 'complexity',
      severity: f.complexity > 40 ? 'high' : 'medium',
      confidence: 0.6,
      determinism: 'heuristic',
      ...(file ? { location: { file } } : {}),
      evidence: `cyclomatic complexity ${f.complexity}`,
      remediation: 'Split this unit into smaller functions.',
    }));
  }

  return attach({
    scorer: 'codegang',
    score,
    summary: `CodeGang: ${files.length} files, ${deps} dependencies, avg complexity ${avg.toFixed(1)}`,
    details: { files: files.length, dependencies: deps, avgComplexity: Math.round(avg * 10) / 10 },
  }, { findings, files: files.length, analyzers: ['codegang'] });
}

// ---------------------------------------------------------------------------
// CodeNexus — GitHub-webhook PR review platform (:3205 control plane). There
// is no local-dir review endpoint, so this scorer reports capability, never a
// fabricated grade. (Previously the 'codenexus' type existed but the runner
// silently dropped it — a real gap this now closes.)
// ---------------------------------------------------------------------------

export async function runCodeNexusScorer(params: { repoUrl?: string; targetDir?: string }): Promise<ScorerResult> {
  let serviceUp = false;
  try {
    const res = await fetch(`${codenexusUrl()}/health`, { signal: AbortSignal.timeout(3000) });
    serviceUp = res.ok;
  } catch {
    serviceUp = false;
  }

  if (params.repoUrl) {
    return honest(
      'codenexus',
      serviceUp
        ? 'CodeNexus reviews GitHub PRs via webhooks — direct repo scoring needs a PR through its control plane'
        : 'CodeNexus control plane offline (:3205) — PR review unavailable',
      'CodeNexus: PR review platform (webhook-driven)',
    );
  }
  return honest(
    'codenexus',
    serviceUp
      ? 'CodeNexus reviews GitHub PRs via webhooks — local dirs use deep/codegang/local_qa'
      : 'CodeNexus control plane offline (:3205)',
    'CodeNexus: PR review platform (webhook-driven)',
  );
}

// ---------------------------------------------------------------------------
// Local QA (Benchmark Olympics QA gate) — discover EVERY declared runner
// (root + nested workspaces), run it, and parse its own machine-readable output
// (vitest/jest JSON, pytest JUnit/JSON) for real pass/fail/skip/coverage counts.
// Failures become Findings so they flow into the explorer/reporter. No runner
// detected degrades honestly — never a fabricated 100 or 0.
// ---------------------------------------------------------------------------

const LOCAL_QA_TIMEOUT_MS = Number(process.env.LOCAL_QA_TIMEOUT_MS ?? 120_000);
const LOCAL_QA_COVERAGE_GATE = Number(process.env.LOCAL_QA_COVERAGE_GATE ?? 80);
const LOCAL_QA_MAX_DEPTH = Number(process.env.LOCAL_QA_MAX_DEPTH ?? 2);

/**
 * Local command runner — delegates to the shared Windows-safe process layer
 * (P4/G3). Kept as a thin wrapper so existing call sites keep their 4-arg
 * signature. `mypy` and other real executables run without a shell, so a
 * `--exclude` regex containing `|` is never re-parsed by `cmd`.
 */
function runLocalCommand(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ ok: boolean; code: number | null; output: string; timedOut: boolean }> {
  return runProcessCommand(cmd, args, { cwd, timeoutMs });
}

function outputTail(output: string, lines = 8, chars = 400): string {
  return output.split(/\r?\n/).filter(Boolean).slice(-lines).join(' ').slice(0, chars);
}

const QA_SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'coverage', '__pycache__',
  '.venv', 'venv', 'env', '.turbo', 'vendor', 'target', '.pytest_cache', '.mypy_cache',
]);

export interface TestRunnerSpec {
  runner: 'vitest' | 'jest' | 'npm' | 'pytest';
  cwd: string;
  cmd: string;
  args: string[];
  label: string;
}

function packageTestScript(pkgPath: string): string | undefined {
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8').replace(/^\uFEFF/, ''));
    return typeof pkg?.scripts?.test === 'string' ? pkg.scripts.test : undefined;
  } catch {
    return undefined;
  }
}

function hasPythonTests(dir: string): boolean {
  return ['pyproject.toml', 'requirements.txt', 'pytest.ini', 'tox.ini', 'setup.cfg']
    .some((f) => fs.existsSync(path.join(dir, f)));
}

/**
 * Find every test runner the target declares, root-first then nested workspaces
 * (bounded depth). A repo with a JS suite at the root AND a nested `ui-v2`
 * package gets both — the old first-match logic ran only one and reported a
 * misleading 100/0.
 */
export function discoverTestRunners(targetDir: string): TestRunnerSpec[] {
  const specs: TestRunnerSpec[] = [];
  const walk = (dir: string, depth: number): void => {
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const testScript = packageTestScript(pkgPath);
      if (testScript) {
        const runner: TestRunnerSpec['runner'] = /vitest/.test(testScript)
          ? 'vitest'
          : /jest/.test(testScript) ? 'jest' : 'npm';
        const args = ['test'];
        if (runner === 'vitest') args.push('--', '--run', '--reporter=json');
        else if (runner === 'jest') args.push('--', '--json', '--watchAll=false');
        specs.push({ runner, cwd: dir, cmd: 'npm', args, label: runner === 'npm' ? 'npm test' : `npm test (${runner})` });
      }
    }
    if (hasPythonTests(dir)) {
      specs.push({ runner: 'pytest', cwd: dir, cmd: 'pytest', args: ['-q'], label: 'pytest -q' });
    }
    if (depth >= LOCAL_QA_MAX_DEPTH) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || QA_SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), depth + 1);
    }
  };
  walk(targetDir, 0);
  return specs;
}

interface QaRunnerOutcome {
  spec: TestRunnerSpec;
  ok: boolean;
  code: number | null;
  timedOut: boolean;
  output: string;
  summary: TestSummary | null;
  coveragePct: number | null;
}

async function runOneTestRunner(spec: TestRunnerSpec, index: number): Promise<QaRunnerOutcome> {
  let args = spec.args;
  let junitPath: string | null = null;
  if (spec.runner === 'pytest') {
    junitPath = path.join(os.tmpdir(), `openhub-qa-${process.pid}-${Date.now()}-${index}.xml`);
    args = [...args, `--junitxml=${junitPath}`];
  }
  const run = await runLocalCommand(spec.cmd, args, spec.cwd, LOCAL_QA_TIMEOUT_MS);
  let output = run.output;
  if (junitPath) {
    try {
      if (fs.existsSync(junitPath)) output += `\n${fs.readFileSync(junitPath, 'utf8')}`;
      fs.rmSync(junitPath, { force: true });
    } catch {
      /* junit artifact unreadable — the text output still carries signal */
    }
  }
  const parsed = parseTestOutput(output, spec.runner);
  return {
    spec,
    ok: run.ok,
    code: run.code,
    timedOut: run.timedOut,
    output,
    summary: parsed.summary,
    coveragePct: parsed.coveragePct,
  };
}

export async function runLocalQaScorer(targetDir?: string): Promise<ScorerResult> {
  if (!targetDir || !fs.existsSync(targetDir)) {
    return honest('local_qa', 'local QA needs an existing targetDir (Benchmark Olympics QA gate)');
  }

  const specs = discoverTestRunners(targetDir);
  if (specs.length === 0) {
    const pkgPath = path.join(targetDir, 'package.json');
    if (fs.existsSync(pkgPath)) return honest('local_qa', 'package.json declares no test script');
    return honest('local_qa', 'no test runner detected (no package.json test script, pyproject.toml or requirements.txt)');
  }

  const outcomes: QaRunnerOutcome[] = [];
  for (let i = 0; i < specs.length; i++) outcomes.push(await runOneTestRunner(specs[i], i));

  let total = 0, passed = 0, failed = 0, skipped = 0, xfailed = 0, durationMs = 0;
  let coveragePct: number | null = null;
  const failures: TestFailure[] = [];
  for (const o of outcomes) {
    if (o.summary && o.summary.total > 0) {
      total += o.summary.total;
      passed += o.summary.passed;
      failed += o.summary.failed;
      skipped += o.summary.skipped;
      xfailed += o.summary.xfailed;
      durationMs += o.summary.durationMs ?? 0;
      failures.push(...o.summary.failures);
    } else {
      total += 1;
      if (o.ok) passed += 1;
      else {
        failed += 1;
        failures.push({ name: o.spec.label, message: outputTail(o.output) || `exit ${o.code ?? 'unknown'}` });
      }
    }
    if (coveragePct === null && o.coveragePct != null) coveragePct = o.coveragePct;
    if (coveragePct === null && o.summary?.coveragePct != null) coveragePct = o.summary.coveragePct;
  }

  const combined: TestSummary = {
    runner: 'local_qa',
    total,
    passed,
    failed,
    skipped,
    xfailed,
    durationMs: durationMs || null,
    coveragePct,
    failures,
  };
  const allOk = outcomes.every((o) => o.ok);
  const score = scoreTestSummary(combined, { coverageGatePct: LOCAL_QA_COVERAGE_GATE, exitOk: allOk });

  const labelStr = specs.map((s) => s.label).join(' + ');
  const covNote = coveragePct != null ? `, ${coveragePct}% cov` : '';
  const failNote = failed > 0 ? `, ${failed} failed` : '';
  const detail = `${passed}/${total} passed${failNote}${covNote}`;
  const firstFailure = failures[0];

  const findings = failures.slice(0, 25).map((f) => makeFinding({
    source: 'local_qa',
    dimension: 'tests',
    category: 'test-failure',
    severity: failed > 5 ? 'high' : 'medium',
    confidence: 0.9,
    determinism: 'static',
    ...(f.file ? { location: { file: String(f.file).replace(/\\/g, '/') } } : {}),
    evidence: `${f.name}${f.message ? `: ${f.message}` : ''}`,
    remediation: 'Fix the failing test before shipping.',
  }));

  if (allOk) {
    return attach({
      scorer: 'local_qa',
      score,
      summary: `local QA passed (${labelStr}) — ${detail}`,
      details: { runners: specs.map((s) => ({ runner: s.runner, cwd: s.cwd, label: s.label })), total, passed, failed, skipped, coveragePct },
    }, { findings, files: specs.length, analyzers: specs.map((s) => s.runner), language: specs.some((s) => s.runner === 'pytest') ? 'python' : 'javascript' });
  }

  return attach({
    scorer: 'local_qa',
    score,
    summary: `local QA failed (${labelStr}) — ${detail}`,
    error: firstFailure ? `${firstFailure.name}${firstFailure.message ? `: ${firstFailure.message}` : ''}` : outputTail(outcomes.map((o) => o.output).join('\n')),
    details: { runners: specs.map((s) => ({ runner: s.runner, cwd: s.cwd, label: s.label })), total, passed, failed, skipped, coveragePct },
  }, { findings, files: specs.length, analyzers: specs.map((s) => s.runner), language: specs.some((s) => s.runner === 'pytest') ? 'python' : 'javascript' });
}

// ---------------------------------------------------------------------------
// CMake / C++ — real configure + build + ctest. The audit previously had NO
// native C/C++ signal, so a C++ repo scored only on static/LLM tools. Honest
// no-op (`unavailable`, never a zero) when the target is not a CMake project.
// ---------------------------------------------------------------------------
const CMAKE_TIMEOUT_MS = Number(process.env.AXIOM_CMAKE_TIMEOUT_MS ?? 600_000);

function cmakeFinding(category: string, evidence: string): Finding {
  return makeFinding({
    source: 'cmake',
    dimension: 'build_ci',
    category,
    severity: 'high',
    confidence: 0.9,
    determinism: 'static',
    evidence: evidence || 'cmake build failure',
    remediation: 'Fix the failure reported by CMake/CTest before shipping.',
  });
}

/** CMake build + ctest scorer for C/C++ targets. */
export async function runCmakeScorer(targetDir?: string): Promise<ScorerResult> {
  if (!targetDir || !fs.existsSync(targetDir)) return honest('cmake', 'cmake needs an existing targetDir');
  if (!fs.existsSync(path.join(targetDir, 'CMakeLists.txt'))) {
    return honest('cmake', 'no CMakeLists.txt — not a CMake project');
  }
  const buildDirName = process.env.AXIOM_CMAKE_BUILD_DIR || 'build';
  const buildDir = path.isAbsolute(buildDirName) ? buildDirName : path.join(targetDir, buildDirName);
  const cmakeBin = process.env.AXIOM_CMAKE_CMD || 'cmake';
  const steps: string[] = [];

  // Configure when the build dir is not yet configured.
  if (!fs.existsSync(path.join(buildDir, 'CMakeCache.txt'))) {
    const cfg = await runLocalCommand(cmakeBin, ['-S', targetDir, '-B', buildDir], targetDir, CMAKE_TIMEOUT_MS);
    steps.push(`configure:${cfg.ok ? 'PASS' : 'FAIL'}`);
    if (!cfg.ok) {
      return attach(
        { scorer: 'cmake', score: 0, summary: `cmake configure FAILED (code ${cfg.code ?? '?'}) ${outputTail(cfg.output)}`, details: { steps } },
        { findings: [cmakeFinding('cmake-configure-failed', outputTail(cfg.output, 12, 600))], analyzers: ['cmake'], status: 'ok' },
      );
    }
  }

  const build = await runLocalCommand(cmakeBin, ['--build', buildDir], targetDir, CMAKE_TIMEOUT_MS);
  steps.push(`build:${build.ok ? 'PASS' : 'FAIL'}`);
  if (!build.ok) {
    return attach(
      { scorer: 'cmake', score: 0, summary: `cmake build FAILED (code ${build.code ?? '?'}) ${outputTail(build.output)}`, details: { steps } },
      { findings: [cmakeFinding('cmake-build-failed', outputTail(build.output, 12, 600))], analyzers: ['cmake'], status: 'ok' },
    );
  }

  if (fs.existsSync(path.join(buildDir, 'CTestTestfile.cmake'))) {
    const ctest = await runLocalCommand('ctest', ['--test-dir', buildDir, '--output-on-failure'], targetDir, CMAKE_TIMEOUT_MS);
    steps.push(`ctest:${ctest.ok ? 'PASS' : 'FAIL'}`);
    if (!ctest.ok) {
      return attach(
        { scorer: 'cmake', score: 30, summary: `cmake build: PASS · ctest: FAILED (code ${ctest.code ?? '?'}) ${outputTail(ctest.output)}`, details: { steps } },
        { findings: [cmakeFinding('ctest-failed', outputTail(ctest.output, 12, 600))], analyzers: ['cmake', 'ctest'], status: 'ok' },
      );
    }
    return attach(
      { scorer: 'cmake', score: 100, summary: `cmake build: PASS · ctest: PASS ${outputTail(ctest.output)}`, details: { steps } },
      { analyzers: ['cmake', 'ctest'], status: 'ok' },
    );
  }
  return attach(
    { scorer: 'cmake', score: 80, summary: `cmake build: PASS (no CTest tests enabled) ${outputTail(build.output)}`, details: { steps } },
    { analyzers: ['cmake'], status: 'ok' },
  );
}

// ---------------------------------------------------------------------------
// Typecheck — compiler/type-checker errors from `tsc --noEmit` (TS) or
// mypy/pyright (Python), normalized into build_ci/correctness findings.
// ---------------------------------------------------------------------------

const TYPECHECK_TIMEOUT_MS = Number(
  process.env.TYPECHECK_TIMEOUT_MS ?? process.env.OPENHUB_TYPECHECK_TIMEOUT_MS ?? 300_000,
);

const TSC_ERROR_RE = /^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.*)$/gm;

export function parseTscOutput(output: string, targetDir: string): Finding[] {
  const findings: Finding[] = [];
  for (const m of output.matchAll(TSC_ERROR_RE)) {
    const file = path.relative(targetDir, path.resolve(targetDir, m[1])).replace(/\\/g, '/');
    findings.push(makeFinding({
      source: 'typecheck',
      dimension: 'build_ci',
      category: 'type-error',
      severity: 'medium',
      confidence: 0.95,
      determinism: 'static',
      location: { file: file.startsWith('..') ? m[1] : file, line: Number(m[2]) },
      evidence: `${m[4]}: ${m[5]}`,
      remediation: 'Fix the type error reported by the compiler.',
    }));
  }
  return findings;
}

const MYPY_ERROR_RE = /^(.+?):(\d+):(?:\d+:)?\s+error:\s+(.*)$/gm;

export function parseMypyOutput(output: string, targetDir: string): Finding[] {
  const findings: Finding[] = [];
  for (const m of output.matchAll(MYPY_ERROR_RE)) {
    const file = path.relative(targetDir, path.resolve(targetDir, m[1])).replace(/\\/g, '/');
    findings.push(makeFinding({
      source: 'typecheck',
      dimension: 'build_ci',
      category: 'type-error',
      severity: 'medium',
      confidence: 0.9,
      determinism: 'static',
      location: { file: file.startsWith('..') ? m[1] : file, line: Number(m[2]) },
      evidence: m[3],
      remediation: 'Fix the type error reported by mypy.',
    }));
  }
  return findings;
}

/**
 * Dirs mypy must not descend into. Without this, a duplicate module under
 * e.g. `backups/` (two `run_benchmark.py`) aborts the whole run with
 * "Duplicate module named …" and the typecheck scorer goes null.
 */
const MYPY_EXCLUDE =
  '(^|[\\\\/])(backups|node_modules|\\.venv|venv|env|__pycache__|build|dist|\\.tox|\\.eggs|\\.mypy_cache|\\.pytest_cache|release|target|out)([\\\\/]|$)';

/**
 * In diff mode, restrict findings to the changed files (E1). Findings with no
 * location are kept — a scanner that could not attribute an issue should not
 * have it silently hidden.
 */
export function scopeFindings(findings: Finding[], includeFiles?: Set<string>): Finding[] {
  if (!includeFiles) return findings;
  return findings.filter((f) => !f.location?.file || includeFiles.has(f.location.file));
}

export async function runTypecheckScorer(
  targetDir?: string,
  opts: { includeFiles?: Set<string> } = {},
): Promise<ScorerResult> {
  if (!targetDir || !fs.existsSync(targetDir)) return honest('typecheck', 'typecheck needs a local targetDir');

  const tsconfig = path.join(targetDir, 'tsconfig.json');
  if (fs.existsSync(tsconfig)) {
    const run = await runLocalCommand('npx', ['--no-install', 'tsc', '--noEmit', '--pretty', 'false'], targetDir, TYPECHECK_TIMEOUT_MS);
    const all = parseTscOutput(run.output, targetDir);
    const findings = scopeFindings(all, opts.includeFiles);
    const scoped = opts.includeFiles ? ` in changed files (of ${all.length} total)` : '';
    if (findings.length > 0) {
      const score = Math.max(0, 100 - Math.min(80, findings.length * 2));
      return attach(
        { scorer: 'typecheck', score, summary: `tsc: ${findings.length} type error${findings.length === 1 ? '' : 's'}${scoped}`, details: { runner: 'tsc', errors: findings.length, totalErrors: all.length } },
        { findings, dimensions: ['build_ci', 'correctness'], analyzers: ['tsc'] },
      );
    }
    if (all.length > 0 && opts.includeFiles) {
      return attach(
        { scorer: 'typecheck', score: 100, summary: `tsc: no type errors in changed files (${all.length} elsewhere)`, details: { runner: 'tsc', errors: 0, totalErrors: all.length } },
        { findings: [], dimensions: ['build_ci', 'correctness'], analyzers: ['tsc'] },
      );
    }
    if (run.timedOut) return honest('typecheck', `tsc timed out after ${TYPECHECK_TIMEOUT_MS}ms`);
    if (run.ok) {
      return attach(
        { scorer: 'typecheck', score: 100, summary: 'tsc --noEmit: no type errors', details: { runner: 'tsc', errors: 0 } },
        { findings: [], dimensions: ['build_ci', 'correctness'], analyzers: ['tsc'] },
      );
    }
    if (/not recognized|ENOENT|Cannot find module 'typescript'|command failed/i.test(run.output)) {
      return honest('typecheck', 'tsc is not installed locally (npm i -D typescript)');
    }
    return honest('typecheck', outputTail(run.output) || 'tsc produced no parseable output');
  }

  const mypyConfigured = ['mypy.ini', '.mypy.ini', 'pyrightconfig.json'].some((f) => fs.existsSync(path.join(targetDir, f)))
    || hasPythonTests(targetDir);
  if (mypyConfigured) {
    const run = await runLocalCommand('mypy', ['.', '--no-error-summary', '--show-column-numbers', '--exclude', MYPY_EXCLUDE], targetDir, TYPECHECK_TIMEOUT_MS);
    const all = parseMypyOutput(run.output, targetDir);
    const findings = scopeFindings(all, opts.includeFiles);
    const scoped = opts.includeFiles ? ` in changed files (of ${all.length} total)` : '';
    if (findings.length > 0) {
      const score = Math.max(0, 100 - Math.min(80, findings.length * 2));
      return attach(
        { scorer: 'typecheck', score, summary: `mypy: ${findings.length} type error${findings.length === 1 ? '' : 's'}${scoped}`, details: { runner: 'mypy', errors: findings.length, totalErrors: all.length } },
        { findings, dimensions: ['build_ci', 'correctness'], analyzers: ['mypy'] },
      );
    }
    if (all.length > 0 && opts.includeFiles) {
      return attach(
        { scorer: 'typecheck', score: 100, summary: `mypy: no type errors in changed files (${all.length} elsewhere)`, details: { runner: 'mypy', errors: 0, totalErrors: all.length } },
        { findings: [], dimensions: ['build_ci', 'correctness'], analyzers: ['mypy'] },
      );
    }
    if (run.ok) {
      return attach(
        { scorer: 'typecheck', score: 100, summary: 'mypy: no type errors', details: { runner: 'mypy', errors: 0 } },
        { findings: [], dimensions: ['build_ci', 'correctness'], analyzers: ['mypy'] },
      );
    }
    if (/not recognized|no module named|ENOENT|command not found/i.test(run.output)) {
      return honest('typecheck', 'mypy is not installed');
    }
    return honest('typecheck', outputTail(run.output) || 'mypy produced no parseable output');
  }

  return honest('typecheck', 'no tsconfig.json, mypy.ini or pyrightconfig.json detected');
}

// ---------------------------------------------------------------------------
// Lint — eslint (JSON) for JS/TS, ruff/flake8 for Python. Findings are
// maintainability-tier; an unconfigured/uninstalled linter degrades honestly.
// ---------------------------------------------------------------------------

const LINT_TIMEOUT_MS = Number(process.env.LINT_TIMEOUT_MS ?? 180_000);

const ESLINT_CONFIGS = ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', '.eslintrc', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', '.eslintrc.yml', '.eslintrc.yaml'];

export function parseEslintJson(json: unknown, targetDir: string): Finding[] {
  if (!Array.isArray(json)) return [];
  const findings: Finding[] = [];
  for (const file of json) {
    if (!file || typeof file !== 'object') continue;
    const rec = file as Record<string, unknown>;
    const filePath = typeof rec.filePath === 'string' ? rec.filePath : '';
    const rel = filePath ? path.relative(targetDir, filePath).replace(/\\/g, '/') : '';
    const messages = Array.isArray(rec.messages) ? rec.messages : [];
    for (const msg of messages) {
      if (!msg || typeof msg !== 'object') continue;
      const m = msg as Record<string, unknown>;
      const severityNum = typeof m.severity === 'number' ? m.severity : 1;
      findings.push(makeFinding({
        source: 'lint',
        dimension: 'maintainability',
        category: `lint:${typeof m.ruleId === 'string' && m.ruleId ? m.ruleId : 'eslint'}`,
        severity: severityNum >= 2 ? 'medium' : 'low',
        confidence: 0.8,
        determinism: 'static',
        ...(rel ? { location: { file: rel, ...(typeof m.line === 'number' ? { line: m.line } : {}) } } : {}),
        evidence: String(m.message ?? 'lint problem'),
        remediation: typeof m.ruleId === 'string' && m.ruleId
          ? `Resolve ${m.ruleId} at the reported location (run eslint --fix where applicable).`
          : 'Resolve the lint problem at the reported location.',
      }));
    }
  }
  return findings;
}

const RUFF_RE = /^(.+?):(\d+):(\d+):\s+(\S+)\s+(.*)$/gm;
const FLAKE8_RE = /^(.+?):(\d+):(\d+):\s+([A-Z]\d+)\s+(.*)$/gm;

export function parseRuffText(output: string, targetDir: string): Finding[] {
  const findings: Finding[] = [];
  for (const m of output.matchAll(RUFF_RE)) {
    const file = path.relative(targetDir, path.resolve(targetDir, m[1])).replace(/\\/g, '/');
    findings.push(makeFinding({
      source: 'lint',
      dimension: 'maintainability',
      category: `lint:${m[4]}`,
      severity: m[4].startsWith('E9') || m[4].startsWith('F8') ? 'medium' : 'low',
      confidence: 0.8,
      determinism: 'static',
      location: { file: file.startsWith('..') ? m[1] : file, line: Number(m[2]) },
      evidence: m[5],
      remediation: `Resolve rule ${m[4]} at the reported location.`,
    }));
  }
  return findings;
}

export function parseFlake8Text(output: string, targetDir: string): Finding[] {
  const findings: Finding[] = [];
  for (const m of output.matchAll(FLAKE8_RE)) {
    const file = path.relative(targetDir, path.resolve(targetDir, m[1])).replace(/\\/g, '/');
    findings.push(makeFinding({
      source: 'lint',
      dimension: 'maintainability',
      category: `lint:${m[4]}`,
      severity: m[4].startsWith('E9') || m[4].startsWith('F8') ? 'medium' : 'low',
      confidence: 0.8,
      determinism: 'static',
      location: { file: file.startsWith('..') ? m[1] : file, line: Number(m[2]) },
      evidence: m[5],
      remediation: `Resolve rule ${m[4]} at the reported location.`,
    }));
  }
  return findings;
}

function lintScore(findings: Finding[]): number {
  const penalty = findings.reduce((s, f) => s + (f.severity === 'medium' ? 2 : 1), 0);
  return Math.max(0, 100 - Math.min(80, penalty));
}

export async function runLintScorer(
  targetDir?: string,
  opts: { includeFiles?: Set<string> } = {},
): Promise<ScorerResult> {
  if (!targetDir || !fs.existsSync(targetDir)) return honest('lint', 'lint needs a local targetDir');

  if (ESLINT_CONFIGS.some((f) => fs.existsSync(path.join(targetDir, f)))) {
    const run = await runLocalCommand('npx', ['--no-install', 'eslint', '--format', 'json', '.'], targetDir, LINT_TIMEOUT_MS);
    const jsonStart = run.output.indexOf('[');
    if (jsonStart !== -1) {
      try {
        const parsed = JSON.parse(run.output.slice(jsonStart));
        const all = parseEslintJson(parsed, targetDir);
        const findings = scopeFindings(all, opts.includeFiles);
        return attach(
          { scorer: 'lint', score: lintScore(findings), summary: `eslint: ${findings.length} problem${findings.length === 1 ? '' : 's'}${opts.includeFiles ? ` in changed files (of ${all.length})` : ''}`, details: { runner: 'eslint', problems: findings.length, totalProblems: all.length } },
          { findings, dimensions: ['maintainability'], analyzers: ['eslint'], status: run.ok ? 'ok' : 'partial' },
        );
      } catch {
        /* not JSON — fall through to the tool-unavailable checks */
      }
    }
    if (/not recognized|ENOENT|Cannot find module|command failed/i.test(run.output)) {
      return honest('lint', 'eslint is not installed locally');
    }
    return honest('lint', outputTail(run.output) || 'eslint produced no parseable output');
  }

  const ruffConfigured = fs.existsSync(path.join(targetDir, 'ruff.toml'))
    || fs.existsSync(path.join(targetDir, '.ruff.toml'))
    || hasPythonTests(targetDir);
  const flake8Configured = fs.existsSync(path.join(targetDir, '.flake8'))
    || fs.existsSync(path.join(targetDir, 'setup.cfg'));

  if (ruffConfigured) {
    const run = await runLocalCommand('ruff', ['check', '.', '--output-format=concise'], targetDir, LINT_TIMEOUT_MS);
    const all = parseRuffText(run.output, targetDir);
    const findings = scopeFindings(all, opts.includeFiles);
    if (findings.length > 0) {
      return attach(
        { scorer: 'lint', score: lintScore(findings), summary: `ruff: ${findings.length} problem${findings.length === 1 ? '' : 's'}${opts.includeFiles ? ` in changed files (of ${all.length})` : ''}`, details: { runner: 'ruff', problems: findings.length, totalProblems: all.length } },
        { findings, dimensions: ['maintainability'], analyzers: ['ruff'], status: 'ok' },
      );
    }
    if (run.ok || (all.length > 0 && opts.includeFiles)) {
      return attach(
        { scorer: 'lint', score: 100, summary: opts.includeFiles ? `ruff: no problems in changed files (${all.length} elsewhere)` : 'ruff: no problems', details: { runner: 'ruff', problems: 0, totalProblems: all.length } },
        { findings: [], dimensions: ['maintainability'], analyzers: ['ruff'] },
      );
    }
    if (/not recognized|ENOENT|No module named|command not found/i.test(run.output) === false) {
      return honest('lint', outputTail(run.output) || 'ruff produced no parseable output');
    }
  }

  if (flake8Configured) {
    const run = await runLocalCommand('flake8', ['.'], targetDir, LINT_TIMEOUT_MS);
    const all = parseFlake8Text(run.output, targetDir);
    const findings = scopeFindings(all, opts.includeFiles);
    if (findings.length > 0) {
      return attach(
        { scorer: 'lint', score: lintScore(findings), summary: `flake8: ${findings.length} problem${findings.length === 1 ? '' : 's'}${opts.includeFiles ? ` in changed files (of ${all.length})` : ''}`, details: { runner: 'flake8', problems: findings.length, totalProblems: all.length } },
        { findings, dimensions: ['maintainability'], analyzers: ['flake8'] },
      );
    }
  }

  return honest('lint', 'no eslint, ruff or flake8 config detected');
}

// ---------------------------------------------------------------------------
// Software Composition Analysis (SCA) — dependency CVEs via Claw's trivy
// backend. This is the dependency-CVE leg the audit otherwise lacks: the
// graders only *infer* security from the file list, so known-vulnerable
// dependencies went undetected. Claw owns the trivy subprocess; we normalize
// its scan into a real count. Unavailable backend = honest skip, never a 0.
// ---------------------------------------------------------------------------

export async function runScaScorer(targetDir?: string): Promise<ScorerResult> {
  const apiKey = process.env.CLAW_PROTECT_SYSTEM_AGENT_KEY;
  if (!apiKey) return honest('sca', 'CLAW_PROTECT_SYSTEM_AGENT_KEY not set — dependency CVE scan skipped');
  if (!targetDir || !fs.existsSync(targetDir)) {
    return honest('sca', 'dependency CVE scan needs an existing targetDir');
  }
  const res = await postJson(
    `${CLAW_URL.replace(/\/+$/, '')}/api/v1/sca/scan-dir`,
    { path: targetDir },
    { Authorization: `Bearer ${apiKey}` },
    320_000,
  );
  if (!res.ok) return honest('sca', res.json?.error || res.error || `HTTP ${res.status}`);
  const j = res.json ?? {};
  if (j.available === false) {
    return honest('sca', (Array.isArray(j.errors) && j.errors[0]) || 'SCA backend (trivy) not installed on the Claw host');
  }
  const crit = Number(j.criticalCount) || 0;
  const high = Number(j.highCount) || 0;
  const med = Number(j.mediumCount) || 0;
  const low = Number(j.lowCount) || 0;
  const total = Number(j.totalVulnerabilities) || crit + high + med + low;
  const secrets = Number(j.secretsCount) || 0;
  const misconfig = Number(j.misconfigCount) || 0;
  const score = Math.max(0, 100 - (crit * 25 + high * 10 + med * 4 + low + secrets * 8 + misconfig * 2));
  const parts = [`${total} CVE(s)`, `crit ${crit}`, `high ${high}`, `med ${med}`, `low ${low}`];
  if (secrets) parts.push(`${secrets} secret(s)`);
  if (misconfig) parts.push(`${misconfig} misconfig(s)`);

  const vulns = Array.isArray(j.vulnerabilities) ? j.vulnerabilities : [];
  const findings: Finding[] = vulns.flatMap((v: any): Finding[] => {
    if (!v || typeof v !== 'object') return [];
    const cve = typeof v.VulnerabilityID === 'string' ? v.VulnerabilityID : undefined;
    const pkg = typeof v.PkgName === 'string' ? v.PkgName : undefined;
    const target = typeof v.Target === 'string' ? v.Target : undefined;
    return [makeFinding({
      source: 'sca',
      dimension: 'dependencies',
      category: 'cve',
      severity: String(v.Severity ?? 'medium'),
      confidence: 0.9,
      determinism: 'static',
      ...(target ? { location: { file: target } } : {}),
      evidence: `${cve ?? 'CVE'}${pkg ? ` in ${pkg}` : ''}${v.Title ? `: ${v.Title}` : ''}`,
      remediation: typeof v.FixedVersion === 'string' && v.FixedVersion ? `Upgrade to ${v.FixedVersion}` : 'Upgrade the affected dependency.',
      ...(cve ? { cve } : {}),
    })];
  });

  return attach({
    scorer: 'sca',
    score,
    summary: parts.join(' · '),
    details: {
      vulnerabilities: vulns.slice(0, 50),
      secretsCount: secrets,
      misconfigCount: misconfig,
    },
  }, { findings, dimensions: ['dependencies', 'security'], analyzers: ['trivy'] });
}

// ---------------------------------------------------------------------------
// SonarQube Community Build — server-side quality gate + failed conditions.
// SonarQube is not a local scanner: it needs a running server (SONAR_URL) and a
// token (SONAR_TOKEN), and the project must already have been analyzed. This
// scorer reads the existing project status; it never invents a verdict.
// ---------------------------------------------------------------------------

function sonarProjectKey(targetDir?: string): string | null {
  const fromEnv = process.env.SONAR_PROJECT_KEY;
  if (fromEnv) return fromEnv;
  if (!targetDir) return null;
  try {
    const raw = fs.readFileSync(path.join(targetDir, 'package.json'), 'utf8').replace(/^\uFEFF/, '');
    const pkg = JSON.parse(raw) as { name?: unknown };
    return typeof pkg.name === 'string' && pkg.name ? pkg.name : null;
  } catch {
    return null;
  }
}

const SONAR_SCAN_TIMEOUT_MS = Number(process.env.SONAR_SCAN_TIMEOUT_MS ?? 600_000);
const SONAR_CE_POLL_TIMEOUT_MS = Number(process.env.SONAR_CE_POLL_TIMEOUT_MS ?? 300_000);

/** A fresh server scan is how the gate gets something new to report. Disabled with SONAR_SCAN=0. */
function sonarScanEnabled(): boolean {
  return process.env.SONAR_SCAN !== '0';
}

function sonarScannerCmd(): string {
  return process.env.SONAR_SCANNER_CMD || 'sonar-scanner';
}

/** ceTaskId from the scanner's report-task.txt (SonarQube's receipt for the submitted analysis). */
function readCeTaskId(targetDir: string): string | null {
  try {
    const txt = fs.readFileSync(path.join(targetDir, '.scannerwork', 'report-task.txt'), 'utf8');
    const m = txt.match(/^ceTaskId=(.+)$/m);
    return m && m[1] ? m[1].trim() : null;
  } catch {
    return null;
  }
}

/** Wait for the Compute Engine task to finish so the gate reflects THIS scan. */
async function waitForCeTask(
  base: string,
  auth: Record<string, string>,
  taskId: string,
): Promise<'SUCCESS' | 'FAILED' | 'PENDING'> {
  const deadline = Date.now() + SONAR_CE_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const t = await getJson(`${base}/api/ce/task?id=${encodeURIComponent(taskId)}`, auth, 15_000);
    const status = (t.json as { task?: { status?: string } } | null)?.task?.status;
    if (status === 'SUCCESS') return 'SUCCESS';
    if (status === 'FAILED' || status === 'CANCELED') return 'FAILED';
    await sleep(3000);
  }
  return 'PENDING';
}

export async function runSonarQubeScorer(targetDir?: string): Promise<ScorerResult> {
  const base = (process.env.SONAR_URL || '').replace(/\/+$/, '');
  const token = process.env.SONAR_TOKEN;
  if (!base || !token) {
    return honest('sonarqube', 'SONAR_URL/SONAR_TOKEN not set — SonarQube not configured');
  }
  const projectKey = sonarProjectKey(targetDir ?? undefined);
  if (!projectKey) {
    return honest('sonarqube', 'no SonarQube project key (set SONAR_PROJECT_KEY or add a package.json name)');
  }
  const auth = { Authorization: `Bearer ${token}` };

  // Optional scan pass: run sonar-scanner so the gate below reflects the
  // current tree, not the last CI analysis. The receipt ceTaskId is then
  // polled until the server finishes processing this scan.
  let scanNote = '';
  const localDir = typeof targetDir === 'string' && targetDir && fs.existsSync(targetDir) ? targetDir : null;
  if (sonarScanEnabled() && localDir) {
    const run = await runProcessCommand(
      sonarScannerCmd(),
      [
        `-Dsonar.host.url=${base}`,
        `-Dsonar.token=${token}`,
        `-Dsonar.projectKey=${projectKey}`,
        '-Dsonar.sources=.',
      ],
      { cwd: localDir, timeoutMs: SONAR_SCAN_TIMEOUT_MS },
    );
    if (/not recognized|ENOENT|command not found|Cannot find module/i.test(run.output) || run.code === 127) {
      scanNote = 'sonar-scanner not installed — gate reflects the last server analysis';
    } else if (!run.ok) {
      scanNote = `sonar scan failed (${outputTail(run.output)}) — gate reflects the last server analysis`;
    } else {
      const taskId = readCeTaskId(localDir);
      if (!taskId) {
        scanNote = 'scan uploaded but no ceTaskId receipt found — gate may lag this scan';
      } else {
        const done = await waitForCeTask(base, auth, taskId);
        scanNote =
          done === 'SUCCESS'
            ? `scan analyzed (ceTask ${taskId.slice(0, 8)}…); gate below is current`
            : done === 'FAILED'
              ? `server-side analysis failed (ceTask ${taskId.slice(0, 8)}…) — gate may be stale`
              : `scan uploaded; server analysis still pending after ${Math.round(SONAR_CE_POLL_TIMEOUT_MS / 1000)}s — gate may lag this scan`;
      }
    }
  } else if (sonarScanEnabled()) {
    scanNote = 'no local target dir — gate reflects the last server analysis';
  }
  const qg = await getJson(
    `${base}/api/qualitygates/project_status?projectKey=${encodeURIComponent(projectKey)}`,
    auth,
    30_000,
  );
  if (!qg.ok) {
    return honest('sonarqube', `quality gate query failed: ${qg.error || `HTTP ${qg.status}`}`);
  }
  const status = qg.json?.projectStatus?.status as string | undefined;
  if (!status || status === 'NONE') {
    return honest('sonarqube', `project "${projectKey}" has no analysis on the SonarQube server yet`);
  }

  interface SonarCondition {
    metricKey?: string;
    status?: string;
    actualValue?: string;
    errorThreshold?: string;
  }
  const conditions: SonarCondition[] = Array.isArray(qg.json?.projectStatus?.conditions)
    ? (qg.json.projectStatus.conditions as SonarCondition[])
    : [];
  const failed = conditions.filter((c) => c.status && c.status !== 'OK');
  const score = status === 'OK' ? 100 : status === 'WARN' ? 70 : 40;

  const findings: Finding[] = failed.map((c) =>
    makeFinding({
      source: 'sonarqube',
      dimension: 'maintainability',
      category: `sonar:${c.metricKey ?? 'condition'}`,
      severity: status === 'ERROR' ? 'high' : 'medium',
      confidence: 0.9,
      determinism: 'static',
      evidence: `${c.metricKey ?? 'metric'} = ${c.actualValue ?? '?'} (error threshold ${c.errorThreshold ?? '?'})`,
    }),
  );

  return attach(
    {
      scorer: 'sonarqube',
      score,
      summary: `SonarQube gate ${status} for ${projectKey} (${failed.length} failed condition${failed.length === 1 ? '' : 's'})${scanNote ? ` · ${scanNote}` : ''}`,
      details: { projectKey, status, conditions, ...(scanNote ? { scan: scanNote } : {}) },
    },
    { findings, dimensions: ['maintainability', 'security'], analyzers: ['sonarqube'] },
  );
}

// ---------------------------------------------------------------------------
// Code-root detection — when the loaded project path is a PARENT of the real
// repo (e.g. a wrapper folder around `Comic Metaphor Logic/`), every local
// scorer silently degraded (claw found no files; codegraph found no git repo).
// Walk down (bounded) to the nearest dir carrying `.git`/a manifest and use it.
// ---------------------------------------------------------------------------

const CODE_ROOT_MARKERS = ['.git', 'package.json', 'pyproject.toml', 'requirements.txt', 'go.mod', 'Cargo.toml', 'pom.xml'];
const CODE_ROOT_SKIP = new Set(['node_modules', '.git', 'dist', '.next', 'build', '__pycache__', '.venv', 'venv', 'env', '.idea']);

export function resolveCodeRoot(targetDir: string): string {
  const hasMarker = (d: string) => CODE_ROOT_MARKERS.some((m) => fs.existsSync(path.join(d, m)));
  if (hasMarker(targetDir)) return targetDir;
  let best: string | null = null;
  let bestScore = -1;
  const walk = (dir: string, depth: number): void => {
    if (depth > 3) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || CODE_ROOT_SKIP.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (hasMarker(p)) {
        const score = fs.existsSync(path.join(p, '.git')) ? 2 : 1;
        if (score > bestScore) { best = p; bestScore = score; }
      } else {
        walk(p, depth + 1);
      }
    }
  };
  walk(targetDir, 0);
  return best ?? targetDir;
}

// ---------------------------------------------------------------------------
// Audit presets + lifecycle stages.
//
// The suite is never "all tools live all the time": callers ask for a preset
// (depth) or a build stage (preset + gate + learning). Explicit `scorers`
// always win over a preset; a stage always implies its preset unless scorers
// are explicit. Stage-driven runs always feed the learning loop; merge/nightly/
// release stages additionally index into Recourse memory so the audit team can
// see (and improve) what the gates actually catch over time.
// ---------------------------------------------------------------------------

export type AuditPresetName = 'quick' | 'standard' | 'deep' | 'release';

export interface AuditPreset {
  scorers: ScorerName[];
  full: boolean;
  description: string;
}

/** The default (full) scorer set. Exported so tests assert against the real
 *  list instead of a magic count that drifts when a scorer is added. */
export const DEFAULT_AUDIT_SCORERS: ScorerName[] = [
  'reporank', 'grader', 'claw', 'sca', 'codegraph', 'ocr',
  'deep', 'codegang', 'local_qa', 'typecheck', 'lint',
  'deps_freshness', 'licenses_sbom', 'duplication', 'perf',
  'a11y', 'api_contract', 'git_history', 'iac', 'sonarqube', 'cmake',
];

export const AUDIT_PRESETS: Record<AuditPresetName, AuditPreset> = {
  quick: {
    scorers: ['typecheck', 'lint', 'git_history', 'deps_freshness'],
    full: false,
    description: 'Per-commit gates: compilers, linters, committed secrets, stale deps.',
  },
  standard: {
    scorers: [
      'reporank', 'grader', 'deep', 'sca', 'codegraph', 'ocr',
      'local_qa', 'typecheck', 'lint', 'deps_freshness', 'licenses_sbom',
      'duplication', 'git_history', 'iac', 'cmake',
    ],
    full: false,
    description: 'PR review: LLM grades, SAST, SCA, tests, quality — diff-scoped when possible.',
  },
  deep: {
    scorers: [...DEFAULT_AUDIT_SCORERS],
    full: false,
    description: 'Full suite, diff-scoped when possible.',
  },
  release: {
    scorers: [...DEFAULT_AUDIT_SCORERS],
    full: true,
    description: 'Pre-release: full-tree, everything including SonarQube and licenses.',
  },
};

export type AuditStageName = 'pre-commit' | 'pr' | 'merge' | 'nightly' | 'release';

export interface AuditStage {
  preset: AuditPresetName;
  /** Minimum reconciled score to pass. `null` = advisory: recorded, never blocks. */
  minScore: number | null;
  /** Whether a stage run is also indexed into Recourse memory (infrequent, high-signal only). */
  memory: boolean;
  description: string;
}

export const AUDIT_STAGES: Record<AuditStageName, AuditStage> = {
  'pre-commit': {
    preset: 'quick',
    minScore: 60,
    memory: false,
    description: 'Every commit must compile, lint clean, and add no secrets.',
  },
  pr: {
    preset: 'standard',
    minScore: 70,
    memory: false,
    description: 'PRs are reviewed, scanned, and tested before human review.',
  },
  merge: {
    preset: 'deep',
    minScore: 70,
    memory: true,
    description: 'Merges run the full suite across the change; outcomes teach the learner.',
  },
  nightly: {
    preset: 'deep',
    minScore: null,
    memory: true,
    description: 'Scheduled sweep is informational — it feeds the learner, never blocks.',
  },
  release: {
    preset: 'release',
    minScore: 80,
    memory: true,
    description: 'Releases require a full-tree pass at release quality.',
  },
};

export interface AuditGate {
  stage: AuditStageName;
  preset: AuditPresetName;
  pass: boolean;
  advisory: boolean;
  minScore: number | null;
  reason: string;
}

/** Scorers whose absence leaves a security blind spot. A plan that includes one
 *  and gets `unavailable` fails closed, so "green" can never come from a missing
 *  scanner. Override with AUDIT_REQUIRE_SCORERS (comma list); empty disables. */
export const DEFAULT_REQUIRED_SCORERS: ScorerName[] = ['sca', 'claw'];

export function resolveRequiredScorers(explicit?: ScorerName[], env: NodeJS.ProcessEnv = process.env): ScorerName[] {
  if (explicit) return explicit;
  const raw = env.AUDIT_REQUIRE_SCORERS;
  if (raw === undefined) return DEFAULT_REQUIRED_SCORERS;
  return raw.split(',').map((s) => s.trim()).filter(Boolean) as ScorerName[];
}

export interface AuditGateInputs {
  /** Deduplicated critical-severity findings — a critical finding fails the gate. */
  criticalFindings?: number;
  /** Required scorers that were in the plan but unavailable. */
  requiredUnavailableScorers?: string[];
}

export interface AuditPlan {
  scorers: ScorerName[];
  full: boolean;
  preset: AuditPresetName | null;
  stage: AuditStageName | null;
}

/** Resolve explicit scorers > preset > stage preset > full suite. Pure and unit-testable. */
export function resolveAuditPlan(
  params: Pick<AuditRunParams, 'scorers' | 'full' | 'preset' | 'stage'>,
): AuditPlan {
  const stage = params.stage && AUDIT_STAGES[params.stage] ? params.stage : null;
  const preset =
    params.preset && AUDIT_PRESETS[params.preset]
      ? params.preset
      : stage
        ? AUDIT_STAGES[stage].preset
        : null;
  return {
    scorers: params.scorers ?? (preset ? [...AUDIT_PRESETS[preset].scorers] : [...DEFAULT_AUDIT_SCORERS]),
    full: params.full ?? (preset ? AUDIT_PRESETS[preset].full : false),
    preset,
    stage,
  };
}

/** Evaluate a stage gate against a reconciled score. A missing score fails
 *  closed; advisory stages never block. Two hard conditions override the score
 *  even on a high-scoring run: any critical finding, and any required scorer
 *  that was unavailable (so a blind spot can never read as a pass). */
export function evaluateAuditGate(
  overallScore: number | null,
  stage: AuditStageName | null,
  inputs: AuditGateInputs = {},
): AuditGate | null {
  if (!stage || !AUDIT_STAGES[stage]) return null;
  const def = AUDIT_STAGES[stage];
  const critical = inputs.criticalFindings ?? 0;
  const reqMissing = inputs.requiredUnavailableScorers ?? [];
  const hardReason =
    critical > 0
      ? `${critical} critical finding(s) — gate fails closed`
      : reqMissing.length
        ? `required scorer(s) unavailable: ${reqMissing.join(', ')} — gate fails closed`
        : null;
  if (def.minScore === null) {
    return {
      stage,
      preset: def.preset,
      pass: overallScore !== null,
      advisory: true,
      minScore: null,
      reason: `advisory stage: outcome recorded for the learner, never blocks${hardReason ? ` (${hardReason})` : ''}`,
    };
  }
  const scorePass = overallScore !== null && overallScore >= def.minScore;
  const pass = scorePass && hardReason === null;
  return {
    stage,
    preset: def.preset,
    pass,
    advisory: false,
    minScore: def.minScore,
    reason:
      hardReason ??
      (overallScore === null
        ? 'no score produced — gate fails closed'
        : scorePass
          ? `score ${overallScore} ≥ gate ${def.minScore}`
          : `score ${overallScore} < gate ${def.minScore}`),
  };
}

// ---------------------------------------------------------------------------
// Suite runner — only real scorer outputs are aggregated. A scorer that could
// not run contributes an error, never a number.
// ---------------------------------------------------------------------------

export async function executeAuditSuite(params: AuditRunParams): Promise<AuditReport> {
  const target = params.repoUrl || params.targetDir || process.cwd();
  // Evidence spine: everything spawned below is receipted and tagged to this
  // run, so the report's numbers can be traced back to executed commands.
  const receiptRunId = `audit_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  enterReceiptContext({ runId: receiptRunId, target });
  // Resolve the real code root once, so a wrapper/parent folder does not
  // silently degrade every local scorer.
  const localTarget = params.targetDir ? resolveCodeRoot(params.targetDir) : params.targetDir;
  // Depth comes from the resolved plan: explicit scorers > preset > stage preset > full suite.
  const plan = resolveAuditPlan(params);
  // Diff-scope the audit by default when the target is a git work tree, with a
  // large-diff guard that falls back to a full audit. `diffScope` restricts the
  // whole-tree scanners (Deep) to the changed files; crg/ocr already review the
  // diff. Whole-repo gates (lint/typecheck/local_qa) stay repo-wide by nature.
  const scope: AuditScope = localTarget && fs.existsSync(localTarget)
    ? await resolveAuditScope(localTarget, {
        ...(params.base ? { base: params.base } : {}),
        ...(plan.full ? { full: true } : {}),
      })
    : { ...FULL_SCOPE, note: 'no local target dir — full audit' };
  const diffScope = scope.mode === 'diff' ? new Set(scope.changedFiles) : undefined;
  // CodeNexus is a GitHub-webhook PR platform with no local-dir review endpoint,
  // so it is intentionally NOT a default scorer (it only ever reports capability).
  const scorersToRun = plan.scorers;
  const results: ScorerResult[] = [];

  const needsOss = scorersToRun.includes('codegraph') || scorersToRun.includes('ocr');
  let oss: { report?: OssReviewReport; error?: string } = {};
  if (needsOss) {
    if (!localTarget) {
      oss = { error: 'OSS review needs a local targetDir (repoUrl-only audits cannot run it)' };
    } else {
      const f = await fetchOssReviewForAudit(localTarget);
      oss = f.ok ? { report: f.report } : { error: f.error };
    }
  }

  // Tool capability grid (P4/G1): only probe when a P2 dimension scorer is in
  // play, and only for a real local target. A missing tool is reported as a gap.
  const p2Requested = scorersToRun.some((s) => isP2Scorer(s));
  let preflight: PreflightReport | undefined;
  if (p2Requested && localTarget && fs.existsSync(localTarget)) {
    preflight = await preflightAuditTools(localTarget);
  }
  const extraCtx = {
    ...(preflight ? { preflight } : {}),
    ...(diffScope ? { changedFiles: diffScope } : {}),
  };

  // Runtime cache (P4/G2) — off unless AUDIT_CACHE_TTL_MS > 0. Keyed by scorer,
  // target and a content signature so a changed tree is never served stale.
  const cacheSig = auditCacheEnabled() && localTarget && fs.existsSync(localTarget)
    ? signatureForDir(localTarget, diffScope)
    : '';
  const memo = async (name: ScorerName, fn: () => Promise<ScorerResult>): Promise<ScorerResult> => {
    if (!cacheSig || !localTarget) return fn();
    const key = scorerCacheKey(name, localTarget, cacheSig);
    const hit = getCachedScorer(key);
    if (hit) return hit;
    const result = await fn();
    setCachedScorer(key, result);
    return result;
  };

  const run = (s: ScorerName): Promise<ScorerResult> => {
    if (s === 'reporank') return runRepoRankScorer(params.repoUrl || target);
    if (s === 'grader') return runGraderScorer(params.repoUrl || target);
    if (s === 'claw') return runClawProtectScorer({ repoUrl: params.repoUrl, targetDir: localTarget });
    if (s === 'sca') return runScaScorer(localTarget);
    if (s === 'codegraph') return Promise.resolve(codegraphScorerResult(oss.report, oss.error));
    if (s === 'ocr') return Promise.resolve(ocrScorerResult(oss.report, oss.error));
    if (s === 'deep') return runDeepScorer(localTarget, diffScope ? { includeFiles: diffScope } : {});
    if (s === 'codegang') return runCodeGangScorer(localTarget);
    if (s === 'codenexus') return runCodeNexusScorer({ repoUrl: params.repoUrl, targetDir: localTarget });
    if (s === 'local_qa') return runLocalQaScorer(localTarget);
    if (s === 'cmake') return runCmakeScorer(localTarget);
    if (s === 'typecheck') return runTypecheckScorer(localTarget, diffScope ? { includeFiles: diffScope } : {});
    if (s === 'lint') return runLintScorer(localTarget, diffScope ? { includeFiles: diffScope } : {});
    if (s === 'deps_freshness') return runDepsFreshnessScorer(localTarget, extraCtx);
    if (s === 'licenses_sbom') return runLicensesSbomScorer(localTarget, extraCtx);
    if (s === 'duplication') return runDuplicationScorer(localTarget, extraCtx);
    if (s === 'perf') return runPerfScorer(localTarget, extraCtx);
    if (s === 'a11y') return runA11yScorer(localTarget, extraCtx);
    if (s === 'api_contract') return runApiContractScorer(localTarget, extraCtx);
    if (s === 'git_history') return runGitHistoryScorer(localTarget, extraCtx);
    if (s === 'iac') return runIacScorer(localTarget, extraCtx);
    if (s === 'sonarqube') return runSonarQubeScorer(localTarget);
    return Promise.resolve(honest(s, `unknown scorer "${s}"`));
  };

  for (let i = 0; i < scorersToRun.length; i++) {
    const s = scorersToRun[i];
    try { params.onProgress?.({ scorer: s, index: i, total: scorersToRun.length }); } catch { /* progress is best-effort */ }
    results.push(await memo(s, () => runWithReceipts({ runId: receiptRunId, target, scorer: s }, () => run(s))));
  }
  try { params.onProgress?.({ scorer: scorersToRun[scorersToRun.length - 1] ?? 'typecheck', index: scorersToRun.length, total: scorersToRun.length }); } catch { /* best-effort */ }

  // Reconcile every scored result into ONE weighted grade. Missing scorers are
  // excluded (with a reason), never counted as zero. Scoring v2 rolls up by
  // dimension, caps LLM influence, and always computes an LLM-free score.
  const reconciliation = reconcileResults(results);
  const overallScore = reconciliation.weightedScore;

  // Dedup + corroborate findings across every analyzer, then build the
  // dimension × tool coverage matrix (uncovered dimensions are explicit).
  const deduped = dedupeFindings(results.flatMap((r) => r.findings ?? []));
  const criticalFindings = deduped.findings.filter((f) => f.severity === 'critical').length;

  // Coverage truth: how many of the plan's scorers actually produced a number,
  // and which of the REQUIRED security scorers were in the plan but unavailable.
  const unavailableScorers = results
    .filter((r) => typeof r.score !== 'number' || !Number.isFinite(r.score))
    .map((r) => r.scorer);
  const scorersRun = results.length - unavailableScorers.length;
  const requiredScorers = resolveRequiredScorers(params.requiredScorers);
  const requiredUnavailableScorers = requiredScorers.filter(
    (s) => scorersToRun.includes(s) && unavailableScorers.includes(s),
  );

  // Fail closed on the two conditions a passing score must never mask: a
  // critical finding, or a required scanner that did not run.
  const overallStatus: AuditReport['overallStatus'] =
    criticalFindings > 0 || requiredUnavailableScorers.length > 0
      ? 'fail'
      : overallScore === null ? 'fail' : overallScore >= 80 ? 'pass' : overallScore >= 60 ? 'warn' : 'fail';

  // Name the reason so a "fail" is never confused with "could not verify".
  const verdictReason: AuditReport['verdictReason'] =
    criticalFindings > 0 ? 'critical-findings'
      : requiredUnavailableScorers.length > 0 ? 'required-scanners-unavailable'
        : overallScore === null ? 'unscored'
          : overallScore >= 80 ? 'ok' : 'below-threshold';
  const verdictDetail =
    verdictReason === 'critical-findings' ? `${criticalFindings} critical finding${criticalFindings === 1 ? '' : 's'}`
      : verdictReason === 'required-scanners-unavailable' ? `could not verify — required scanner(s) unavailable: ${requiredUnavailableScorers.join(', ')}`
        : verdictReason === 'unscored' ? 'no scorer produced a score'
          : verdictReason === 'ok' ? `score ${overallScore}`
            : `score ${overallScore} is below the 80 pass bar`;

  const dimensionScores: Partial<Record<Dimension, number | null>> = {};
  for (const d of reconciliation.dimensions) dimensionScores[d.dimension] = d.score;
  const coverage = buildCoverageFromResults(results, dimensionScores);
  const coveragePercent = coverage.total > 0
    ? Math.round((coverage.covered / coverage.total) * 100)
    : 0;

  // Designated build gate: a stage turns the reconciled score into a verdict
  // the pipeline can enforce. Advisory stages record without blocking.
  const gate = evaluateAuditGate(overallScore, plan.stage, { criticalFindings, requiredUnavailableScorers });

  const report: AuditReport = {
    id: receiptRunId,
    receiptRunId,
    timestamp: new Date().toISOString(),
    target,
    results,
    overallStatus,
    overallScore,
    overallScoreDeterministic: reconciliation.deterministicScore,
    grade: reconciliation.grade,
    reconciliation,
    dimensions: reconciliation.dimensions,
    coverage,
    coveragePercent,
    findings: deduped.findings,
    dedup: deduped.stats,
    criticalFindings,
    scorersRun,
    scorersTotal: results.length,
    unavailableScorers,
    requiredUnavailableScorers,
    verdictReason,
    verdictDetail,
    scope,
    delta: null,
    ...(plan.stage ? { stage: plan.stage } : {}),
    ...(gate ? { gate } : {}),
    ...(preflight ? { preflight } : {}),
    determinismConfig: auditModelConfig(),
  };

  // Trend vs the previous audit for the same target: new/fixed/persisted
  // findings and the per-dimension attribution of any grade movement.
  report.delta = buildAuditDelta(params.previousReport ?? null, report);

  // Shared audit core (opt-in): validate findings against the current tree,
  // reconcile the persistent lifecycle, and evaluate the PR/release gate. This
  // is where The Deep / RepoRank / CodeNexus findings become an actionable,
  // de-duplicated backlog instead of a fresh dump every run.
  if (params.core === true) {
    try {
      report.core = runAuditCore({ rootDir: target, findings: report.findings });
    } catch (err) {
      report.core = {
        configSource: null,
        configErrors: [`audit core failed: ${(err as Error).message}`],
        configWarnings: [],
        validation: { confirmed: 0, unconfirmed: 0, stale: 0, notApplicable: 0, droppedStale: 0, items: [] },
        lifecycle: { created: 0, persisting: 0, reopened: 0, resolvedNow: 0, suppressed: 0, records: [] },
        // Fail closed: an unavailable audit core is not a pass. The caller can
        // still read configErrors to see why the gate could not be evaluated.
        gate: { passed: false, evaluated: false, reason: 'audit core unavailable', considered: 0, failing: [] },
      };
    }
  }

  // Recursive-learning seam. Ad-hoc runs record only when opted in; designated
  // stage runs ALWAYS record (local telemetry + episode), and merge/nightly/
  // release stages additionally index into Recourse memory — so what the gates
  // catch (and what they miss) teaches the audit team over time. Best-effort
  // and isolated — a feedback failure never fails the audit.
  const stageDef = plan.stage ? AUDIT_STAGES[plan.stage] : null;
  if (auditFeedbackEnabled(params.feedback) || plan.stage !== null) {
    report.feedback = await recordAuditFeedback(report, { memory: stageDef?.memory === true });
  }

  // Collect the evidence chain for this run and anchor its head so later
  // verification can detect truncation, not just edits.
  report.receiptIds = listReceipts({ runId: receiptRunId, includeProbes: true, limit: 1000 })
    .map((r) => r.id)
    .reverse();
  anchorHead();

  return report;
}
