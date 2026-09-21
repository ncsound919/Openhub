import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  collectDeepFiles,
  discoverTestRunners,
  executeAuditSuite,
  parseEslintJson,
  parseRuffText,
  parseTscOutput,
  reconcileResults,
  runDeepScorer,
  runLocalQaScorer,
  scopeFindings,
  type ScorerResult,
} from '../src/services/auditSuite';
import { createFinding } from '../src/services/findings';

const dirs: string[] = [];

function tmpProject(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openhub-v2-'));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  return dir;
}

afterEach(() => {
  for (const d of dirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* best-effort */ }
  }
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function scorer(over: Partial<ScorerResult> & { scorer: string; score: number | null }): ScorerResult {
  return { summary: '', ...over };
}

describe('reconcileResults v2 (dimension rollup)', () => {
  it('rolls scorer scores into dimensions and reports a deterministic score', () => {
    const rec = reconcileResults([
      scorer({ scorer: 'deep', score: 100, dimension: 'correctness', determinism: 'static' }),
      scorer({ scorer: 'claw-protect', score: 90, dimension: 'security', determinism: 'static' }),
      scorer({ scorer: 'local_qa', score: 100, dimension: 'tests', determinism: 'static' }),
    ]);
    expect(rec.model).toBe('dimension-v2');
    expect(rec.weightedScore).toBe(97);
    expect(rec.deterministicScore).toBe(97);
    expect(rec.dimensions.map((d) => d.dimension)).toEqual(['security', 'correctness', 'tests']);
  });

  it('caps LLM influence within a dimension and keeps a deterministic score', () => {
    const rec = reconcileResults([
      scorer({ scorer: 'deep', score: 100, dimension: 'correctness', determinism: 'static' }),
      scorer({ scorer: 'reporank', score: 0, dimension: 'correctness', determinism: 'llm' }),
    ]);
    const correctness = rec.dimensions[0];
    expect(correctness.score).toBe(80); // 100*0.8 + 0*0.2
    expect(correctness.llm).toBe(0);
    expect(correctness.llmCapped).toBe(true);
    expect(correctness.llmShare).toBeCloseTo(0.2, 5);
    expect(rec.deterministicScore).toBe(100);
    expect(rec.llmShare).toBeCloseTo(0.2, 5);
  });

  it('reports null deterministicScore when only LLM evidence exists', () => {
    const rec = reconcileResults([scorer({ scorer: 'grader', score: 90, determinism: 'llm' })]);
    expect(rec.weightedScore).toBe(90);
    expect(rec.deterministicScore).toBeNull();
  });

  it('never folds an unavailable scorer in as a zero', () => {
    const rec = reconcileResults([
      scorer({ scorer: 'deep', score: 50, dimension: 'correctness', determinism: 'static' }),
      { scorer: 'sca', score: null, summary: '', error: 'key missing' },
    ]);
    expect(rec.weightedScore).toBe(50);
    expect(rec.excluded).toEqual([{ scorer: 'sca', reason: 'key missing' }]);
  });

  it('collapses reporank + grader into one llm-review vote (no double-count)', () => {
    const rec = reconcileResults([
      scorer({ scorer: 'deep', score: 100, dimension: 'correctness', determinism: 'static' }),
      scorer({ scorer: 'reporank', score: 60, dimension: 'correctness', determinism: 'llm' }),
      scorer({ scorer: 'grader', score: 40, dimension: 'correctness', determinism: 'llm' }),
    ]);
    const llm = rec.contributing.find((c) => c.scorer === 'LLM repo review');
    expect(llm).toBeTruthy();
    expect(llm!.weight).toBe(2); // not 4 — one vote, not two
    expect(llm!.score).toBe(50); // mean of 60 and 40
    expect(llm!.members).toEqual(['reporank', 'grader']);
    // static 100 (w2) blended with llm 50 (w2), LLM share capped at 20% => 90
    const correctness = rec.dimensions.find((d) => d.dimension === 'correctness')!;
    expect(correctness.score).toBe(90);
  });

  it('floors a multi-analyzer dimension so one noisy scorer cannot zero it', () => {
    const rec = reconcileResults([
      scorer({ scorer: 'deep', score: 0, dimension: 'correctness', determinism: 'static' }),
      scorer({ scorer: 'typecheck', score: 0, dimension: 'correctness', determinism: 'static' }),
    ]);
    expect(rec.dimensions.find((d) => d.dimension === 'correctness')!.score).toBe(15);
  });

  it('does not floor a single-analyzer dimension', () => {
    const rec = reconcileResults([
      scorer({ scorer: 'deep', score: 0, dimension: 'correctness', determinism: 'static' }),
    ]);
    expect(rec.dimensions.find((d) => d.dimension === 'correctness')!.score).toBe(0);
  });
});

describe('discoverTestRunners (all runners, root + nested)', () => {
  it('finds nested package.json runners and a python runner', () => {
    const dir = tmpProject({
      'package.json': JSON.stringify({ name: 'root', scripts: { test: 'jest' } }),
      'ui-v2/package.json': JSON.stringify({ name: 'ui', scripts: { test: 'vitest' } }),
      'pyproject.toml': '[project]\nname = "x"\n',
    });
    const specs = discoverTestRunners(dir);
    expect(specs.map((s) => s.runner).sort()).toEqual(['jest', 'pytest', 'vitest']);
    expect(specs.find((s) => s.runner === 'vitest')!.cwd).toBe(path.join(dir, 'ui-v2'));
  });

  it('returns nothing when no runner is declared', () => {
    expect(discoverTestRunners(tmpProject({ 'README.md': 'x' }))).toEqual([]);
  });
});

describe('local_qa structured reporting', () => {
  it('passes and covers the tests dimension for a clean runner', async () => {
    const dir = tmpProject({ 'package.json': JSON.stringify({ name: 'q', scripts: { test: 'node -e "process.exit(0)"' } }) });
    const r = await runLocalQaScorer(dir);
    expect(r.score).toBe(100);
    expect(r.dimension).toBe('tests');
    expect(r.findings).toEqual([]);
    expect(r.status).toBe('ok');
  }, 90_000);

  it('emits a finding isolating a failing runner', async () => {
    const dir = tmpProject({ 'package.json': JSON.stringify({ name: 'q', scripts: { test: 'node -e "process.exit(3)"' } }) });
    const r = await runLocalQaScorer(dir);
    expect(r.score).toBe(0);
    expect(r.findings!.length).toBe(1);
    expect(r.findings![0]).toMatchObject({ source: 'local_qa', category: 'test-failure', dimension: 'tests' });
  }, 90_000);
});

describe('deep .py coverage + browser libs', () => {
  it('collects Python files and maps the language', () => {
    const dir = tmpProject({ 'engine/main.py': 'print(1)', 'ui/app.tsx': 'export const A = 1;' });
    const files = collectDeepFiles(dir);
    expect(files.map((f) => f.file).sort()).toEqual(['engine/main.py', 'ui/app.tsx']);
    expect(files.find((f) => f.file === 'engine/main.py')!.language).toBe('python');
  });

  it('reports a language breakdown and sends per-language options', async () => {
    vi.stubEnv('DEEP_URL', 'http://deep:9');
    const dir = tmpProject({ 'engine/main.py': 'print(1)' });
    const calls: Array<{ url: string; body: any }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? '{}')) });
      return new Response(JSON.stringify({ findings: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const r = await runDeepScorer(dir);
    expect(r.score).toBe(100);
    expect(r.summary).toContain('1 py');
    expect((r.details as any).languageBreakdown.counts.python).toBe(1);
    expect(calls[0].body.languageOptions.typescript.lib).toContain('DOM');
  });
});

