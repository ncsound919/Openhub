import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  runRepoRankScorer,
  runGraderScorer,
  runClawProtectScorer,
  runDeepScorer,
  runCodeGangScorer,
  runCodeNexusScorer,
  runLocalQaScorer,
  collectDeepFiles,
  executeAuditSuite,
  codegraphScorerResult,
  ocrScorerResult,
  DEFAULT_AUDIT_SCORERS,
} from '../src/services/auditSuite';

// Honesty contract: a scorer that cannot run (missing key, offline service)
// must return score=null with a real error. It must NEVER invent a number.
// These tests run without API keys set, so every scorer takes its error path.

describe('auditSuite honesty contract', () => {
  it('reporank returns null score when no API key is configured', async () => {
    const r = await runRepoRankScorer('https://github.com/example/repo');
    expect(r.scorer).toBe('reporank');
    expect(r.score).toBeNull();
    expect(r.error).toContain('REPORANK_API_KEY');
  });

  it('grader returns null score when no API key is configured', async () => {
    const r = await runGraderScorer('https://github.com/example/repo');
    expect(r.scorer).toBe('grader');
    expect(r.score).toBeNull();
    expect(r.error).toContain('GRADER_API_KEY');
  });

  it('claw-protect returns null score when no system agent key is configured', async () => {
    const r = await runClawProtectScorer({ targetDir: process.cwd() });
    expect(r.scorer).toBe('claw-protect');
    expect(r.score).toBeNull();
    expect(r.error).toContain('CLAW_PROTECT_SYSTEM_AGENT_KEY');
  });

  it('suite with zero runnable scorers reports fail, never a fake average', async () => {
    const report = await executeAuditSuite({ repoUrl: 'https://github.com/example/repo' });
    expect(report.results.length).toBe(DEFAULT_AUDIT_SCORERS.length);
    expect(DEFAULT_AUDIT_SCORERS).toContain('sonarqube');
    for (const r of report.results) {
      expect(r.score).toBeNull();
      expect(r.error).toBeTruthy();
    }
    expect(report.overallStatus).toBe('fail');
  });

  it('never silently drops a requested scorer type (codenexus/local_qa regression)', async () => {
    const report = await executeAuditSuite({
      repoUrl: 'https://github.com/example/repo',
      scorers: ['codenexus', 'local_qa'],
    });
    expect(report.results.map((r) => r.scorer).sort()).toEqual(['codenexus', 'local_qa']);
  });
});

function tmpProject(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openhub-audit-'));
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

describe('The Deep scorer', () => {
  beforeEach(() => {
    vi.stubEnv('DEEP_URL', '');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('honestly skips when DEEP_URL is unset', async () => {
    const r = await runDeepScorer(process.cwd());
    expect(r.scorer).toBe('deep');
    expect(r.score).toBeNull();
    expect(r.error).toContain('DEEP_URL');
  });

  it('honestly skips without a target dir', async () => {
    vi.stubEnv('DEEP_URL', 'http://127.0.0.1:3999');
    const r = await runDeepScorer(undefined);
    expect(r.score).toBeNull();
  });

  it('scores merged findings across the three passes', async () => {
    vi.stubEnv('DEEP_URL', 'http://127.0.0.1:3999');
    const dir = tmpProject({ 'src/a.ts': 'export const x = 1;\n' });
    vi.stubGlobal('fetch', vi.fn(async () => okJson({ findings: [{ severity: 'high', title: 'x' }] })));
    try {
      const r = await runDeepScorer(dir);
      expect(r.scorer).toBe('deep');
      expect(r.score).toBe(70); // 3 passes x 1 high finding (10 each)
      expect(r.summary).toContain('The Deep');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      vi.unstubAllGlobals();
    }
  });

  it('reports unreachable instead of a number', async () => {
    vi.stubEnv('DEEP_URL', 'http://127.0.0.1:3999');
    const dir = tmpProject({ 'src/a.ts': 'export const x = 1;\n' });
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }));
    try {
      const r = await runDeepScorer(dir);
      expect(r.score).toBeNull();
      expect(r.error).toContain('unreachable');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      vi.unstubAllGlobals();
    }
  });

  it('collectDeepFiles skips vendors and caps the walk', () => {
    const dir = tmpProject({
      'src/a.ts': 'x',
      'node_modules/dep/index.js': 'y',
      'dist/b.js': 'z',
    });
    try {
      expect(collectDeepFiles(dir).map((f) => f.file)).toEqual(['src/a.ts']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('CodeGang scorer', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('honestly skips without a target dir', async () => {
    const r = await runCodeGangScorer(undefined);
    expect(r.scorer).toBe('codegang');
    expect(r.score).toBeNull();
  });

  it('derives a structural score from the repo map', async () => {
    const dir = tmpProject({ 'README.md': 'x' });
    vi.stubGlobal('fetch', vi.fn(async () => okJson({
      success: true,
      repoMap: { files: [{ complexity: 5 }, { complexity: 25 }], dependencies: [{}, {}] },
    })));
    try {
      const r = await runCodeGangScorer(dir);
      expect(r.scorer).toBe('codegang');
      expect(r.score).toBe(75); // avg 15 -> 100 - 5*5
      expect(r.summary).toContain('2 files');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      vi.unstubAllGlobals();
    }
  });

  it('reports unreachable instead of a number', async () => {
    const dir = tmpProject({ 'README.md': 'x' });
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }));
    try {
      const r = await runCodeGangScorer(dir);
      expect(r.score).toBeNull();
      expect(r.error).toContain('unreachable');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      vi.unstubAllGlobals();
    }
  });
});

describe('CodeNexus scorer', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('reports the webhook-driven capability honestly (never a fabricated grade)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okJson({ status: 'ok' })));
    const repo = await runCodeNexusScorer({ repoUrl: 'https://github.com/example/repo' });
    expect(repo.scorer).toBe('codenexus');
    expect(repo.score).toBeNull();
    expect(repo.summary).toContain('webhook');

    const local = await runCodeNexusScorer({ targetDir: process.cwd() });
    expect(local.score).toBeNull();
    expect(local.summary).toContain('webhook');
  });

  it('reports the control plane offline honestly', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }));
    const r = await runCodeNexusScorer({});
    expect(r.score).toBeNull();
    expect(r.error ?? r.summary).toContain('offline');
  });
});

