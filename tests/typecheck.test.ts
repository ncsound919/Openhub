import { describe, it, expect } from 'vitest';
import { parseTscOutput } from '../src/services/typecheck';

describe('parseTscOutput', () => {
  it('parses tsc --pretty false error lines', () => {
    const out = [
      "src/foo.ts(12,5): error TS2304: Cannot find name 'bar'.",
      "src/nested/baz.tsx(3,1): error TS1005: ';' expected.",
      '',
      'Found 2 errors in 2 files.',
    ].join('\n');
    const p = parseTscOutput(out);
    expect(p).toHaveLength(2);
    expect(p[0]).toEqual({ file: 'src/foo.ts', line: 12, col: 5, code: 'TS2304', message: "Cannot find name 'bar'." });
    expect(p[1].file).toBe('src/nested/baz.tsx');
  });

  it('normalizes windows separators and ignores non-error lines', () => {
    const p = parseTscOutput('src\\a.ts(1,1): error TS1234: boom\nsrc/a.ts(2,2): warning TS9: nope');
    expect(p).toHaveLength(1);
    expect(p[0].file).toBe('src/a.ts');
    expect(p[0].code).toBe('TS1234');
  });

  it('caps the number of problems', () => {
    const line = 'a.ts(1,1): error TS1: x';
    const p = parseTscOutput(Array(600).fill(line).join('\n'), 10);
    expect(p).toHaveLength(10);
  });
});
