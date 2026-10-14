import { describe, it, expect } from 'vitest';
import {
  codegraphFindings,
  ocrFindings,
  getOssReviewReadouts,
  buildWorkOrder,
} from '../src/services/agentReadouts';
import type { OssReviewReport } from '../src/services/ossReview';

describe('codegraphFindings', () => {
  it('maps test gaps to line-anchored medium findings', () => {
    const findings = codegraphFindings({
      graph: {
        available: true,
        report: {
          risk_score: 0.5,
          test_gaps: [{ name: 'extra', file: 'src/auth.ts', line_start: 2, line_end: 2 }],
          review_priorities: [],
        },
      },
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleId: 'crg:test-gap',
      category: 'test-coverage',
      file: 'src/auth.ts',
      line: '2',
      severity: 'medium',
    });
  });

  it('does not repeat a function already reported as a test gap', () => {
    const findings = codegraphFindings({
      graph: {
        available: true,
        report: {
          test_gaps: [{ name: 'extra', file: 'src/auth.ts', line_start: 2 }],
          review_priorities: [{ name: 'extra', file_path: 'src/auth.ts', line_start: 2, risk_score: 0.9 }],
        },
      },
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].ruleId).toBe('crg:test-gap');
  });

  it('grades a high-risk priority that is not a test gap', () => {
    const findings = codegraphFindings({
      graph: {
        available: true,
        report: {
          test_gaps: [],
          review_priorities: [{ name: 'login', file_path: 'src/login.ts', line_start: 10, risk_score: 0.8 }],
        },
      },
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ ruleId: 'crg:change-risk', severity: 'high' });
  });

  it('returns nothing when the graph report is absent', () => {
    expect(codegraphFindings(undefined)).toEqual([]);
    expect(codegraphFindings({ graph: { available: false } })).toEqual([]);
  });
});

describe('ocrFindings', () => {
  it('normalizes an array of line-level findings defensively', () => {
    const findings = ocrFindings({
      llmReview: {
        configured: true,
        findings: [{ file: 'src/a.ts', line: 4, title: 'SQL injection', severity: 'HIGH', ruleId: 'sec:sqli' }],
      },
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ file: 'src/a.ts', line: '4', title: 'SQL injection', severity: 'high', ruleId: 'sec:sqli' });
  });

  it('accepts the nested { findings: [...] } shape', () => {
    const findings = ocrFindings({ llmReview: { configured: true, findings: { findings: [{ message: 'x' }] } } });
    expect(findings).toHaveLength(1);
    expect(findings[0].title).toBe('x');
  });

  it('returns nothing when no LLM review ran', () => {
    expect(ocrFindings({ llmReview: { configured: false } })).toEqual([]);
    expect(ocrFindings(undefined)).toEqual([]);
  });
});

describe('getOssReviewReadouts', () => {
  it('degrades to unavailable readouts when Axiom is unreachable', async () => {
    const readouts = await getOssReviewReadouts('/tmp/proj', async () => ({ ok: false, error: 'ECONNREFUSED' }));
    expect(readouts).toHaveLength(2);
    for (const r of readouts) {
      expect(r.available).toBe(false);
      expect(r.findings).toEqual([]);
      expect(r.note).toBe('ECONNREFUSED');
    }
  });

  it('feeds graph test gaps into the repair work order', async () => {
    const report: OssReviewReport = {
      graph: {
        available: true,
        report: {
          risk_score: 0.5,
          changed_functions: [{ name: 'extra' }],
          affected_flows: [],
          test_gaps: [{ name: 'extra', file: 'src/auth.ts', line_start: 2 }],
          review_priorities: [],
        },
      },
      ocr: { available: true, preview: { reviewable_count: 3, total_files: 3 } },
      llmReview: { configured: false },
    };
    const readouts = await getOssReviewReadouts('/tmp/proj', async () => ({ ok: true, report }));
    const graph = readouts.find((r) => r.tool === 'codegraph')!;
    expect(graph.available).toBe(true);
    expect(graph.findings).toHaveLength(1);
    const ocr = readouts.find((r) => r.tool === 'ocr')!;
    expect(ocr.note).toContain('LLM review off');

    const workOrder = buildWorkOrder(readouts);
    expect(workOrder.total).toBe(1);
    expect(workOrder.items[0]).toMatchObject({ tool: 'codegraph', file: 'src/auth.ts', line: '2', category: 'test-coverage' });
  });
});
