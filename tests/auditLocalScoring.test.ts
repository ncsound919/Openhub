import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  runRepoRankScorer,
  runGraderScorer,
  runCodeNexusScorer,
} from '../src/services/auditSuite';

const dirs: string[] = [];

function tmpProject(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openhub-local-score-'));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  return dir;
}

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const d of dirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* best-effort */ }
  }
});

describe('RepoRank local scoring', () => {
  it('uploads local files and reads the polled report score', async () => {
    vi.stubEnv('REPORANK_API_KEY', 'gr_test');
    vi.stubEnv('REPORANK_POLL_INTERVAL_MS', '1');
    vi.stubEnv('REPORANK_POLL_TIMEOUT_MS', '2000');
    const dir = tmpProject({ 'src/a.ts': 'export const a = 1;\n' });

    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (String(url).includes('/scans/local')) return okJson({ data: { scanId: 's1', status: 'queued' } });
      return okJson({ data: { status: 'complete', result: { overallScore: 72, gradeCategory: 'C' } } });
    }));

    const r = await runRepoRankScorer({ targetDir: dir });
    expect(r.score).toBe(72);
    expect(r.grade).toBe('C');
    expect(r.summary).toContain('local');
    const submit = calls.find((c) => c.url.includes('/scans/local'));
    expect(submit).toBeTruthy();
    const body = submit!.body as { files: Array<{ path: string; content: string }>; privateMode: boolean };
    expect(body.privateMode).toBe(true);
    expect(body.files.some((f) => f.path === 'src/a.ts' && f.content.includes('export const a'))).toBe(true);
  });
});

describe('Grader local scoring', () => {
  it('grades a local checkout via /api/v1/scans/change', async () => {
    vi.stubEnv('GRADER_API_KEY', 'gr_test');
    const dir = tmpProject({ 'src/a.ts': 'export const a = 1;\n' });
    vi.stubGlobal('fetch', vi.fn(async () => okJson({
      schema: 'graded-change-v1',
      score: { value: 82, basis: 'measured', measured: true },
      gradeCategory: 'B',
      findings: { introduced: [{ file: 'src/a.ts' }], preExisting: 1, fixed: [], total: 3 },
    })));

    const r = await runGraderScorer({ targetDir: dir });
    expect(r.score).toBe(82);
    expect(r.grade).toBe('B');
    expect(r.summary).toContain('local change');
    expect(r.summary).toContain('1 introduced');
  });

  it('reports a disabled local-target 403 honestly', async () => {
    vi.stubEnv('GRADER_API_KEY', 'gr_test');
    const dir = tmpProject({ 'src/a.ts': 'export const a = 1;\n' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: 'Local target grading is disabled. Set GRADER_ALLOW_LOCAL_TARGETS=true to allow targetDir.' }),
      { status: 403, headers: { 'content-type': 'application/json' } },
    )));
    const r = await runGraderScorer({ targetDir: dir });
    expect(r.score).toBeNull();
    expect(r.error).toContain('GRADER_ALLOW_LOCAL_TARGETS');
  });
});

describe('CodeNexus local scoring', () => {
  it('reviews a local directory and derives a severity-weighted score', async () => {
    const dir = tmpProject({ 'src/a.ts': 'export const a = 1;\n' });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).endsWith('/health')) return okJson({ status: 'ok' });
      return okJson({
        ok: true,
        runId: 'r1',
        semgrepAvailable: true,
        securityAlertCount: 1,
        findings: [{ source: 'security', severity: 'high', title: 'hardcoded secret', filePath: 'src/a.ts', line: 3 }],
      });
    }));

    const r = await runCodeNexusScorer({ targetDir: dir });
    expect(r.score).toBe(80); // 100 - high(20)
    expect(r.summary).toContain('local review');
    expect(r.findings?.length).toBe(1);
    expect(r.findings?.[0]).toMatchObject({ source: 'codenexus', severity: 'high', location: { file: 'src/a.ts', line: 3 } });
  });

  it('does not fabricate a score when no analyzer ran', async () => {
    const dir = tmpProject({ 'src/a.ts': 'export const a = 1;\n' });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).endsWith('/health')) return okJson({ status: 'ok' });
      return okJson({ ok: true, semgrepAvailable: false, securityAlertCount: 0, findings: [] });
    }));
    const r = await runCodeNexusScorer({ targetDir: dir });
    expect(r.score).toBeNull();
    expect(r.summary).toContain('not scored');
  });
});
