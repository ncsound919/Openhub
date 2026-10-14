import { describe, it, expect } from 'vitest';
import {
  matchesGlob, isPathIncluded, filterPaths, expandBraces, normalizePath,
  MAX_BRACE_ALTERNATIVES, MAX_BRACE_EXPANSIONS, MAX_GLOB_PATTERN_LENGTH,
} from '../src/core/glob';

describe('glob', () => {
  it('normalizes paths', () => {
    expect(normalizePath('.\\src\\a.ts')).toBe('src/a.ts');
    expect(normalizePath('/src/a.ts')).toBe('src/a.ts');
    expect(normalizePath('./a.ts')).toBe('a.ts');
  });

  it('matches ** at any depth', () => {
    expect(matchesGlob('a.test.ts', '**/*.test.ts')).toBe(true);
    expect(matchesGlob('src/deep/a.test.ts', '**/*.test.ts')).toBe(true);
    expect(matchesGlob('src/a.ts', '**/*.test.ts')).toBe(false);
  });

  it('a pattern without a slash matches at any depth', () => {
    expect(matchesGlob('src/deep/a.ts', '*.ts')).toBe(true);
    expect(matchesGlob('src/a.ts', 'a.ts')).toBe(true);
  });

  it('* does not cross a path separator, ? matches one char', () => {
    expect(matchesGlob('src/a.ts', 'src/*.ts')).toBe(true);
    expect(matchesGlob('src/deep/a.ts', 'src/*.ts')).toBe(false);
    expect(matchesGlob('src/ab.ts', 'src/a?.ts')).toBe(true);
    expect(matchesGlob('src/abc.ts', 'src/a?.ts')).toBe(false);
  });

  it('src/** matches everything under src', () => {
    expect(matchesGlob('src/a.ts', 'src/**')).toBe(true);
    expect(matchesGlob('src/deep/a.ts', 'src/**')).toBe(true);
    expect(matchesGlob('test/a.ts', 'src/**')).toBe(false);
  });

  it('expands {a,b} alternation', () => {
    expect(expandBraces('src/*.{ts,tsx}')).toEqual(['src/*.ts', 'src/*.tsx']);
    expect(matchesGlob('src/a.tsx', 'src/*.{ts,tsx}')).toBe(true);
    expect(matchesGlob('src/a.js', 'src/*.{ts,tsx}')).toBe(false);
  });

  it('applies include/exclude with exclude winning', () => {
    expect(isPathIncluded('src/a.ts', [], [])).toBe(true);
    expect(isPathIncluded('src/a.ts', ['src/**'], [])).toBe(true);
    expect(isPathIncluded('docs/a.md', ['src/**'], [])).toBe(false);
    expect(isPathIncluded('src/a.test.ts', ['src/**'], ['**/*.test.ts'])).toBe(false);
    expect(filterPaths(['src/a.ts', 'src/a.test.ts', 'docs/x.md'], ['src/**'], ['**/*.test.ts'])).toEqual(['src/a.ts']);
  });

  it('ignores a leading ! marker on a single pattern', () => {
    expect(matchesGlob('src/a.ts', '!src/a.ts')).toBe(true);
  });
  it('caps brace expansion instead of exploding (config bomb)', () => {
    // 2^20 expansions uncapped; must stay bounded and fast.
    const bomb = '{a,b}'.repeat(20);
    const started = Date.now();
    const out = expandBraces(bomb);
    expect(out.length).toBeLessThanOrEqual(MAX_BRACE_EXPANSIONS);
    expect(out).toEqual([bomb]); // over the cap: braces kept literally
    expect(matchesGlob('ab', bomb)).toBe(false);
    expect(matchesGlob('{a,b}'.repeat(20), bomb)).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('caps alternatives per group and pattern length', () => {
    const many = `{${Array.from({ length: MAX_BRACE_ALTERNATIVES + 1 }, (_, i) => `x${i}`).join(',')}}`;
    expect(expandBraces(many)).toEqual([many]);
    const ok = `{${Array.from({ length: MAX_BRACE_ALTERNATIVES }, (_, i) => `x${i}`).join(',')}}`;
    expect(expandBraces(ok)).toHaveLength(MAX_BRACE_ALTERNATIVES);
    // 8 * 8 * 4 = 256 is exactly at the total cap; one more doubling is over.
    const g8 = '{a,b,c,d,e,f,g,h}';
    expect(expandBraces(`${g8}${g8}{1,2,3,4}`)).toHaveLength(256);
    expect(expandBraces(`${g8}${g8}{1,2,3,4,5}`)).toHaveLength(1);
    const long = `src/${'a'.repeat(MAX_GLOB_PATTERN_LENGTH)}/{x,y}`;
    expect(expandBraces(long)).toEqual([long]);
    expect(matchesGlob(`src/${'a'.repeat(MAX_GLOB_PATTERN_LENGTH)}/x`, long)).toBe(false);
  });

  it('still matches through the compiled-pattern cache on repeated calls', () => {
    for (let i = 0; i < 3; i += 1) {
      expect(matchesGlob('src/a.tsx', 'src/*.{ts,tsx}')).toBe(true);
      expect(matchesGlob('src/a.js', 'src/*.{ts,tsx}')).toBe(false);
    }
  });
});
