/**
 * Dimension taxonomy for the audit platform (P0 foundations).
 *
 * Every scorer declares which dimension(s) it produces evidence for, and every
 * finding is tagged with exactly one dimension. This lets the reconciliation
 * layer report a score *per dimension* and — just as importantly — surface the
 * dimensions that produced NO evidence as explicit `uncovered` entries instead
 * of letting a blind spot silently disappear from the report.
 *
 * Deterministic-first: dimension metadata carries an `llmCap` (the maximum
 * share of that dimension's score an LLM-derived analyzer may contribute) and
 * the reconciliation can always produce an LLM-free score.
 */
import type { Determinism } from './findings.js';

export type Dimension =
  | 'security'
  | 'correctness'
  | 'tests'
  | 'maintainability'
  | 'architecture'
  | 'performance'
  | 'dependencies'
  | 'licenses'
  | 'build_ci'
  | 'docs'
  | 'accessibility'
  | 'data';

/** Stable ordering used by the coverage matrix and report rendering. */
export const DIMENSIONS: readonly Dimension[] = [
  'security',
  'correctness',
  'tests',
  'maintainability',
  'architecture',
  'performance',
  'dependencies',
  'licenses',
  'build_ci',
  'docs',
  'accessibility',
  'data',
] as const;

export interface DimensionMeta {
  id: Dimension;
  label: string;
  description: string;
  /** Relative weight of this dimension in the overall rolled-up score. */
  weight: number;
  /**
   * Maximum share (0..1) of *this dimension's* score that LLM-derived evidence
   * may contribute. 0 means the dimension is deterministic-only. A dimension
   * with no deterministic evidence still reports an LLM score — the cap only
   * bounds the blend when both kinds of evidence are present.
   */
  llmCap: number;
  /** Minimum dimension score, so one noisy analyzer cannot zero it (default 0). */
  floor?: number;
  /** Maximum dimension score (default 100). */
  cap?: number;
}

export const DEFAULT_LLM_CAP = 0.2;

export const DIMENSION_META: Record<Dimension, DimensionMeta> = {
  security: {
    id: 'security',
    label: 'Security',
    description: 'Secrets, CVEs, injection, misconfiguration',
    weight: 3,
    llmCap: 0.1,
  },
  correctness: {
    id: 'correctness',
    label: 'Correctness',
    description: 'Bugs, type errors, logic defects',
    weight: 3,
    llmCap: 0.2,
  },
  tests: {
    id: 'tests',
    label: 'Tests',
    description: 'Test results, coverage, untested change',
    weight: 3,
    llmCap: 0,
  },
  maintainability: {
    id: 'maintainability',
    label: 'Maintainability',
    description: 'Lint, duplication, complexity',
    weight: 2,
    llmCap: 0.2,
  },
  architecture: {
    id: 'architecture',
    label: 'Architecture',
    description: 'Structure, coupling, API contracts',
    weight: 2,
    llmCap: 0.3,
  },
  performance: {
    id: 'performance',
    label: 'Performance',
    description: 'Hotspots, N+1, quadratic work',
    weight: 1,
    llmCap: 0.3,
  },
  dependencies: {
    id: 'dependencies',
    label: 'Dependencies',
    description: 'Known-vulnerable and stale dependencies',
    weight: 2,
    llmCap: 0,
  },
  licenses: {
    id: 'licenses',
    label: 'Licenses',
    description: 'SBOM license policy',
    weight: 1,
    llmCap: 0,
  },
  build_ci: {
    id: 'build_ci',
    label: 'Build / CI',
    description: 'Typecheck, build, CI wiring',
    weight: 2,
    llmCap: 0,
  },
  docs: {
    id: 'docs',
    label: 'Docs',
    description: 'README, API docs, comments',
    weight: 1,
    llmCap: 0.5,
  },
  accessibility: {
    id: 'accessibility',
    label: 'Accessibility',
    description: 'a11y rules on UI surfaces',
    weight: 1,
    llmCap: 0,
  },
  data: {
    id: 'data',
    label: 'Data',
    description: 'Migrations, schema safety, PII',
    weight: 1,
    llmCap: 0.2,
  },
};

