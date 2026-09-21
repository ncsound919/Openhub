import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../src/services/ossReview', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/ossReview')>();
  return { ...actual, fetchOssReview: vi.fn() };
});

import {
  codegangUrl,
  codenexusUrl,
  codegraphScorerResult,
  collectDeepFiles,
  deepUrl,
  executeAuditSuite,
  runClawProtectScorer,
  runCodeGangScorer,
  runCodeNexusScorer,
  runDeepScorer,
  runGraderScorer,
  runLocalQaScorer,
  runRepoRankScorer,
} from '../src/services/auditSuite';
import { fetchOssReview, type OssReviewReport } from '../src/services/ossReview';

const tmpDirs: string[] = [];

function tmp(prefix = 'openhub-audit-cov-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function tmpProject(files: Record<string, string>): string {
  const dir = tmp();
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  return dir;
}

function okJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      /* best-effort */
    }
  }
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.mocked(fetchOssReview).mockReset();
});

describe('service URL helpers', () => {
  it('reads env overrides and strips trailing slashes', () => {
    vi.stubEnv('DEEP_URL', 'http://deep:1///');
    expect(deepUrl()).toBe('http://deep:1');
    vi.stubEnv('DEEP_URL', '');
    expect(deepUrl()).toBe('');

    vi.stubEnv('CODEGANG_URL', 'http://cg:2/');
    expect(codegangUrl()).toBe('http://cg:2');
    vi.stubEnv('CODEGANG_URL', '');
    expect(codegangUrl()).toBe('http://127.0.0.1:3011');

    vi.stubEnv('CODENEXUS_URL', 'http://cn:3/');
    expect(codenexusUrl()).toBe('http://cn:3');
    vi.stubEnv('CODENEXUS_URL', '');
    expect(codenexusUrl()).toBe('http://127.0.0.1:3205');
  });
});

describe('runRepoRankScorer dispatch', () => {
  it('rejects empty, invalid and shorthand URLs before the network', async () => {
    vi.stubEnv('REPORANK_API_KEY', '');
    expect((await runRepoRankScorer('')).error).toContain('no GitHub repo URL');
    expect((await runRepoRankScorer('not a url')).error).toContain('no GitHub repo URL');
    // Shorthand expands and then hits the missing-key guard.
    expect((await runRepoRankScorer('owner/repo')).error).toContain('REPORANK_API_KEY');
    expect((await runRepoRankScorer('https://github.com/owner/repo')).error).toContain('REPORANK_API_KEY');
  });

  it('submits, polls and reads a JSON-string report', async () => {
    vi.stubEnv('REPORANK_API_KEY', 'gr_test');
    vi.stubEnv('REPORANK_POLL_INTERVAL_MS', '1');
    vi.stubEnv('REPORANK_POLL_TIMEOUT_MS', '2000');
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1;
      if (calls === 1) return okJson({ data: { scanId: 'scan-1' } });
      return okJson({ data: { status: 'complete', result: JSON.stringify({ overallScore: 88, gradeCategory: 'B' }) } });
    }));
    const r = await runRepoRankScorer('https://github.com/o/r');
    expect(r.score).toBe(88);
    expect(r.grade).toBe('B');
    expect(r.summary).toContain('B');
  });

  it('reads a flat overallScore and reports a missing scanId', async () => {
    vi.stubEnv('REPORANK_API_KEY', 'gr_test');
    vi.stubEnv('REPORANK_POLL_INTERVAL_MS', '1');
    vi.stubEnv('REPORANK_POLL_TIMEOUT_MS', '2000');
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1;
      if (calls === 1) return okJson({ data: {} });
      return okJson({ data: { status: 'complete', overallScore: 77 } });
    }));
    expect((await runRepoRankScorer('https://github.com/o/r')).error).toContain('no scanId');

    calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1;
      if (calls === 1) return okJson({ data: { scanId: 'scan-2' } });
      return okJson({ data: { status: 'complete', overallScore: 77 } });
    }));
    const r = await runRepoRankScorer('https://github.com/o/r');
    expect(r.score).toBe(77);
  });

  it('reports a completed scan with no score and a scan error honestly', async () => {
    vi.stubEnv('REPORANK_API_KEY', 'gr_test');
    vi.stubEnv('REPORANK_POLL_INTERVAL_MS', '1');
    vi.stubEnv('REPORANK_POLL_TIMEOUT_MS', '2000');
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1;
      if (calls === 1) return okJson({ data: { scanId: 'scan-3' } });
      return okJson({ data: { status: 'complete', result: { gradeCategory: 'C' } } });
    }));
    const noScore = await runRepoRankScorer('https://github.com/o/r');
    expect(noScore.score).toBeNull();
    expect(noScore.error).toContain('overallScore');

    calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1;
      if (calls === 1) return okJson({ data: { scanId: 'scan-4' } });
      return okJson({ data: { status: 'error', error: 'repo too big' } });
    }));
    const failed = await runRepoRankScorer('https://github.com/o/r');
    expect(failed.error).toBe('repo too big');
  });

  it('reports submit failure and times out while polling', async () => {
    vi.stubEnv('REPORANK_API_KEY', 'gr_test');
    vi.stubEnv('REPORANK_POLL_INTERVAL_MS', '1');
    vi.stubEnv('REPORANK_POLL_TIMEOUT_MS', '40');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 502 })));
    const submit = await runRepoRankScorer('https://github.com/o/r');
    expect(submit.error).toContain('scan submit');

    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1;
      if (calls === 1) return okJson({ data: { scanId: 'scan-5' } });
      return new Response('busy', { status: 503 });
    }));
    const timedOut = await runRepoRankScorer('https://github.com/o/r');
    expect(timedOut.error).toContain('timed out');
  });
});

