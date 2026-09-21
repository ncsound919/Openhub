import { describe, it, expect } from 'vitest';
import { matchesGlob, isPathIncluded, filterPaths, expandBraces, normalizePath } from '../src/core/glob';

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
});
