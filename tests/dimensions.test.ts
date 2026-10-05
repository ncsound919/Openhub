import { describe, expect, it } from 'vitest';
import {
  DIMENSIONS,
  DIMENSION_META,
  buildCoverageFromResults,
  determinismForScorer,
  dimensionsForScorer,
  isDimension,
  primaryDimension,
} from '../src/services/dimensions';

describe('dimension taxonomy', () => {
  it('exposes at least 12 dimensions with metadata', () => {
    expect(DIMENSIONS.length).toBeGreaterThanOrEqual(12);
    for (const d of DIMENSIONS) {
      expect(DIMENSION_META[d].id).toBe(d);
      expect(DIMENSION_META[d].weight).toBeGreaterThan(0);
      expect(DIMENSION_META[d].llmCap).toBeGreaterThanOrEqual(0);
    }
  });

  it('validates dimension ids', () => {
    expect(isDimension('security')).toBe(true);
    expect(isDimension('nonsense')).toBe(false);
    expect(isDimension(undefined)).toBe(false);
  });
});

describe('scorer → dimension mapping', () => {
  it('maps known scorers, with the first entry as primary', () => {
    expect(primaryDimension('sca')).toBe('dependencies');
    expect(dimensionsForScorer('sca')).toEqual(['dependencies', 'security']);
    expect(primaryDimension('local_qa')).toBe('tests');
    expect(primaryDimension('typecheck')).toBe('build_ci');
  });

  it('falls back to correctness for unclassified scorers', () => {
    expect(primaryDimension('mystery')).toBe('correctness');
  });

  it('classifies determinism per scorer', () => {
    expect(determinismForScorer('grader')).toBe('llm');
    expect(determinismForScorer('local_qa')).toBe('static');
    expect(determinismForScorer('codegraph')).toBe('heuristic');
    expect(determinismForScorer('mystery')).toBe('heuristic');
  });
});

describe('buildCoverageFromResults', () => {
  it('marks a dimension covered when a mapped scorer scored it', () => {
    const coverage = buildCoverageFromResults([
      { scorer: 'sca', score: 90, findings: [] },
      { scorer: 'claw-protect', score: 100, findings: [] },
    ]);
    const deps = coverage.dimensions.find((d) => d.dimension === 'dependencies')!;
    expect(deps.status).toBe('covered');
    expect(deps.analyzers).toEqual(['sca']);
  });

  it('marks a dimension partial when a mapped scorer failed', () => {
    const coverage = buildCoverageFromResults([
      { scorer: 'sca', score: 90, findings: [] },
      { scorer: 'claw-protect', score: null, error: 'CLAW key missing' },
    ]);
    const security = coverage.dimensions.find((d) => d.dimension === 'security')!;
    expect(security.status).toBe('partial');
    expect(security.blocked).toEqual(['claw-protect']);
    expect(security.analyzers).toEqual(['sca']);
  });

  it('lists uncovered dimensions with a reason', () => {
    const coverage = buildCoverageFromResults([{ scorer: 'deep', score: 80 }]);
    const a11y = coverage.dimensions.find((d) => d.dimension === 'accessibility')!;
    expect(a11y.status).toBe('uncovered');
    expect(a11y.reason).toBeTruthy();
    expect(coverage.uncovered).toBeGreaterThan(0);
    expect(coverage.total).toBe(DIMENSIONS.length);
  });
});
