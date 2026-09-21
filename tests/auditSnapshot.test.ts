import { describe, expect, it } from 'vitest';
import { buildAuditSnapshot } from '../src/services/auditSnapshot';
import type { AuditReport } from '../src/services/auditSuite';

function report(over: Partial<AuditReport> = {}): AuditReport {
  return {
    id: 'audit_1',
    timestamp: '2026-01-01T00:00:00.000Z',
    target: 'https://github.com/x/y',
    results: [],
    overallStatus: 'warn',
    overallScore: 72,
    overallScoreDeterministic: 68,
    grade: 'C-',
    reconciliation: {
      weightedScore: 72,
      grade: 'C-',
      contributing: [],
      excluded: [],
      dimensions: [],
      deterministicScore: 68,
      llmShare: 0.1,
      model: 'dimension-v2',
    },
    dimensions: [],
    coverage: {
      dimensions: [
        { dimension: 'security', label: 'Security', status: 'covered', score: 80, analyzers: ['claw'], blocked: [], findings: 2 },
      ],
      covered: 1,
      partial: 0,
      uncovered: 0,
      total: 1,
    },
    coveragePercent: 50,
    findings: [],
    dedup: { input: 0, unique: 0, duplicates: 0, corroborated: 0, dedupRatio: 0, bySource: {} },
    criticalFindings: 0,
    scorersRun: 1,
    scorersTotal: 1,
    unavailableScorers: [],
    requiredUnavailableScorers: [],
    scope: { mode: 'diff', base: 'HEAD', changedFiles: ['a.py'], insertions: 5, deletions: 1 },
    delta: {
      baselineId: 'audit_0',
      baselineAt: '2025-12-31T00:00:00.000Z',
      score: { from: 60, to: 72, delta: 12 },
      grade: { from: 'D', to: 'C-', changed: true },
      findings: { newCount: 3, fixedCount: 1, persistedCount: 4, newByDimension: { security: 2 }, new: [], fixed: [] },
      attribution: [],
      reasons: ['Security +20 (60→80)'],
      headline: 'grade D → C-',
    },
    ...over,
  };
}

describe('buildAuditSnapshot', () => {
  it('projects the report into the compact reporter snapshot', () => {
    const s = buildAuditSnapshot(report());
    expect(s.version).toBe(1);
    expect(s.grade).toBe('C-');
    expect(s.score).toBe(72);
    expect(s.deterministicScore).toBe(68);
    expect(s.coveragePercent).toBe(50);
    expect(s.scope).toBe('diff');
    expect(s.dimensions[0]).toMatchObject({ dimension: 'security', status: 'covered', score: 80 });
    expect(s.findings).toEqual({ total: 0, new: 3, fixed: 1, persisted: 4 });
    expect(s.reasons).toEqual(['Security +20 (60→80)']);
  });

  it('defaults trend counts to 0 when there is no baseline', () => {
    const s = buildAuditSnapshot(report({ delta: null }));
    expect(s.findings.new).toBe(0);
    expect(s.findings.fixed).toBe(0);
    expect(s.reasons).toEqual([]);
  });
});
