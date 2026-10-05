import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseIgnoreFile, loadGitIgnore } from '../src/core/gitignore';

const dirs: string[] = [];
function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gitignore-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/**
 * Build a matcher from literal .gitignore text, no filesystem needed.
 * Mirrors loadGitIgnore's resolution so the PATTERN rules are tested here and
 * the FILE loading is tested below, rather than one helper hiding both.
 */
function matcher(text: string) {
  const rules = parseIgnoreFile(text, '');
  return (relPath: string, isDir = false) => {
    const wasDir = isDir || /\/$/.test(relPath);
    const p = relPath.replace(/\/+$/, '');
    const ancestors: string[] = [];
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) ancestors.push(parts.slice(0, i).join('/'));
    let ignored = false;
    let best = -1;
    for (const r of rules) {
      if (r.dirOnly) {
        const self = wasDir && r.body.test(p);
        if (!self && !ancestors.some((a) => r.body.test(a))) continue;
      }
      if (!r.body.test(p)) continue;
      const depth = r.base ? r.base.split('/').length : 0;
      if (depth > best) { best = depth; ignored = !r.negated; }
      else if (depth === best) ignored = !r.negated;
    }
    return ignored;
  };
}

describe('gitignore pattern matching', () => {
  it('ignores comments and blank lines', () => {
    const m = matcher('# a comment\n\n   \n*.log\n');
    expect(m('debug.log')).toBe(true);
    expect(m('src/index.ts')).toBe(false);
  });

  it('matches a bare name at any depth', () => {
    const m = matcher('node_modules\n');
    expect(m('node_modules')).toBe(true);
    expect(m('packages/a/node_modules')).toBe(true);
    expect(m('src/node_modules_helper.ts')).toBe(false);
  });

  it('treats a trailing slash as directory-only', () => {
    const m = matcher('build/\n');
    expect(m('build', true)).toBe(true);
    expect(m('build/out.o')).toBe(true);
    // A FILE named exactly `build` is not matched by `build/`.
    expect(m('build')).toBe(false);
  });

  it('anchors a pattern containing a slash', () => {
    const m = matcher('/dist\n');
    expect(m('dist')).toBe(true);
    expect(m('packages/a/dist')).toBe(false);
  });

  it('anchors a dir-only slash pattern to its directory', () => {
    const m = matcher('docs/api/\n');
    expect(m('docs/api', true)).toBe(true);
    expect(m('docs/api/v1.md')).toBe(true);
    // `docs/api/` is anchored, so a nested `docs/api` elsewhere is not matched.
    expect(m('packages/docs/api/v1.md')).toBe(false);
  });

  it('handles ** as any number of directories', () => {
    const m = matcher('**/generated\n');
    expect(m('generated')).toBe(true);
    expect(m('a/b/c/generated')).toBe(true);
    const m2 = matcher('a/**/b.txt\n');
    expect(m2('a/b.txt')).toBe(true);
    expect(m2('a/x/y/b.txt')).toBe(true);
    expect(m2('x/a/b.txt')).toBe(false);
  });

  it('handles * within a segment and ? as one char', () => {
    const m = matcher('*.tmp\nsrc/*.log\n');
    expect(m('a.tmp')).toBe(true);
    expect(m('deep/nested/a.tmp')).toBe(true);
    expect(m('src/run.log')).toBe(true);
    expect(m('src/sub/run.log')).toBe(false);
    const q = matcher('file?.txt\n');
    expect(q('file1.txt')).toBe(true);
    expect(q('file12.txt')).toBe(false);
  });

  it('lets a later negation re-include, and lets the last rule win', () => {
    const m = matcher('*.log\n!keep.log\n');
    expect(m('drop.log')).toBe(true);
    expect(m('keep.log')).toBe(false);

    // Order matters: the same two rules the other way round give the opposite
    // answer, which is what "last match wins" has to mean to be worth anything.
    const reversed = matcher('!keep.log\n*.log\n');
    expect(reversed('keep.log')).toBe(true);
  });

  it('passes a character class through', () => {
    const m = matcher('*.[oa]\n');
    expect(m('x.o')).toBe(true);
    expect(m('x.a')).toBe(true);
    expect(m('x.c')).toBe(false);
  });

  it('treats an escaped leading # or ! as a literal', () => {
    const m = matcher('\\#notes\n\\!bang\n');
    expect(m('#notes')).toBe(true);
    expect(m('!bang')).toBe(true);
  });

  it('never throws on a malformed pattern', () => {
    expect(() => parseIgnoreFile('[\nunclosed\n', '')).not.toThrow();
    expect(() => parseIgnoreFile('***/\n', '')).not.toThrow();
  });
});

describe('loadGitIgnore', () => {
  it('returns a non-present matcher when there is no .gitignore', () => {
    const m = loadGitIgnore(tmpDir());
    expect(m.present).toBe(false);
    expect(m.ruleCount).toBe(0);
    expect(m.isIgnored('build-dbg/x.o')).toBe(false);
  });

  it('loads the root .gitignore', () => {
    const d = tmpDir();
    fs.writeFileSync(path.join(d, '.gitignore'), 'build-dbg/\n*.log\n');
    const m = loadGitIgnore(d);
    expect(m.present).toBe(true);
    expect(m.ruleCount).toBe(2);
    expect(m.isIgnored('build-dbg/CMakeCache.txt', true)).toBe(true);
    expect(m.isIgnored('app.log')).toBe(true);
    expect(m.isIgnored('src/main.cpp')).toBe(false);
  });

  it('loads a nested .gitignore relative to its own directory', () => {
    const d = tmpDir();
    fs.writeFileSync(path.join(d, '.gitignore'), '*.log\n');
    fs.mkdirSync(path.join(d, 'webui'));
    fs.writeFileSync(path.join(d, 'webui', '.gitignore'), 'dist\n');
    const m = loadGitIgnore(d);
    expect(m.fileCount).toBe(2);
    expect(m.isIgnored('webui/dist', true)).toBe(true);
    expect(m.isIgnored('dist', true)).toBe(false);
    expect(m.isIgnored('webui/app.log')).toBe(true);
  });

  it('lets a nested negation override the root rule for its subtree', () => {
    const d = tmpDir();
    fs.writeFileSync(path.join(d, '.gitignore'), '*.log\n');
    fs.mkdirSync(path.join(d, 'logs'));
    fs.writeFileSync(path.join(d, 'logs', '.gitignore'), '!important.log\n');
    const m = loadGitIgnore(d);
    expect(m.isIgnored('logs/important.log')).toBe(false);
    expect(m.isIgnored('logs/other.log')).toBe(true);
    expect(m.isIgnored('top.log')).toBe(true);
  });

  it('normalizes Windows separators and a leading ./', () => {
    const d = tmpDir();
    fs.writeFileSync(path.join(d, '.gitignore'), 'build/\n');
    const m = loadGitIgnore(d);
    expect(m.isIgnored('build\\out.o')).toBe(true);
    expect(m.isIgnored('./build/out.o')).toBe(true);
    expect(m.isIgnored('build/')).toBe(true);
  });

  it('ignores an empty path rather than throwing', () => {
    const d = tmpDir();
    fs.writeFileSync(path.join(d, '.gitignore'), '*\n');
    expect(loadGitIgnore(d).isIgnored('')).toBe(false);
  });
});