describe('diff-scope filtering (E1)', () => {
  const mk = (file: string) => createFinding({
    source: 'lint', dimension: 'maintainability', category: 'lint:X', severity: 'low', location: { file },
  });

  it('keeps only findings in the changed files, and keeps unattributed ones', () => {
    const findings = [mk('a.py'), mk('b.py'), createFinding({ source: 'lint', dimension: 'maintainability', category: 'lint:no-file', severity: 'low' })];
    const scoped = scopeFindings(findings, new Set(['a.py']));
    expect(scoped.map((f) => f.location?.file ?? '(none)')).toEqual(['a.py', '(none)']);
  });

  it('is a no-op when no scope is supplied', () => {
    const findings = [mk('a.py'), mk('b.py')];
    expect(scopeFindings(findings)).toBe(findings);
  });
});

describe('typecheck / lint parsers', () => {
  it('parses tsc errors into locations', () => {
    const out = "src/a.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'.\n";
    const findings = parseTscOutput(out, '/repo');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ source: 'typecheck', category: 'type-error', location: { file: 'src/a.ts', line: 3 } });
    expect(findings[0].evidence).toContain('TS2322');
  });

  it('parses eslint JSON output', () => {
    const findings = parseEslintJson([{ filePath: '/repo/src/a.ts', messages: [{ ruleId: 'no-unused-vars', severity: 2, line: 4, message: 'unused' }] }], '/repo');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ source: 'lint', category: 'lint:no-unused-vars' });
  });

  it('parses ruff concise output', () => {
    const findings = parseRuffText('engine/main.py:10:1: F401 os imported but unused\n', '/repo');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ category: 'lint:F401', location: { file: 'engine/main.py', line: 10 } });
  });
});

describe('executeAuditSuite report shape (P0)', () => {
  it('dedups findings, reports coverage and a deterministic score', async () => {
    const dir = tmpProject({ 'package.json': JSON.stringify({ name: 'q', scripts: { test: 'node -e "process.exit(3)"' } }) });
    const report = await executeAuditSuite({ targetDir: dir, scorers: ['local_qa'] });
    expect(report.coverage.total).toBe(12);
    expect(report.coverage.uncovered).toBeGreaterThan(0);
    expect(report.coverage.dimensions.find((d) => d.dimension === 'tests')!.status).toBe('covered');
    expect(report.findings.length).toBeGreaterThanOrEqual(1);
    expect(report.dedup.input).toBe(report.findings.length);
    expect(report.overallScoreDeterministic).toBe(report.overallScore);
    expect(report.reconciliation.model).toBe('dimension-v2');
    expect(report.coveragePercent).toBe(Math.round((report.coverage.covered / report.coverage.total) * 100));
  }, 90_000);
});
