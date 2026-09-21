import { describe, expect, it } from 'vitest';
import {
  createFinding,
  dedupeFindings,
  dedupKey,
  findingId,
  scoreFromFindings,
  severityFromString,
  type Finding,
} from '../src/services/findings';

function finding(over: Partial<Parameters<typeof createFinding>[0]> = {}): Finding {
  return createFinding({
    source: 'deep',
    dimension: 'security',
    category: 'secret',
    severity: 'high',
    confidence: 0.6,
    determinism: 'static',
    location: { file: 'src/a.ts', line: 10 },
    evidence: 'AWS_SECRET_ACCESS_KEY = ...',
    ...over,
  });
}

describe('severityFromString', () => {
  it('normalizes analyzer severities and aliases', () => {
    expect(severityFromString('CRITICAL')).toBe('critical');
    expect(severityFromString('error')).toBe('high');
    expect(severityFromString('warning')).toBe('medium');
    expect(severityFromString('moderate')).toBe('medium');
    expect(severityFromString('note')).toBe('info');
    expect(severityFromString(undefined)).toBe('info');
    expect(severityFromString('nonsense')).toBe('info');
  });
});

describe('location truth', () => {
  it('marks located findings true and unlocated findings false', () => {
    expect(finding().locatable).toBe(true);
    const noLoc = createFinding({ source: 'deep', dimension: 'correctness', category: 'x', severity: 'info', evidence: 'e' });
    expect(noLoc.locatable).toBe(false);
    expect(noLoc.location).toBeUndefined();
  });
});

describe('finding fingerprints', () => {
  it('is stable per tool and independent of evidence wording changes', () => {
    const a = finding({ evidence: 'one' });
    const b = finding({ evidence: 'one' });
    expect(a.id).toBe(b.id);
    expect(a.id).toBe(findingId(a));
  });

  it('dedups cross-tool by location, not by producer', () => {
    const secret = { dimension: 'security' as const, category: 'secret', location: { file: 'src/a.ts', line: 10 } };
    expect(dedupKey(finding({ ...secret, source: 'claw-protect' })))
      .toBe(dedupKey(finding({ ...secret, source: 'sca' })));
  });

  it('dedups CVEs by id regardless of location', () => {
    const a = finding({ dimension: 'dependencies', category: 'cve', cve: 'CVE-2024-1234', location: { file: 'a/package.json' } });
    const b = finding({ dimension: 'dependencies', category: 'cve', cve: 'CVE-2024-1234', location: { file: 'b/package.json' } });
    expect(dedupKey(a)).toBe(dedupKey(b));
  });

  it('keeps distinct issues in the same file apart when there is no line', () => {
    const a = finding({ evidence: 'issue one' });
    const b = finding({ evidence: 'issue two' });
    const noLine = (f: Finding): Finding => ({ ...f, location: { file: 'src/a.ts' } });
    expect(dedupKey(noLine(a))).not.toBe(dedupKey(noLine(b)));
  });
});

describe('dedupeFindings', () => {
  it('collapses corroborating sources and raises confidence', () => {
    const sources = ['claw-protect', 'sca', 'ocr', 'deep'];
    const result = dedupeFindings(sources.map((source) => finding({ source })));
    expect(result.findings).toHaveLength(1);
    expect(result.stats).toMatchObject({ input: 4, unique: 1, duplicates: 3, corroborated: 1 });
    expect(result.findings[0].source).toBe('claw-protect');
    expect(result.findings[0].corroboratedBy?.sort()).toEqual(['deep', 'ocr', 'sca']);
    expect(result.findings[0].confidence).toBeCloseTo(0.6 + 0.3, 5);
  });

  it('prefers the highest severity as the primary finding', () => {
    const result = dedupeFindings([
      finding({ source: 'a', severity: 'low' }),
      finding({ source: 'b', severity: 'critical' }),
    ]);
    expect(result.findings[0].severity).toBe('critical');
    expect(result.findings[0].source).toBe('b');
  });

  it('reports a dedup ratio and per-source counts', () => {
    const result = dedupeFindings([
      finding({ source: 'x' }),
      finding({ source: 'x' }),
      finding({ source: 'y', location: { file: 'src/b.ts', line: 1 } }),
    ]);
    expect(result.stats.bySource).toEqual({ x: 2, y: 1 });
    expect(result.stats.dedupRatio).toBeCloseTo(1 / 3, 3);
  });

  it('returns an empty result for no findings', () => {
    const result = dedupeFindings([]);
    expect(result.findings).toEqual([]);
    expect(result.stats).toMatchObject({ input: 0, unique: 0, duplicates: 0, dedupRatio: 0 });
  });
});

describe('scoreFromFindings', () => {
  it('weights by severity and confidence', () => {
    const clean = scoreFromFindings([]);
    expect(clean).toBe(100);
    const oneHigh = scoreFromFindings([finding({ severity: 'high', confidence: 1 })]);
    expect(oneHigh).toBe(90);
    const halfConfidence = scoreFromFindings([finding({ severity: 'high', confidence: 0.5 })]);
    expect(halfConfidence).toBe(95);
  });

  it('caps the total deduction so one noisy tool cannot zero the grade', () => {
    const many = Array.from({ length: 50 }, (_, i) =>
      finding({ severity: 'critical', confidence: 1, location: { file: `src/f${i}.ts`, line: 1 } }),
    );
    expect(scoreFromFindings(many)).toBe(25); // 100 - cap 75
  });
});
