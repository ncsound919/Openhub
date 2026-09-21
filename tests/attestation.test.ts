import { describe, expect, it } from 'vitest';
import {
  buildAuditStatement,
  buildVerificationSummary,
  verifyAttestation,
  AUDIT_PREDICATE_TYPE,
  IN_TOTO_STATEMENT_TYPE,
} from '../src/services/attestation';
import { recordReceipt, clearReceipts } from '../src/services/receipts';
import type { AuditReport } from '../src/services/auditSuite';

function mockReport(overrides: Partial<AuditReport> = {}): AuditReport {
  return {
    id: 'audit_test_123',
    receiptRunId: 'run_test_123',
    timestamp: '2026-01-01T00:00:00.000Z',
    target: 'C:/mock/project',
    overallStatus: 'pass',
    grade: 'A',
    overallScore: 92,
    overallScoreDeterministic: 90,
    coveragePercent: 88,
    gate: { stage: 'release', pass: true, reason: 'score >= 80', preset: 'release', advisory: false, minScore: 80 },
    findings: [],
    results: [],
    dimensions: [],
    coverage: {} as never,
    dedup: {} as never,
    scope: {} as never,
    delta: null,
    reconciliation: {
      weightedScore: 92,
      deterministicScore: 90,
      grade: 'A',
      contributing: [{ scorer: 'grader', score: 92, weight: 1 }],
      excluded: [],
      llmShare: 0,
      model: 'dimension-v2' as const,
      dimensions: [],
    },
    ...overrides,
  } as AuditReport;
}

describe('attestation — in-toto & VSA', () => {
  it('builds an in-toto Statement with correct predicate and content-addressed subject', () => {
    const report = mockReport();
    const statement = buildAuditStatement(report, []);
    expect(statement._type).toBe(IN_TOTO_STATEMENT_TYPE);
    expect(statement.predicateType).toBe(AUDIT_PREDICATE_TYPE);
    expect(statement.subject[0].name).toBe('C:/mock/project');
    expect(statement.predicate.auditId).toBe('audit_test_123');
    expect(statement.predicate.grade).toBe('A');
    expect(statement.predicate.gate).toEqual({ stage: 'release', passed: true, reason: 'score >= 80' });
  });

  it('fails closed when receipts are absent', () => {
    const report = mockReport();
    const statement = buildAuditStatement(report, []);
    const verification = verifyAttestation({ statement, receipts: [] });
    expect(verification.valid).toBe(false);
    const evidenceCheck = verification.checks.find((c) => c.name === 'evidence-present');
    expect(evidenceCheck?.ok).toBe(false);
    expect(evidenceCheck?.detail).toContain('fail closed');

    const vsa = buildVerificationSummary(report, []);
    expect(vsa.predicate.verificationResult).toBe('FAILED');
    expect(vsa.predicate.verifiedLevels).toEqual([]);
  });

  it('passes verification when valid receipts are attached to the run', () => {
    clearReceipts();
    const receipt = recordReceipt({
      kind: 'command',
      command: 'npm test',
      status: 'passed',
      runId: 'run_test_123',
      target: 'C:/mock/project',
      output: 'All tests passed',
    });

    const report = mockReport();
    const statement = buildAuditStatement(report, [receipt]);
    const verification = verifyAttestation({ statement, receipts: [receipt] });
    expect(verification.valid).toBe(true);

    const vsa = buildVerificationSummary(report, [receipt]);
    expect(vsa.predicate.verificationResult).toBe('PASSED');
    expect(vsa.predicate.verifiedLevels).toContain('OPENHUB_AUDIT_VERIFIED');
    expect(vsa.predicate.verifiedLevels).toContain('GATE_PASSED:release');
  });

  it('fails verification if a receipt has been tampered with', () => {
    clearReceipts();
    const receipt = recordReceipt({
      kind: 'command',
      command: 'npm test',
      status: 'passed',
      runId: 'run_test_123',
      target: 'C:/mock/project',
      output: 'ok',
    });
    const tampered = { ...receipt, status: 'failed' as const };

    const report = mockReport();
    const statement = buildAuditStatement(report, [tampered]);
    const verification = verifyAttestation({ statement, receipts: [tampered] });
    expect(verification.valid).toBe(false);
    const integrityCheck = verification.checks.find((c) => c.name === 'receipts-integrity-valid');
    expect(integrityCheck?.ok).toBe(false);
  });
});
