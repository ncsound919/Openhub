import { describe, it, expect } from 'vitest';
import {
  fixInstructionFor,
  explainInstructionFor,
  fixRangeFor,
  diagnosticKey,
  fixableDiagnostics,
  type DiagnosticLike,
} from '../src/ide/diagnostics';

const base: DiagnosticLike = { line: 3, column: 5, endLine: 3, endColumn: 9, code: 'TS2345', message: "Argument of type 'string' is not assignable to parameter of type 'number'." };

describe('diagnostics — fix instructions', () => {
  it('includes the code and message in the fix instruction', () => {
    const s = fixInstructionFor(base);
    expect(s).toContain('TS2345');
    expect(s).toContain('not assignable');
    expect(s.toLowerCase()).toContain('only the corrected code');
  });

  it('omits the code cleanly when absent', () => {
    const s = fixInstructionFor({ ...base, code: undefined });
    expect(s).not.toContain('undefined');
    expect(s).toContain('compiler error');
  });

  it('builds a concise explain instruction', () => {
    const s = explainInstructionFor(base);
    expect(s).toContain('TS2345');
    expect(s.toLowerCase()).toContain('minimal fix');
  });
});

describe('diagnostics — fix range', () => {
  it('widens a sub-token span to whole lines', () => {
    const r = fixRangeFor(base, 40);
    expect(r).toEqual({ startLineNumber: 3, startColumn: 1, endLineNumber: 3, endColumn: 1_000_000 });
  });

  it('defaults endLine to line when absent', () => {
    const r = fixRangeFor({ ...base, endLine: undefined }, 10);
    expect(r.endLineNumber).toBe(3);
  });

  it('clamps past the end of the document', () => {
    const r = fixRangeFor({ ...base, line: 99, endLine: 120 }, 10);
    expect(r.startLineNumber).toBe(10);
    expect(r.endLineNumber).toBe(10);
  });

  it('never lets endLine precede startLine', () => {
    const r = fixRangeFor({ ...base, line: 5, endLine: 1 }, 20);
    expect(r.startLineNumber).toBe(5);
    expect(r.endLineNumber).toBe(5);
  });

  it('handles a zero/NaN lineCount defensively', () => {
    const r = fixRangeFor({ ...base, line: 3, endLine: 3 }, 0);
    expect(r.startLineNumber).toBe(1);
    expect(r.endLineNumber).toBe(1);
  });
});

describe('diagnostics — identity + filtering', () => {
  it('produces a stable, distinct key', () => {
    expect(diagnosticKey(base)).toBe(diagnosticKey({ ...base }));
    expect(diagnosticKey(base)).not.toBe(diagnosticKey({ ...base, line: 4 }));
  });

  it('drops diagnostics with empty messages', () => {
    const list: DiagnosticLike[] = [base, { ...base, message: '   ' }];
    expect(fixableDiagnostics(list)).toHaveLength(1);
  });
});