describe('runGraderScorer', () => {
  it('returns honest errors for missing URL and key', async () => {
    expect((await runGraderScorer(undefined as unknown as string)).error).toContain('no GitHub repo URL');
    vi.stubEnv('GRADER_API_KEY', '');
    expect((await runGraderScorer('https://github.com/o/r')).error).toContain('GRADER_API_KEY');
  });

  it('scores a real HealthReport and falls back to its summary', async () => {
    vi.stubEnv('GRADER_API_KEY', 'gr_test');
    vi.stubGlobal('fetch', vi.fn(async () => okJson({ overallScore: 91, gradeCategory: 'A' })));
    const graded = await runGraderScorer('https://github.com/o/r');
    expect(graded.score).toBe(91);
    expect(graded.grade).toBe('A');

    vi.stubGlobal('fetch', vi.fn(async () => okJson({ overallScore: 64, summary: 'decent' })));
    const summary = await runGraderScorer('https://github.com/o/r');
    expect(summary.summary).toBe('decent');
  });

  it('reports a response without a score and a failed HTTP call', async () => {
    vi.stubEnv('GRADER_API_KEY', 'gr_test');
    vi.stubGlobal('fetch', vi.fn(async () => okJson({ gradeCategory: 'D' })));
    expect((await runGraderScorer('https://github.com/o/r')).error).toContain('overallScore');

    vi.stubGlobal('fetch', vi.fn(async () => okJson({ error: 'quota' }, 429)));
    const failed = await runGraderScorer('https://github.com/o/r');
    expect(failed.error).toContain('HTTP 429');
    expect(failed.error).toContain('quota');
  });
});

