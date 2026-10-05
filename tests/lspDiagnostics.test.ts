import { describe, it, expect } from 'vitest';
import { toMonacoMarkers, lspLanguageSupported, type MarkerSeverityMap } from '../src/ide/lspDiagnostics';

const SEV: MarkerSeverityMap = { error: 8, warning: 4, info: 2, hint: 1 };

describe('lspLanguageSupported', () => {
  it('accepts the languages Axiom LSP serves', () => {
    expect(lspLanguageSupported('src/a.ts')).toBe(true);
    expect(lspLanguageSupported('a.tsx')).toBe(true);
    expect(lspLanguageSupported('a.js')).toBe(true);
    expect(lspLanguageSupported('a.py')).toBe(true);
  });
  it('rejects languages with no configured server', () => {
    expect(lspLanguageSupported('a.go')).toBe(false);
    expect(lspLanguageSupported('README.md')).toBe(false);
    expect(lspLanguageSupported('Dockerfile')).toBe(false);
  });
});

describe('toMonacoMarkers', () => {
  it('converts 0-based LSP positions to 1-based Monaco positions', () => {
    const out = toMonacoMarkers([{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, severity: 1, message: 'err' }], SEV);
    expect(out).toEqual([{ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 6, severity: 8, message: 'err' }]);
  });

  it('maps LSP severities to the supplied Monaco severities', () => {
    const mk = (severity: number) => toMonacoMarkers([{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity, message: 'm' }], SEV)[0].severity;
    expect(mk(1)).toBe(8);
    expect(mk(2)).toBe(4);
    expect(mk(3)).toBe(2);
    expect(mk(4)).toBe(1);
    expect(mk(99)).toBe(4); // unknown -> warning
  });

  it('carries code and source when present', () => {
    const out = toMonacoMarkers([{ range: { start: { line: 2, character: 1 }, end: { line: 2, character: 3 } }, severity: 2, message: 'm', code: 1002, source: 'pyright' }], SEV);
    expect(out[0].code).toBe('1002');
    expect(out[0].source).toBe('pyright');
  });

  it('repairs an inverted range instead of dropping the diagnostic', () => {
    const out = toMonacoMarkers([{ range: { start: { line: 4, character: 5 }, end: { line: 1, character: 0 } }, severity: 1, message: 'm' }], SEV);
    expect(out).toHaveLength(1);
    expect(out[0].endLineNumber).toBe(out[0].startLineNumber);
    expect(out[0].endColumn).toBe(out[0].startColumn);
  });

  it('returns [] for non-array input', () => {
    expect(toMonacoMarkers(undefined as unknown as [], SEV)).toEqual([]);
  });
});