describe('Benchmark Olympics local-QA scorer', () => {
  it('scores 100 when the target test command passes', async () => {
    const dir = tmpProject({
      'package.json': JSON.stringify({ name: 'qa-fixture', scripts: { test: 'node -e "process.exit(0)"' } }),
    });
    try {
      const r = await runLocalQaScorer(dir);
      expect(r.scorer).toBe('local_qa');
      expect(r.score).toBe(100);
      expect(r.summary).toContain('passed');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('scores 0 with an error when the target test command fails', async () => {
    const dir = tmpProject({
      'package.json': JSON.stringify({ name: 'qa-fixture', scripts: { test: 'node -e "process.exit(3)"' } }),
    });
    try {
      const r = await runLocalQaScorer(dir);
      expect(r.score).toBe(0);
      expect(r.error).toBeTruthy();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('honestly skips with no test runner or no dir', async () => {
    const dir = tmpProject({ 'README.md': 'x' });
    try {
      const r = await runLocalQaScorer(dir);
      expect(r.score).toBeNull();
      expect(r.error).toContain('no test runner');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    const missing = await runLocalQaScorer(undefined);
    expect(missing.score).toBeNull();
  });
});

describe('OSS review scorers', () => {
  it('codegraph reports null score + error when Axiom/tool is unavailable', () => {
    const r = codegraphScorerResult(undefined, 'Axiom HTTP 502');
    expect(r.scorer).toBe('codegraph');
    expect(r.score).toBeNull();
    expect(r.error).toContain('Axiom');
  });

  it('codegraph reports null score + error when the graph is unavailable', () => {
    const r = codegraphScorerResult({ graph: { available: false } });
    expect(r.score).toBeNull();
    expect(r.error).toContain('code-review-graph');
  });

  it('codegraph derives a score from untested changed functions', () => {
    const r = codegraphScorerResult({
      graph: { available: true, report: { risk_score: 0.4, changed_functions: [{}], test_gaps: [{}, {}], affected_flows: [] } },
    });
    expect(r.score).toBe(70); // 100 - 2*15
    expect(r.summary).toContain('2 untested');
  });

  it('codegraph reports 100 when no changed functions are untested', () => {
    const r = codegraphScorerResult({
      graph: { available: true, report: { risk_score: 0, changed_functions: [], test_gaps: [], affected_flows: [] } },
    });
    expect(r.score).toBe(100);
  });

  it('ocr reports null score when no LLM review ran (evidence producer, not grader)', () => {
    const r = ocrScorerResult({
      ocr: { available: true, preview: { reviewable_count: 3 } },
      llmReview: { configured: false },
    });
    expect(r.scorer).toBe('ocr');
    expect(r.score).toBeNull();
    expect(r.summary).toContain('3 reviewable');
  });

  it('ocr reports null score + error when the tool is unavailable', () => {
    const r = ocrScorerResult(undefined, 'fetch failed');
    expect(r.score).toBeNull();
    expect(r.error).toBe('fetch failed');
  });

  it('ocr derives a score from line-level findings when the LLM review ran', () => {
    const r = ocrScorerResult({
      ocr: { available: true, preview: { reviewable_count: 1 } },
      llmReview: { configured: true, findings: [{}, {}, {}] },
    });
    expect(r.score).toBe(40); // 100 - 3 findings/file * 20
  });
});
