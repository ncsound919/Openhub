/**
 * Shared evidence envelope helpers (P2/P4 foundation).
 *
 * Extracted from auditSuite so additional scorers (P2 dimensions) and the
 * preflight/cache layer can produce the same `ScorerResult` shape without a
 * circular import back into the suite.
 */
import {
  determinismForScorer,
  dimensionsForScorer,
  primaryDimension,
  type Dimension,
} from './dimensions.js';
import { createFinding, type Determinism, type Finding } from './findings.js';

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
  dimension?: Dimension;
  dimensions?: Dimension[];
  determinism?: Determinism;
  findings?: Finding[];
  coverage?: ScorerCoverage;
  status?: 'ok' | 'partial' | 'unavailable';
  durationMs?: number;
  /** True when the result was served from the runtime cache (G2). */
  cached?: boolean;
}

export interface EvidenceExtras {
  findings?: Finding[];
  dimensions?: Dimension[];
  determinism?: Determinism;
  files?: number;
  language?: string;
  analyzers?: string[];
  status?: ScorerResult['status'];
}

/** Build a normalized, fingerprinted finding (shared model in findings.ts). */
export const makeFinding = createFinding;

/** Stamp the P0 evidence envelope onto a scorer result. */
export function attach(result: ScorerResult, extras: EvidenceExtras = {}): ScorerResult {
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

/** Honest skip: no score, a real error, and the envelope marked unavailable. */
export function honest(scorer: string, error: string, summary = ''): ScorerResult {
  return attach({ scorer, score: null, summary: summary || error, error }, { status: 'unavailable' });
}