const DIMENSION_SET = new Set<string>(DIMENSIONS);

export function isDimension(value: unknown): value is Dimension {
  return typeof value === 'string' && DIMENSION_SET.has(value);
}

/**
 * Which dimension(s) each scorer produces evidence for. The FIRST entry is the
 * scorer's primary dimension — the one its numeric score rolls into. Secondary
 * entries are still reported as covered in the matrix (the tool looked at that
 * surface) but do not double-count the score.
 */
export const SCORER_DIMENSIONS: Record<string, Dimension[]> = {
  reporank: ['correctness'],
  grader: ['correctness'],
  'claw-protect': ['security'],
  claw: ['security'],
  sca: ['dependencies', 'security'],
  codegraph: ['tests'],
  ocr: ['maintainability'],
  deep: ['correctness', 'security'],
  codegang: ['architecture'],
  codenexus: ['architecture'],
  local_qa: ['tests'],
  typecheck: ['build_ci', 'correctness'],
  lint: ['maintainability'],
  deps_freshness: ['dependencies'],
  licenses_sbom: ['licenses'],
  duplication: ['maintainability'],
  perf: ['performance'],
  a11y: ['accessibility'],
  api_contract: ['architecture'],
  git_history: ['security'],
  sonarqube: ['maintainability', 'security'],
  iac: ['security', 'build_ci'],
};

/** Default dimension for a scorer we have not classified yet. */
export const FALLBACK_DIMENSION: Dimension = 'correctness';

export function dimensionsForScorer(scorer: string): Dimension[] {
  return SCORER_DIMENSIONS[scorer] ?? [FALLBACK_DIMENSION];
}

export function primaryDimension(scorer: string): Dimension {
  return dimensionsForScorer(scorer)[0] ?? FALLBACK_DIMENSION;
}

/**
 * Scorers that are independent *opinions of the same signal*. They are
 * collapsed into one weighted vote during reconciliation so correlated
 * evidence is not double-counted (reporank and grader are both LLM repo
 * grades; counting them separately gave that signal twice the weight of any
 * deterministic scanner).
 */
export const SIGNAL_GROUPS: Record<string, string> = {
  reporank: 'llm-review',
  grader: 'llm-review',
};

/** Weight of a collapsed signal group (replaces the sum of member weights). */
export const GROUP_WEIGHTS: Record<string, number> = {
  'llm-review': 2,
};

/** Human labels for collapsed signal groups. */
export const GROUP_LABELS: Record<string, string> = {
  'llm-review': 'LLM repo review',
};

/**
 * A dimension driven by 2+ independent analyzers should not be zeroed by a
 * single noisy one (the scalar analogue of the OCR findings-density fix), so
 * the aggregate is clamped up to this floor.
 */
export const MULTI_ANALYZER_FLOOR = 15;

/**
 * Clamp a reconciled dimension score to the dimension's `[floor, cap]`. When
 * two or more independent analyzers fed the dimension, `MULTI_ANALYZER_FLOOR`
 * also applies so one dissenting tool cannot collapse it to 0.
 */
export function clampDimensionScore(
  dimension: Dimension,
  score: number,
  analyzerCount: number,
): number {
  const meta = DIMENSION_META[dimension];
  const floor = Math.max(meta.floor ?? 0, analyzerCount >= 2 ? MULTI_ANALYZER_FLOOR : 0);
  const cap = meta.cap ?? 100;
  return Math.min(cap, Math.max(floor, score));
}

/**
 * How trustworthy a scorer's numeric output is:
 *  - `static`   : reproducible, no model in the loop (scanners, compilers, tests)
 *  - `heuristic`: deterministic rules with inherent estimation (graph, complexity)
 *  - `llm`      : a language model produced the judgement
 */