describe('runClawProtectScorer', () => {
  it('scans key files and derives a score from secrets found', async () => {
    vi.stubEnv('CLAW_PROTECT_SYSTEM_AGENT_KEY', 'k');
    const dir = tmpProject({ 'package.json': '{"name":"x"}', '.env': 'A=1' });
    vi.stubGlobal('fetch', vi.fn(async () => okJson({ secretsFound: 0 })));
    const clean = await runClawProtectScorer({ targetDir: dir });
    expect(clean.score).toBe(100);
    expect(clean.summary).toContain('scanned 2 files');

    vi.stubGlobal('fetch', vi.fn(async () => okJson({ secretsFound: 2 })));
    const dirty = await runClawProtectScorer({ targetDir: dir });
    expect(dirty.score).toBe(60);
    expect(dirty.summary).toContain('4 potential secrets');
  });

  it('reports HTTP failures and dirs with nothing to scan', async () => {
    vi.stubEnv('CLAW_PROTECT_SYSTEM_AGENT_KEY', 'k');
    const dir = tmpProject({ 'package.json': '{"name":"x"}' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    const failed = await runClawProtectScorer({ targetDir: dir });
    expect(failed.score).toBeNull();
    expect(failed.error).toContain('HTTP 500');

    const empty = tmpProject({ 'notes.txt': 'nothing here' });
    vi.stubGlobal('fetch', vi.fn(async () => okJson({ secretsFound: 0 })));
    const none = await runClawProtectScorer({ targetDir: empty });
    expect(none.error).toContain('no scannable files');
  });

  it('declines repo-wide scans without a local dir', async () => {
    vi.stubEnv('CLAW_PROTECT_SYSTEM_AGENT_KEY', 'k');
    const repo = await runClawProtectScorer({ repoUrl: 'https://github.com/o/r' });
    expect(repo.score).toBeNull();
    expect(repo.error).toContain('repo-wide');
  });
});

describe('collectDeepFiles', () => {
  it('selects source extensions and maps languages', () => {
    const dir = tmpProject({
      'a.ts': 'a', 'b.tsx': 'b', 'c.js': 'c', 'd.jsx': 'd',
      'e.mjs': 'e', 'f.cjs': 'f', 'g.mts': 'g', 'h.cts': 'h',
      'i.txt': 'i', 'j.json': 'j',
    });
    const byLanguage = collectDeepFiles(dir).map((f) => f.language);
    expect(byLanguage.filter((l) => l === 'typescript')).toHaveLength(4);
    expect(byLanguage.filter((l) => l === 'javascript')).toHaveLength(4);
    expect(collectDeepFiles(dir)).toHaveLength(8);
  });

  it('skips vendor and dot directories', () => {
    const dir = tmpProject({
      'src/keep.ts': 'x',
      'node_modules/dep.ts': 'x',
      'dist/out.ts': 'x',
      '.git/config.ts': 'x',
      'coverage/c.ts': 'x',
      '.turbo/t.ts': 'x',
      'build/b.ts': 'x',
      '.next/n.ts': 'x',
      '.godot/g.ts': 'x',
      'vendor/v.ts': 'x',
      '.vs/s.ts': 'x',
      '.hidden/h.ts': 'x',
    });
    expect(collectDeepFiles(dir).map((f) => f.file)).toEqual(['src/keep.ts']);
  });

  it('enforces the per-file byte cap and the 400-file cap', () => {
    const big = tmpProject({ 'big.ts': 'x'.repeat(2 * 1024 * 1024 + 1) });
    expect(collectDeepFiles(big)).toEqual([]);

    const many = tmp();
    for (let i = 0; i < 405; i++) fs.writeFileSync(path.join(many, `f${i}.ts`), 'x');
    expect(collectDeepFiles(many)).toHaveLength(400);
  }, 60_000);

  it('returns an empty list for a missing directory', () => {
    expect(collectDeepFiles(path.join(os.tmpdir(), 'openhub-audit-none'))).toEqual([]);
  });
});

describe('runDeepScorer mixed passes', () => {
  it('merges successful passes and records the failed ones', async () => {
    vi.stubEnv('DEEP_URL', 'http://deep:9');
    const dir = tmpProject({ 'src/a.ts': 'export const a = 1;' });
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes('static-analysis')) return okJson({ findings: [{ severity: 'critical' }] });
      if (url.includes('bug-taxonomy')) return new Response('nope', { status: 500 });
      return okJson({ notFindings: true });
    }));
    const r = await runDeepScorer(dir);
    expect(r.score).toBe(75);
    expect((r.details as { note: string }).note).toContain('bug-taxonomy HTTP 500');
    expect((r.details as { note: string }).note).toContain('deep-intent: no findings array');
  });

  it('still reports a score when a pass throws but others answer', async () => {
    vi.stubEnv('DEEP_URL', 'http://deep:9');
    const dir = tmpProject({ 'src/a.ts': 'export const a = 1;' });
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      if (String(input).includes('deep-intent')) throw new Error('ECONNRESET');
      return okJson({ findings: [] });
    }));
    const r = await runDeepScorer(dir);
    expect(r.score).toBe(100);
    expect(r.summary).toContain('0 findings');
    expect((r.details as { note: string }).note).toContain('deep-intent');
  });

  it('caps the payload for the 10MB body limit', async () => {
    vi.stubEnv('DEEP_URL', 'http://deep:9');
    const dir = tmp();
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(path.join(dir, `big${i}.ts`), `/*${'x'.repeat(1_900_000)}*/`);
    }
    vi.stubGlobal('fetch', vi.fn(async () => okJson({ findings: [] })));
    const r = await runDeepScorer(dir);
    expect(r.summary).toContain('findings across');
    expect((r.details as { note: string }).note).toContain('payload capped');
    expect((r.details as { scannedFiles: number }).scannedFiles).toBeLessThan(5);
  }, 60_000);
});

