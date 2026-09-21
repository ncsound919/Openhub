/**
 * Audit baseline + trend (Workstream E2/E3).
 *
 * Re-running an audit should answer "what changed since last time", not just
 * "what is the grade". This module diffs a fresh report against the previous
 * one for the same target: findings that are new, fixed, or persisted (by
 * cross-tool dedup key), the score/grade movement, and a per-dimension
 * attribution of *why* the grade moved.
 */
import { dedupKey, type Finding } from './findings.js';
import type { Dimension } from './dimensions.js';

export interface DeltaDimension {
  dimension: Dimension;
  label: string;
  score: number | null;
  weight: number;
}

/** Minimal report shape the delta needs (avoids an import cycle with auditSuite). */
export interface DeltaReportInput {
  id: string;
  timestamp: string;
  overallScore: number | null;
  grade: string;
  findings: Finding[];
  reconciliation: { dimensions: DeltaDimension[] };
}

export interface DimensionDelta {
  dimension: Dimension;
  label: string;
  from: number | null;
  to: number | null;
  /** Signed movement (to - from); 0 when either side had no score. */
  delta: number;
  weight: number;
  /** delta * weight — contribution to the overall score movement. */
  impact: number;
}

export interface AuditDelta {
  baselineId: string | null;
  baselineAt: string | null;
  score: { from: number | null; to: number | null; delta: number | null };
  grade: { from: string | null; to: string; changed: boolean };
  findings: {
    newCount: number;
    fixedCount: number;
    persistedCount: number;
    newByDimension: Record<string, number>;
    new: Finding[];
    fixed: Finding[];
  };
  /** Dimensions ordered by absolute impact on the grade change. */
  attribution: DimensionDelta[];
  /** Short "grade changed because…" reasons (top movers only). */
  reasons: string[];
  headline: string;
}

const NO_BASELINE_FINDINGS: AuditDelta['findings'] = {
  newCount: 0,
  fixedCount: 0,
  persistedCount: 0,
  newByDimension: {},
  new: [],
  fixed: [],
};

/** Build the delta of `current` against a previous report (or establish a baseline). */
export function buildAuditDelta(
  previous: DeltaReportInput | null,
  current: DeltaReportInput,
): AuditDelta {
  const currentScore = current.overallScore;
  if (!previous) {
    return {
      baselineId: null,
      baselineAt: null,
      score: { from: null, to: currentScore, delta: null },
      grade: { from: null, to: current.grade, changed: false },
      findings: { ...NO_BASELINE_FINDINGS, persistedCount: current.findings.length },
      attribution: [],
      reasons: [],
      headline: `baseline established at ${current.grade}${currentScore === null ? '' : ` (${currentScore})`}`,
    };
  }

  // --- Findings: new / fixed / persisted, identified by cross-tool dedup key ---
  const prevByKey = new Map(previous.findings.map((f) => [dedupKey(f), f]));
  const currByKey = new Map(current.findings.map((f) => [dedupKey(f), f]));
  const newFindings = current.findings.filter((f) => !prevByKey.has(dedupKey(f)));
  const fixedFindings = previous.findings.filter((f) => !currByKey.has(dedupKey(f)));
  const persistedCount = current.findings.length - newFindings.length;

  const newByDimension: Record<string, number> = {};
  for (const f of newFindings) newByDimension[f.dimension] = (newByDimension[f.dimension] ?? 0) + 1;

  // --- Score + per-dimension attribution ---
  const prevDims = new Map(previous.reconciliation.dimensions.map((d) => [d.dimension, d]));
  const attribution: DimensionDelta[] = [];
  for (const d of current.reconciliation.dimensions) {
    const before = prevDims.get(d.dimension)?.score ?? null;
    const after = d.score;
    if (before === null && after === null) continue;
    const delta = before !== null && after !== null ? after - before : 0;
    if (delta === 0) continue;
    attribution.push({
      dimension: d.dimension,
      label: d.label,
      from: before,
      to: after,
      delta,
      weight: d.weight,
      impact: delta * d.weight,
    });
  }
  attribution.sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact));

  const scoreDelta =
    previous.overallScore !== null && currentScore !== null
      ? currentScore - previous.overallScore
      : null;

  const reasons = attribution.slice(0, 3).map(
    (a) => `${a.label} ${a.delta > 0 ? '+' : ''}${a.delta} (${a.from ?? '—'}→${a.to ?? '—'})`,
  );

  const move = scoreDelta === null ? '' : ` (${scoreDelta > 0 ? '+' : ''}${scoreDelta})`;
  const headline =
    `grade ${previous.grade} → ${current.grade}${move} · ` +
    `+${newFindings.length} new, −${fixedFindings.length} fixed, ${persistedCount} persisted`;

  return {
    baselineId: previous.id,
    baselineAt: previous.timestamp,
    score: { from: previous.overallScore, to: currentScore, delta: scoreDelta },
    grade: { from: previous.grade, to: current.grade, changed: previous.grade !== current.grade },
    findings: {
      newCount: newFindings.length,
      fixedCount: fixedFindings.length,
      persistedCount,
      newByDimension,
      new: newFindings.slice(0, 100),
      fixed: fixedFindings.slice(0, 100),
    },
    attribution,
    reasons,
    headline,
  };
}