export const SCORER_DETERMINISM: Record<string, Determinism> = {
  reporank: 'llm',
  grader: 'llm',
  'claw-protect': 'static',
  claw: 'static',
  sca: 'static',
  codegraph: 'heuristic',
  ocr: 'llm',
  deep: 'static',
  codegang: 'heuristic',
  codenexus: 'static',
  local_qa: 'static',
  typecheck: 'static',
  lint: 'static',
  deps_freshness: 'static',
  licenses_sbom: 'static',
  duplication: 'static',
  perf: 'heuristic',
  a11y: 'static',
  api_contract: 'static',
  git_history: 'static',
  sonarqube: 'static',
  iac: 'static',
};

export function determinismForScorer(scorer: string): Determinism {
  return SCORER_DETERMINISM[scorer] ?? 'heuristic';
}

// ---------------------------------------------------------------------------
// Coverage matrix
// ---------------------------------------------------------------------------

export type CoverageStatus = 'covered' | 'partial' | 'uncovered';

export interface DimensionCoverage {
  dimension: Dimension;
  label: string;
  status: CoverageStatus;
  /** Rolled-up score for the dimension, or null when no analyzer scored it. */
  score: number | null;
  /** Scorers that actually produced evidence for this dimension. */
  analyzers: string[];
  /** Scorers that were expected to look but could not (error / unavailable). */
  blocked: string[];
  findings: number;
  /** Why the dimension is uncovered (always set for `uncovered`). */
  reason?: string;
}

export interface CoverageReport {
  dimensions: DimensionCoverage[];
  covered: number;
  partial: number;
  uncovered: number;
  total: number;
}

/** Minimal shape the coverage builder needs from a scorer result. */
export interface CoverageResultInput {
  scorer: string;
  score: number | null;
  error?: string;
  findings?: unknown[] | undefined;
}

/**
 * Build the dimension × tool coverage matrix. A dimension is:
 *  - `covered`   : at least one mapped scorer produced a real score
 *  - `partial`   : at least one produced a score, but another mapped scorer
 *                  errored / was unavailable
 *  - `uncovered` : no mapped scorer produced any evidence (reason is recorded)
 *
 * `dimensionScores` carries the reconciled score per dimension when known.
 */
export function buildCoverageFromResults(
  results: readonly CoverageResultInput[],
  dimensionScores: Partial<Record<Dimension, number | null>> = {},
): CoverageReport {
  const dimensions: DimensionCoverage[] = DIMENSIONS.map((dimension) => {
    const relevant = results.filter((r) => dimensionsForScorer(r.scorer).includes(dimension));
    const scoring = relevant.filter((r) => typeof r.score === 'number' && Number.isFinite(r.score));
    const blocked = relevant
      .filter((r) => !(typeof r.score === 'number' && Number.isFinite(r.score)))
      .map((r) => r.scorer);
    const findings = relevant.reduce(
      (n, r) => n + (Array.isArray(r.findings) ? r.findings.length : 0),
      0,
    );
    const analyzers = scoring.map((r) => r.scorer);
    const score = dimensionScores[dimension] ?? null;

    let status: CoverageStatus;
    if (analyzers.length === 0) status = 'uncovered';
    else if (blocked.length > 0) status = 'partial';
    else status = 'covered';

    const reason =
      status === 'uncovered'
        ? relevant.find((r) => r.error)?.error ||
          (relevant.length === 0
            ? 'no analyzer in this run targets the dimension'
            : 'no analyzer produced evidence for this dimension')
        : undefined;

    return {
      dimension,
      label: DIMENSION_META[dimension].label,
      status,
      score,
      analyzers,
      blocked,
      findings,
      ...(reason ? { reason } : {}),
    };
  });

  return {
    dimensions,
    covered: dimensions.filter((d) => d.status === 'covered').length,
    partial: dimensions.filter((d) => d.status === 'partial').length,
    uncovered: dimensions.filter((d) => d.status === 'uncovered').length,
    total: dimensions.length,
  };
}
