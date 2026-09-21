import { describe, it, expect } from 'vitest';
import { parseCodeFences, pathFromInfo, normalizeRepoPath } from '../src/ide/composer';

describe('composer — path extraction', () => {
  it('reads a bare path as the fence info', () => {
    expect(pathFromInfo('src/lib/a.ts')).toBe('src/lib/a.ts');
  });
  it('reads an explicit path=', () => {
    expect(pathFromInfo('ts path=src/b.tsx')).toBe('src/b.tsx');
    expect(pathFromInfo('path="src/c.ts"')).toBe('src/c.ts');
  });
  it('reads a path after a language token', () => {
    expect(pathFromInfo('typescript src/d.ts')).toBe('src/d.ts');
  });
  it('ignores a language-only info string', () => {
    expect(pathFromInfo('ts')).toBeNull();
    expect(pathFromInfo('python')).toBeNull();
    expect(pathFromInfo('')).toBeNull();
  });
  it('normalizes backslashes and leading ./', () => {
    expect(normalizeRepoPath('.\\src\\e.ts')).toBe('src/e.ts');
    expect(normalizeRepoPath('./src//f.ts')).toBe('src/f.ts');
  });
});

describe('composer — parseCodeFences', () => {
  it('extracts whole-file edits with a trailing newline', () => {
    const text = 'Sure, here you go:\n\n```src/a.ts\nconst a = 1;\n```\n';
    const { files, ignored } = parseCodeFences(text);
    expect(ignored).toBe(0);
    expect(files).toEqual([{ path: 'src/a.ts', content: 'const a = 1;\n' }]);
  });

  it('accepts path= and language-prefixed fences', () => {
    const text = '```ts path=src/b.tsx\nexport {};\n```\n```ts src/c.ts\nlet c;\n```';
    const { files } = parseCodeFences(text);
    expect(files.map((f) => f.path).sort()).toEqual(['src/b.tsx', 'src/c.ts']);
  });

  it('ignores illustrative blocks with no path', () => {
    const text = '```ts\n// just an example\n```\n```src/real.ts\nconst ok = true;\n```';
    const { files, ignored } = parseCodeFences(text);
    expect(ignored).toBe(1);
    expect(files).toEqual([{ path: 'src/real.ts', content: 'const ok = true;\n' }]);
  });

  it('lets a later block for the same path win (revision)', () => {
    const text = '```src/x.ts\nv1\n```\n```src/x.ts\nv2\n```';
    const { files } = parseCodeFences(text);
    expect(files).toEqual([{ path: 'src/x.ts', content: 'v2\n' }]);
  });

  it('returns nothing for prose with no fences', () => {
    expect(parseCodeFences('I could not find that file.')).toEqual({ files: [], ignored: 0 });
  });

  it('preserves multi-line bodies verbatim', () => {
    const body = 'line1\n  line2\n\nline4';
    const { files } = parseCodeFences('```src/m.ts\n' + body + '\n```');
    expect(files[0].content).toBe(body + '\n');
  });
});
