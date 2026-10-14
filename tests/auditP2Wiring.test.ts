import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { executeAuditSuite, runDeepScorer, DEFAULT_AUDIT_SCORERS } from '../src/services/auditSuite';
import { resetAuditCache } from '../src/services/auditRuntime';

const dirs: string[] = [];

function tmpProject(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openhub-p2wire-'));
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
  resetAuditCache();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('P2 wiring into executeAuditSuite', () => {
  it('runs perf and covers the performance dimension', async () => {
    const dir = tmpProject({
      'svc.ts': 'export async function f(xs: any[]) {\n  for (const x of xs) {\n    await db.query("select 1");\n  }\n}\n',
    });
    const report = await executeAuditSuite({ targetDir: dir, scorers: ['perf'] });
    const perf = report.results.find((r) => r.scorer === 'perf')!;
    expect(perf.score).not.toBeNull();
    expect(perf.dimension).toBe('performance');
    expect(report.coverage.dimensions.find((d) => d.dimension === 'performance')!.status).toBe('covered');
    expect(report.determinismConfig).toEqual({ model: null, seed: null, source: 'none' });
  }, 90_000);

  it('runs the iac ruleset and reports a preflight grid', async () => {
    const dir = tmpProject({ Dockerfile: 'FROM node:latest\nUSER root\n' });
    const report = await executeAuditSuite({ targetDir: dir, scorers: ['iac'] });
    const iac = report.results.find((r) => r.scorer === 'iac')!;
    expect(iac.findings!.length).toBeGreaterThan(0);
    expect(report.coverage.dimensions.find((d) => d.dimension === 'security')!.status).toBe('covered');
    expect(report.preflight).toBeDefined();
    expect(Array.isArray(report.preflight!.tools)).toBe(true);
  }, 90_000);

  it('honestly skips every P2 scorer for a repoUrl-only audit', async () => {
    const report = await executeAuditSuite({ repoUrl: 'https://github.com/example/repo' });
    const p2 = ['deps_freshness', 'licenses_sbom', 'duplication', 'perf', 'a11y', 'api_contract', 'git_history', 'iac'];
    for (const name of p2) {
      const r = report.results.find((x) => x.scorer === name)!;
      expect(r.score).toBeNull();
      expect(r.error).toBeTruthy();
    }
    expect(report.results).toHaveLength(DEFAULT_AUDIT_SCORERS.length);
    expect(report.preflight).toBeUndefined();
  }, 90_000);

  it('serves a repeated unchanged audit from the runtime cache when enabled', async () => {
    vi.stubEnv('AUDIT_CACHE_TTL_MS', '60000');
    const dir = tmpProject({
      'svc.ts': 'export async function f(xs: any[]) {\n  for (const x of xs) {\n    await db.query("select 1");\n  }\n}\n',
    });
    const first = await executeAuditSuite({ targetDir: dir, scorers: ['perf'] });
    expect(first.results.find((r) => r.scorer === 'perf')!.cached).toBeUndefined();
    const second = await executeAuditSuite({ targetDir: dir, scorers: ['perf'] });
    expect(second.results.find((r) => r.scorer === 'perf')!.cached).toBe(true);
  }, 90_000);
});

describe('G2 model pinning is forwarded to The Deep', () => {
  it('includes the pinned model and seed in the deep payload', async () => {
    vi.stubEnv('DEEP_URL', 'http://deep:9');
    vi.stubEnv('AUDIT_LLM_MODEL', 'pinned-model');
    vi.stubEnv('AUDIT_LLM_SEED', '7');
    const dir = tmpProject({ 'src/a.ts': 'export const a = 1;\n' });
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')));
      return new Response(JSON.stringify({ findings: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const r = await runDeepScorer(dir);
    expect(r.score).toBe(100);
    expect(bodies[0]).toMatchObject({ model: 'pinned-model', seed: 7 });
  }, 60_000);
});