describe('runCodeGangScorer branches', () => {
  it('handles HTTP errors, failed bodies and empty repo maps', async () => {
    const dir = tmpProject({ 'README.md': 'x' });

    vi.stubGlobal('fetch', vi.fn(async () => new Response('no', { status: 500 })));
    expect((await runCodeGangScorer(dir)).error).toContain('HTTP 500');

    vi.stubGlobal('fetch', vi.fn(async () => okJson({ success: false, message: 'bad repo' })));
    expect((await runCodeGangScorer(dir)).error).toBe('bad repo');

    vi.stubGlobal('fetch', vi.fn(async () => okJson({ success: true })));
    expect((await runCodeGangScorer(dir)).error).toContain('no repo map');

    vi.stubGlobal('fetch', vi.fn(async () => okJson({ success: true, repoMap: { files: [] } })));
    const empty = await runCodeGangScorer(dir);
    expect(empty.score).toBe(100);
    expect(empty.summary).toContain('0 files');

    vi.stubGlobal('fetch', vi.fn(async () => okJson({
      success: true,
      repoMap: { files: [{ complexity: 'high' }, { complexity: 30 }], dependencies: 'nope' },
    })));
    const mixed = await runCodeGangScorer(dir);
    expect(mixed.details).toEqual({ files: 2, dependencies: 0, avgComplexity: 15 });
  });
});

describe('runCodeNexusScorer offline repo path', () => {
  it('reports the control plane offline for a repo URL', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }));
    const r = await runCodeNexusScorer({ repoUrl: 'https://github.com/o/r' });
    expect(r.score).toBeNull();
    expect(r.error).toContain('offline');
  });

  it('points local dirs at the other scorers when online', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okJson({ status: 'ok' })));
    const r = await runCodeNexusScorer({ targetDir: process.cwd() });
    expect(r.score).toBeNull();
    expect(r.error).toContain('local dirs use');
  });
});

describe('runLocalQaScorer branches', () => {
  it('runs pytest when a Python project is detected', async () => {
    const dir = tmpProject({ 'pyproject.toml': '[project]\nname = "x"\n' });
    const r = await runLocalQaScorer(dir);
    expect(r.scorer).toBe('local_qa');
    expect(r.summary).toContain('pytest');
    expect([0, 100]).toContain(r.score);
  }, 150_000);

  it('handles a package.json with no test script or invalid JSON', async () => {
    const noScript = tmpProject({ 'package.json': '{"name":"x"}' });
    expect((await runLocalQaScorer(noScript)).error).toContain('no test script');

    const invalid = tmpProject({ 'package.json': '{ not json' });
    expect((await runLocalQaScorer(invalid)).error).toContain('no test script');
  });

  it('chooses the vitest and jest argument shapes', async () => {
    const vitestDir = tmpProject({ 'package.json': JSON.stringify({ name: 'v', scripts: { test: 'vitest' } }) });
    const v = await runLocalQaScorer(vitestDir);
    expect(v.scorer).toBe('local_qa');
    expect(v.summary).toMatch(/local QA (passed|failed)/);

    const jestDir = tmpProject({ 'package.json': JSON.stringify({ name: 'j', scripts: { test: 'jest' } }) });
    const j = await runLocalQaScorer(jestDir);
    expect(j.scorer).toBe('local_qa');
    expect(j.summary).toMatch(/local QA (passed|failed)/);
  }, 60_000);
});

describe('codegraphScorerResult missing report', () => {
  it('reports the graph error when it is available but has no report', () => {
    const r = codegraphScorerResult({ graph: { available: true, error: 'no report yet', report: null } });
    expect(r.score).toBeNull();
    expect(r.error).toBe('no report yet');
  });
});

