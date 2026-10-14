/**
 * Audit → reporter bridge (Workstream F4).
 *
 * Recourse's self-reporter narrates the latest audit (dimension gaps and
 * regressions) but lives in a separate process. After each audit we write a
 * small, validated snapshot to a shared path; Recourse reads it when composing
 * its state. This keeps the reporter deterministic — it only ever reads data,
 * never calls back into the audit.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { AuditReport } from './auditSuite.js';

export interface AuditSnapshotDimension {
  dimension: string;
  label: string;
  status: 'covered' | 'partial' | 'uncovered';
  score: number | null;
}

export interface AuditSnapshot {
  version: 1;
  writtenAt: string;
  target: string;
  grade: string;
  score: number | null;
  deterministicScore: number | null;
  coveragePercent: number;
  scope: 'full' | 'diff';
  dimensions: AuditSnapshotDimension[];
  findings: { total: number; new: number; fixed: number; persisted: number };
  reasons: string[];
}

/** Where the snapshot is written; shared with Recourse via env. */
export function defaultAuditSnapshotPath(): string {
  if (process.env.AUDIT_SNAPSHOT_PATH) return process.env.AUDIT_SNAPSHOT_PATH;
  const root = process.env.RECOURSE_ROOT || path.join('C:', 'Users', 'User', 'Downloads', 'recourse');
  return path.join(root, 'data', 'reports', 'audit-snapshot.json');
}

/** Project a full audit report into the compact reporter snapshot. */
export function buildAuditSnapshot(report: AuditReport): AuditSnapshot {
  return {
    version: 1,
    writtenAt: report.timestamp,
    target: report.target,
    grade: report.grade,
    score: report.overallScore,
    deterministicScore: report.overallScoreDeterministic,
    coveragePercent: report.coveragePercent,
    scope: report.scope?.mode ?? 'full',
    dimensions: (report.coverage?.dimensions ?? []).map((d) => ({
      dimension: d.dimension,
      label: d.label,
      status: d.status,
      score: d.score,
    })),
    findings: {
      total: report.findings.length,
      new: report.delta?.findings.newCount ?? 0,
      fixed: report.delta?.findings.fixedCount ?? 0,
      persisted: report.delta?.findings.persistedCount ?? 0,
    },
    reasons: report.delta?.reasons ?? [],
  };
}

/** Write the snapshot; never throws (a missing reporter bridge must not fail an audit). */
export function writeAuditSnapshot(report: AuditReport, filePath = defaultAuditSnapshotPath()): boolean {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(buildAuditSnapshot(report), null, 2), 'utf8');
    return true;
  } catch (err) {
    console.warn('[audit] could not write reporter snapshot:', err instanceof Error ? err.message : String(err));
    return false;
  }
}
