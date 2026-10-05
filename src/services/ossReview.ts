import { Agent } from 'undici';
import { axiomFetch } from './axiomClient.js';

// undici's default headersTimeout (300s) aborts long Axiom calls before the
// AbortSignal below can fire — the OCR LLM review alone runs for minutes, so the
// oss-review response can legitimately take >5 min. Raise both socket timeouts
// so the caller's timeoutMs is the only effective limit.
const ossDispatcher = new Agent({ headersTimeout: 1_200_000, bodyTimeout: 1_200_000 });

/**
 * Axiom's `/api/harness/oss-review` response — the shared shape for the two OSS
 * review tools wired into the audit team. Axiom owns the subprocess bridge
 * (src/server/ossReview.ts); OpenHub only consumes the summarized report. Kept
 * in one place so the audit scorers and the repair work-order readouts can
 * never drift on how they read it.
 */
export interface OssReviewReport {
  target?: string;
  graph?: {
    available?: boolean;
    error?: string;
    report?: {
      risk_score?: number;
      summary?: string;
      changed_functions?: Array<{ name?: string; file_path?: string; line_start?: number; line_end?: number; risk_score?: number }>;
      affected_flows?: unknown[];
      test_gaps?: Array<{ name?: string; file?: string; line_start?: number; line_end?: number }>;
      review_priorities?: Array<{ name?: string; file_path?: string; line_start?: number; line_end?: number; risk_score?: number }>;
    } | null;
  };
  ocr?: {
    available?: boolean;
    error?: string;
    preview?: {
      reviewable_count?: number;
      total_files?: number;
      reviewable_files?: Array<{ path?: string; status?: string; insertions?: number; deletions?: number }>;
    } | null;
  };
  llmReview?: { configured?: boolean; findings?: unknown; error?: string };
}

/** Fetch the OSS review report from Axiom. Never throws — a down Axiom is an
 *  honest error the caller turns into an unavailable readout/scorer. `build`
 *  refreshes the code graph first (operator-triggered audits pay that cost
 *  once; passive page-load readouts read the existing graph instead). */
export async function fetchOssReview(
  targetDir: string,
  opts: { build?: boolean; timeoutMs?: number } = {}
): Promise<{ ok: boolean; report?: OssReviewReport; error?: string }> {
  try {
    const data = await axiomFetch('/api/harness/oss-review', {
      method: 'POST',
      body: JSON.stringify({ targetDir, build: opts.build === true }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 900_000),
      dispatcher: ossDispatcher,
    } as RequestInit & { dispatcher: unknown });
    return { ok: true, report: data as OssReviewReport };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

/**
 * Count findings across the shapes OCR may emit, or null when unknown.
 * Tolerant by design: OCR's `review` may return a JSON array, an object whose
 * findings live under several keys, a raw string (JSON or bullet list), or an
 * already-counted number. A shape we cannot read returns null (score=null)
 * rather than a fabricated 0.
 */
export function countFindings(f: unknown): number | null {
  if (f == null) return null;
  if (typeof f === 'number') return Number.isFinite(f) ? f : null;
  if (typeof f === 'string') {
    const trimmed = f.trim();
    if (!trimmed) return null;
    try {
      const parsed = JSON.parse(trimmed);
      const n = countFindings(parsed);
      if (n !== null) return n;
    } catch {
      /* not JSON — fall through to a heuristic line count */
    }
    const items = trimmed
      .split(/\r?\n/)
      .filter((l) => /^\s*(?:[-*•]|\d+[.)])\s+\S/.test(l));
    return items.length > 0 ? items.length : null;
  }
  if (Array.isArray(f)) return f.length;
  if (typeof f === 'object') {
    const o = f as Record<string, unknown>;
    for (const k of ['findings', 'comments', 'issues', 'results', 'items', 'review', 'comments_list']) {
      const v = o[k];
      if (Array.isArray(v)) return v.length;
      if (v && typeof v === 'object') {
        const n = countFindings(v);
        if (n !== null) return n;
      }
    }
    return null;
  }
  return null;
}
