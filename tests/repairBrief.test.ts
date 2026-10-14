import { describe, it, expect } from 'vitest';
import { buildRepairBrief, renderRepairBrief } from '../src/services/repairBrief';
import { createFinding } from '../src/services/findings';

function finding(over: Record<string, unknown> = {}) {
  return createFinding({
    source: (over.source as string) ?? 'deep',
    dimension: (over.dimension as never) ?? 'correctness',
    category: (over.category as string) ?? 'npe',
    severity: (over.severity as string) ?? 'high',
    confidence: (over.confidence as number) ?? 0.8,
    determinism: (over.determinism as never) ?? 'static',
    ...(over.location ? { location: over.location as { file: string; line?: number } } : {}),
    ...(over.evidence ? { evidence: over.evidence as string } : {}),
    ...(over.remediation ? { remediation: over.remediation as string } : {}),
  });
}

function report(over: Record<string, unknown> = {}) {
  return {
    id: 'a1',
    timestamp: '2026-01-01T00:00:00.000Z',
    target: '/proj',
    overallStatus: 'fail',
    overallScore: 42,
    grade: 'F',
    results: [],
    findings: [],
    ...over,
  } as never;
}

describe('buildRepairBrief', () => {
  it('prioritizes findings by severity and keeps file:line', () => {
    const brief = buildRepairBrief(report({
      findings: [
        finding({ severity: 'info', evidence: 'i', location: { file: 'z.ts', line: 9 } }),
        finding({ severity: 'critical', evidence: 'c', location: { file: 'a.ts', line: 2 } }),
        finding({ severity: 'high', evidence: 'h', location: { file: 'b.ts', line: 1 } }),
      ],
    }));
    expect(brief.items.map((i) => i.severity)).toEqual(['critical', 'high', 'info']);
    expect(brief.items[0]).toMatchObject({ rank: 1, file: 'a.ts', line: 2, title: 'c' });
    expect(brief.total).toBe(3);
    expect(brief.omitted).toBe(0);
  });

  it('uses analyzer remediation verbatim and derives one when absent', () => {
    const brief = buildRepairBrief(report({
      findings: [
        finding({ category: 'cve', evidence: 'CVE-2026-1', remediation: 'Upgrade to 2.0.0' }),
        finding({ category: 'npe', evidence: 'unchecked deref' }),
      ],
    }));
    const withFix = brief.items.find((i) => i.category === 'cve')!;
    expect(withFix.remediation).toBe('Upgrade to 2.0.0');
    expect(withFix.remediationFromAnalyzer).toBe(true);
    const derived = brief.items.find((i) => i.category === 'npe')!;
    expect(derived.remediationFromAnalyzer).toBe(false);
    expect(derived.remediation.toLowerCase()).toContain('guard');
  });

  it('caps items and reports how many were omitted', () => {
    const findings = Array.from({ length: 5 }, (_, i) => finding({ evidence: `f${i}`, location: { file: `f${i}.ts`, line: i + 1 } }));
    const brief = buildRepairBrief(report({ findings }), { maxItems: 2 });
    expect(brief.items).toHaveLength(2);
    expect(brief.total).toBe(5);
    expect(brief.omitted).toBe(3);
  });

  it('separates blocked tools from score-only scorers', () => {
    const brief = buildRepairBrief(report({
      results: [
        { scorer: 'reporank', score: 88, summary: 'grade B', findings: [] },
        { scorer: 'grader', score: null, summary: 'broken', error: 'missing dep' },
        { scorer: 'deep', score: 70, summary: '3 findings', findings: [finding()] },
      ],
    }));
    expect(brief.blockedTools.map((b) => b.scorer)).toEqual(['grader']);
    expect(brief.scoreOnlyScorers.map((s) => s.scorer)).toEqual(['reporank']);
    expect(brief.scoreOnlyScorers[0].score).toBe(88);
  });

  it('tolerates a report with no findings/results (legacy shape)', () => {
    const brief = buildRepairBrief({ overallStatus: 'fail', findings: undefined, results: undefined } as never);
    expect(brief.items).toEqual([]);
    expect(brief.total).toBe(0);
    expect(brief.blockedTools).toEqual([]);
    expect(brief.grade).toBe('N/A');
  });
});

describe('renderRepairBrief', () => {
  it('renders the header, prioritized items, score-only and blocked sections', () => {
    const brief = buildRepairBrief(report({
      findings: [finding({ severity: 'critical', evidence: 'boom', location: { file: 'src/a.ts', line: 3 }, remediation: 'fix it' })],
      results: [
        { scorer: 'reporank', score: 88, summary: 'grade B' },
        { scorer: 'grader', score: null, summary: 'broken', error: 'missing dep' },
      ],
    }));
    const text = renderRepairBrief(brief);
    expect(text).toContain('OPENHUB REPAIR BRIEF');
    expect(text).toContain('src/a.ts:3');
    expect(text).toContain('-> fix it');
    expect(text).toContain('SCORE-ONLY');
    expect(text).toContain('BLOCKED TOOLS');
    expect(text).toContain('grader');
  });

  it('bounds output to maxChars', () => {
    const findings = Array.from({ length: 200 }, (_, i) => finding({ severity: 'medium', evidence: `finding number ${i} with some detail`, location: { file: `src/file${i}.ts`, line: i + 1 } }));
    const brief = buildRepairBrief(report({ findings }));
    const text = renderRepairBrief(brief, { maxChars: 500 });
    expect(text.length).toBeLessThanOrEqual(500);
    expect(text).toContain('OPENHUB REPAIR BRIEF');
  });
});
