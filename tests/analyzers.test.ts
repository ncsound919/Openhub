import { afterAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  SUPPORTED_EXTENSIONS,
  analyzersForExt,
  collectSourceFiles,
  formatLanguageBreakdown,
  languageForExt,
  languageForPath,
} from '../src/services/analyzers';

const dirs: string[] = [];

function tmpProject(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openhub-analyzers-'));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  return dir;
}

function cleanup(): void {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
}

afterAll(cleanup);

describe('language registry', () => {
  it('maps extensions to languages, including Python', () => {
    expect(languageForExt('.py')).toBe('python');
    expect(languageForExt('.PY')).toBe('python');
    expect(languageForExt('.ts')).toBe('typescript');
    expect(languageForExt('.tsx')).toBe('typescript');
    expect(languageForExt('.js')).toBe('javascript');
    expect(languageForExt('.go')).toBe('go');
    expect(languageForExt('.rs')).toBe('rust');
    expect(languageForExt('.java')).toBe('java');
    expect(languageForExt('.nope')).toBe('text');
    expect(languageForPath('engine/main.py')).toBe('python');
  });

  it('lists the analyzers per extension', () => {
    expect(analyzersForExt('.py')).toContain('ruff');
    expect(analyzersForExt('.ts')).toContain('tsc');
    expect(SUPPORTED_EXTENSIONS).toContain('.py');
  });
});

describe('collectSourceFiles', () => {
  it('collects Python and TS, skipping vendors and dot dirs', () => {
    const dir = tmpProject({
      'engine/main.py': 'print(1)',
      'api/service.py': 'x = 1',
      'ui/app.tsx': 'export const A = 1;',
      'node_modules/dep/index.js': 'x',
      '.venv/lib/thing.py': 'x',
      '__pycache__/main.cpython-312.pyc': 'x',
      'README.md': 'docs',
    });
    const files = collectSourceFiles(dir);
    expect(files.map((f) => f.file).sort()).toEqual(['api/service.py', 'engine/main.py', 'ui/app.tsx']);
    expect(files.find((f) => f.file === 'engine/main.py')!.language).toBe('python');
  });

  it('honours an extension allow-list and the file cap', () => {
    const dir = tmpProject({ 'a.py': 'x', 'b.ts': 'x' });
    expect(collectSourceFiles(dir, { extensions: ['.py'] }).map((f) => f.file)).toEqual(['a.py']);

    const many = fs.mkdtempSync(path.join(os.tmpdir(), 'openhub-analyzers-many-'));
    dirs.push(many);
    for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(many, `f${i}.py`), 'x');
    expect(collectSourceFiles(many, { maxFiles: 5 })).toHaveLength(5);
  });

  it('returns an empty list for a missing directory', () => {
    expect(collectSourceFiles(path.join(os.tmpdir(), 'openhub-analyzers-none'))).toEqual([]);
  });
});

describe('formatLanguageBreakdown', () => {
  it('summarizes languages and unsupported files', () => {
    const breakdown = formatLanguageBreakdown([
      { file: 'a.py', content: '', language: 'python' },
      { file: 'b.py', content: '', language: 'python' },
      { file: 'c.ts', content: '', language: 'typescript' },
      { file: 'd.txt', content: '', language: 'text' },
    ]);
    expect(breakdown.files).toBe(4);
    expect(breakdown.counts).toEqual({ python: 2, typescript: 1 });
    expect(breakdown.unsupported).toBe(1);
    expect(breakdown.summary).toContain('2 py');
    expect(breakdown.summary).toContain('1 ts');
    expect(breakdown.summary).toContain('1 unsupported');
  });
});
