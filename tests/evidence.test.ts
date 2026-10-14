import { describe, expect, it } from 'vitest';
import { attach, honest, makeFinding } from '../src/services/evidence';

describe('evidence envelope', () => {
  it('stamps dimension, determinism, coverage and status onto a scored result', () => {
    const r = attach({ scorer: 'deep', score: 80, summary: 'x' });
    expect(r.dimension).toBe('correctness');
    expect(r.dimensions).toEqual(['correctness', 'security']);
    expect(r.determinism).toBe('static');
    expect(r.status).toBe('ok');
    expect(r.findings).toEqual([]);
    expect(r.coverage).toEqual({ files: 0, analyzers: ['deep'], dimensions: ['correctness', 'security'] });
  });

  it('records files, analyzers and language when supplied', () => {
    const r = attach(
      { scorer: 'typecheck', score: 100, summary: 'ok' },
      { files: 12, analyzers: ['tsc'], language: 'typescript' },
    );
    expect(r.coverage).toMatchObject({ files: 12, analyzers: ['tsc'], language: 'typescript' });
  });

  it('marks a scored-but-noisy run partial when asked', () => {
    const r = attach({ scorer: 'claw-protect', score: 40, summary: 'x' }, { status: 'partial' });
    expect(r.status).toBe('partial');
  });

  it('honest() returns no score, the error and an unavailable envelope', () => {
    const r = honest('pytest', 'boom');
    expect(r.score).toBeNull();
    expect(r.status).toBe('unavailable');
    expect(r.error).toBe('boom');
    expect(r.summary).toBe('boom');
    expect(r.findings).toEqual([]);
  });

  it('honest() keeps an explicit summary distinct from the error', () => {
    const r = honest('sca', 'backend missing', 'CVE scan skipped');
    expect(r.summary).toBe('CVE scan skipped');
    expect(r.error).toBe('backend missing');
  });
});

describe('makeFinding', () => {
  it('normalizes severity and fingerprints the finding', () => {
    const f = makeFinding({
      source: 'lint',
      dimension: 'maintainability',
      category: 'lint:no-unused-vars',
      severity: 'error',
      determinism: 'static',
      location: { file: 'a.ts', line: 3 },
      evidence: 'unused',
    });
    expect(f.severity).toBe('high');
    expect(f.confidence).toBeGreaterThan(0);
    expect(f.id).toMatch(/^[0-9a-f]{16}$/);
  });

  it('defaults confidence, determinism and severity sensibly', () => {
    const f = makeFinding({ source: 'x', dimension: 'security', category: 'c', severity: 'nonsense' });
    expect(f.severity).toBe('info');
    expect(f.confidence).toBeCloseTo(0.7, 5);
    expect(f.determinism).toBe('static');
    expect(f.location).toBeUndefined();
  });
});
