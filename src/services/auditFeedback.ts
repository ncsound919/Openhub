/**
 * Audit → learning feedback (step 1 of the recursive-learning loop).
 *
 * Turns each finished audit into two durable records:
 *   - one telemetry event (`system: 'audit'`) so trends/insights see audit runs
 *     beside every other system, and
 *   - one self-learning episode (`kind: 'audit'`) carrying the grade, coverage,
 *     dedup ratio and delta as signals.
 *
 * Deliberate design choices (see the audit-upgrade plan's guardrails):
 *   - The episode outcome is `pending`, never `accepted`/`rejected`. An audit is
 *     a *measurement*, and `selfLearning.calibration()` counts every episode's
 *     accepted/rejected — so a predicted grade must not be mistaken for a
 *     verified fix. Verification (tests/typecheck) is what earns a verdict.
 *   - Opt-in and best-effort: disabled unless `AUDIT_FEEDBACK=1` or the caller
 *     passes `feedback: true`; any write failure is reported, never thrown.
 */
import { recordEvent, type TelemetryInput } from './telemetry.js';
import { recordEpisode, type EpisodeInput } from './selfLearning.js';
import { recourseMemoryIndex } from './recourseClient.js';
import type { AuditReport } from './auditSuite.js';

export interface AuditFeedbackResult {
  telemetry: { wrote: boolean; id?: string; error?: string };
  episode: { wrote: boolean; id?: string; error?: string };
  memory: { attempted: boolean; available?: boolean; error?: string };
}

export interface AuditFeedbackOptions {
  /** Also index the run into Recourse's self-learning memory (best-effort). */
  memory?: boolean;
}

/** Enabled explicitly, else by the `AUDIT_FEEDBACK` env flag (default off). */
export function auditFeedbackEnabled(explicit?: boolean): boolean {
  if (typeof explicit === 'boolean') return explicit;
  const flag = (process.env.AUDIT_FEEDBACK ?? '').trim().toLowerCase();
  return flag === '1' || flag === 'true' || flag === 'yes';
}

type AuditSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

function severityForStatus(status: AuditReport['overallStatus']): AuditSeverity {
  return status === 'fail' ? 'high' : status === 'warn' ? 'medium' : 'info';
}

/** A repo URL is not a directory; only record targetDir for local targets. */
function localTarget(target: string): string | null {
  return target && !/^https?:\/\//i.test(target) ? target : null;
}

/** The telemetry event for one audit run. Pure and unit-testable. */
export function buildAuditTelemetry(report: AuditReport): TelemetryInput {
  const targetDir = localTarget(report.target);
  const excluded = report.reconciliation?.excluded ?? [];
  return {
    system: 'audit',
    kind: 'audit-run',
    severity: severityForStatus(report.overallStatus),
    // A custom outcome (pass|warn|fail) — NOT accepted/rejected, so this never
    // contaminates the verified pass rate computed from build verdicts.
    outcome: report.overallStatus,
    goal: `audit grade ${report.grade}${report.overallScore !== null ? ` (${report.overallScore})` : ''}`,
    ...(targetDir ? { targetDir } : {}),
    data: {
      grade: report.grade,
      overallScore: report.overallScore,
      overallScoreDeterministic: report.overallScoreDeterministic,
      coveragePercent: report.coveragePercent,
      scope: report.scope?.mode ?? 'full',
      ...(report.stage ? { stage: report.stage } : {}),
      llmShare: report.reconciliation?.llmShare ?? 0,
      excludedScorers: excluded.map((e) => e.scorer),
      dedup: report.dedup ?? null,
      newFindings: report.delta?.findings.newCount ?? 0,
      fixedFindings: report.delta?.findings.fixedCount ?? 0,
      persistedFindings: report.delta?.findings.persistedCount ?? 0,
      determinism: report.determinismConfig ?? null,
      scorers: report.results.map((r) => ({
        scorer: r.scorer,
        score: r.score,
        status: r.status ?? null,
        determinism: r.determinism ?? null,
        cached: r.cached === true,
      })),
    },
  };
}

/** The self-learning episode for one audit run. Pure and unit-testable. */
export function buildAuditEpisode(report: AuditReport): EpisodeInput {
  const targetDir = localTarget(report.target);
  return {
    kind: 'audit',
    outcome: 'pending',
    goal: `audit ${report.target} — grade ${report.grade}`,
    ...(targetDir ? { targetDir } : {}),
    systems: ['audit', ...((report.reconciliation?.llmShare ?? 0) > 0 ? ['llm'] : [])],
    signals: {
      grade: report.grade,
      overallScore: report.overallScore,
      deterministicScore: report.overallScoreDeterministic,
      status: report.overallStatus,
      coveragePercent: report.coveragePercent,
      scope: report.scope?.mode ?? 'full',
      ...(report.stage ? { stage: report.stage } : {}),
      dedupRatio: report.dedup?.dedupRatio ?? 0,
      newFindings: report.delta?.findings.newCount ?? 0,
      fixedFindings: report.delta?.findings.fixedCount ?? 0,
      persistedFindings: report.delta?.findings.persistedCount ?? 0,
      excludedScorers: (report.reconciliation?.excluded ?? []).map((e) => e.scorer),
    },
  };
}

/**
 * Record telemetry + episode for a finished audit. Never throws; a failed write
 * is reported in the result. Memory indexing (when requested) is best-effort and
 * only records a compact, dedup-stable projection of the findings.
 */
export async function recordAuditFeedback(
  report: AuditReport,
  options: AuditFeedbackOptions = {},
): Promise<AuditFeedbackResult> {
  const telemetry = recordEvent(buildAuditTelemetry(report));
  const episode = recordEpisode(buildAuditEpisode(report));
  const memory: AuditFeedbackResult['memory'] = { attempted: false };

  if (options.memory) {
    memory.attempted = true;
    try {
      const res = await recourseMemoryIndex({
        source: 'openhub-audit',
        target: report.target,
        grade: report.grade,
        overallScore: report.overallScore,
        deterministicScore: report.overallScoreDeterministic,
        coveragePercent: report.coveragePercent,
        scope: report.scope?.mode ?? 'full',
        newFindings: report.delta?.findings.newCount ?? 0,
        fixedFindings: report.delta?.findings.fixedCount ?? 0,
        text: `Audit of ${report.target}: grade ${report.grade}, coverage ${report.coveragePercent}%, ${report.findings.length} findings.`,
        findings: (report.findings ?? []).slice(0, 100).map((f) => ({
          id: f.id,
          dimension: f.dimension,
          category: f.category,
          severity: f.severity,
          ...(f.location ? { file: f.location.file, ...(f.location.line !== undefined ? { line: f.location.line } : {}) } : {}),
        })),
      });
      memory.available = res.available;
      if (res.error) memory.error = res.error;
    } catch (err) {
      memory.error = err instanceof Error ? err.message : String(err);
    }
  }

  return { telemetry, episode, memory };
}