describe('executeAuditSuite dispatch', () => {
  const OSS_REPORT: OssReviewReport = {
    graph: { available: true, report: { risk_score: 0.1, changed_functions: [], test_gaps: [], affected_flows: [] } },
    ocr: { available: true, preview: { reviewable_count: 1, total_files: 1 } },
    llmReview: { configured: false },
  };

  it('runs every explicit scorer and aggregates the real numbers', async () => {
    vi.stubEnv('REPORANK_API_KEY', 'gr_test');
    vi.stubEnv('GRADER_API_KEY', 'gr_test');
    vi.stubEnv('CLAW_PROTECT_SYSTEM_AGENT_KEY', 'k');
    vi.stubEnv('DEEP_URL', 'http://deep:9');
    vi.stubEnv('REPORANK_POLL_INTERVAL_MS', '1');
    vi.stubEnv('REPORANK_POLL_TIMEOUT_MS', '2000');
    vi.mocked(fetchOssReview).mockResolvedValue({ ok: true, report: OSS_REPORT });

    const dir = tmpProject({ 'package.json': '{"name":"x"}', 'src/a.ts': 'export const a = 1;' });
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes('/api/v1/scans') && !/scans\/[^/]+$/.test(url)) return okJson({ data: { scanId: 's1' } });
      if (/scans\/s1$/.test(url)) return okJson({ data: { status: 'complete', overallScore: 90 } });
      if (url.includes('/api/grade')) return okJson({ overallScore: 80, gradeCategory: 'B' });
      if (url.includes('/api/v1/scan/secrets')) return okJson({ secretsFound: 0 });
      if (url.includes('/api/v1/')) return okJson({ findings: [] });
      if (url.includes('/api/analyze')) return okJson({ success: true, repoMap: { files: [{ complexity: 5 }], dependencies: [] } });
      return okJson({ status: 'ok' });
    }));

    const report = await executeAuditSuite({
      repoUrl: 'https://github.com/o/r',
      targetDir: dir,
      scorers: ['reporank', 'grader', 'claw', 'codegraph', 'ocr', 'deep', 'codegang', 'codenexus', 'local_qa'],
    });
    expect(report.results.map((r) => r.scorer)).toEqual(
      ['reporank', 'grader', 'claw-protect', 'codegraph', 'ocr', 'deep', 'codegang', 'codenexus', 'local_qa'],
    );
    expect(report.results.find((r) => r.scorer === 'reporank')!.score).toBe(90);
    expect(report.results.find((r) => r.scorer === 'codegang')!.score).toBe(100);
    expect(report.overallStatus).toBe('pass');
  });

  it('warns when the average is between 60 and 80', async () => {
    vi.mocked(fetchOssReview).mockResolvedValue({
      ok: true,
      report: {
        graph: {
          available: true,
          report: { test_gaps: [{}, {}], changed_functions: [{}], affected_flows: [] },
        },
      },
    });
    const report = await executeAuditSuite({ targetDir: tmp(), scorers: ['codegraph'] });
    expect(report.results[0].score).toBe(70);
    expect(report.overallStatus).toBe('warn');
  });

  it('fails the suite when no scorer produces a number', async () => {
    vi.stubEnv('DEEP_URL', '');
    const report = await executeAuditSuite({ targetDir: tmp(), scorers: ['deep'] });
    expect(report.results[0].score).toBeNull();
    expect(report.overallStatus).toBe('fail');
  });

  it('reports OSS review as unavailable for repoUrl-only audits', async () => {
    const report = await executeAuditSuite({ repoUrl: 'https://github.com/o/r', scorers: ['codegraph', 'ocr'] });
    expect(report.results).toHaveLength(2);
    for (const r of report.results) {
      expect(r.score).toBeNull();
      expect(r.error).toContain('local targetDir');
    }
    expect(report.overallStatus).toBe('fail');
  });

  it('passes a failed OSS fetch through as an error', async () => {
    vi.mocked(fetchOssReview).mockResolvedValue({ ok: false, error: 'axiom down' });
    const report = await executeAuditSuite({ targetDir: tmp(), scorers: ['codegraph', 'ocr'] });
    for (const r of report.results) {
      expect(r.score).toBeNull();
      expect(r.error).toBe('axiom down');
    }
  });
});
