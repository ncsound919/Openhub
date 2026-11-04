import type { JevQuestion, JevState } from '../../src/services/jevClient.js';

export type Family = 'review' | 'repair' | 'audit' | 'workspace';

export type ExpectedValue = string | number | boolean;

export interface BenchmarkCase {
  /** Stable id: `<family>/<slug>`. */
  id: string;
  family: Family;
  /** Real artifact this case was extracted from (commit sha, file path, report). */
  source: string;
  state: JevState;
  questions: Record<string, JevQuestion>;
  /** Ground truth, derived by the policy in `labeler.ts` — never by a contender. */
  expected: Record<string, ExpectedValue>;
  /** Human-readable reason the label is what it is. */
  labelBasis: string;
  /** Extra material used only by the labeler (never sent to an engine). */
  meta?: Record<string, unknown>;
}

export interface NormalizedAnswer {
  type: 'choice' | 'noul' | 'score';
  value: ExpectedValue;
  confidence?: number;
}

export type AnswerMap = Record<string, NormalizedAnswer>;

export interface EngineRun {
  engine: string;
  ok: boolean;
  answers: AnswerMap;
  latencyMs: number;
  error?: string;
  model?: string;
  /** Raw model text, kept for auditability when parsing fails. */
  raw?: string;
  usage?: { inputTokens: number; outputTokens: number; reasoningTokens?: number };
}

export interface CaseResult {
  case: BenchmarkCase;
  jev: EngineRun;
  deepseek: EngineRun;
  /** Per-engine per-key correctness. */
  scores: {
    jev: Record<string, boolean>;
    deepseek: Record<string, boolean>;
  };
  judge?: {
    winner: 'jev' | 'deepseek' | 'tie';
    reason: string;
    agreesWithPolicy: boolean;
    model: string;
  };
}
