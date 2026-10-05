import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'node:child_process';
import {
  P2_DIMENSIONS,
  P2_SCORERS,
  builtinDuplication,
  isP2Scorer,
  parseApiSurface,
  parseJscpdReport,
  parseLicenseChecker,
  parsePa11yIssues,
  runA11yScorer,
  runApiContractScorer,
  runDepsFreshnessScorer,
  runDuplicationScorer,
  runGitHistoryScorer,
  runIacScorer,
  runLicensesSbomScorer,
  runPerfScorer,
  scanIacContent,
  scanPerformance,
} from '../src/services/p2Scorers';
import type { PreflightReport } from '../src/services/preflight';

const dirs: string[] = [];

function tmpProject(files: Record<string, string | Buffer>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openhub-p2-'));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function commit(cwd: string, message: string): void {
  execFileSync('git', ['-c', 'user.email=t@t.t', '-c', 'user.name=t', 'add', '-A'], { cwd });
  execFileSync('git', ['-c', 'user.email=t@t.t', '-c', 'user.name=t', 'commit', '-q', '-m', message], { cwd });
}

function preflight(tools: Array<{ name: string; available: boolean; reason?: string }>): PreflightReport {
  return {
    target: '/x',
    tools: tools.map((t) => ({ ...t, kind: 'local' as const })),
    ready: tools.filter((t) => t.available).map((t) => t.name),
    missing: tools.filter((t) => !t.available).map((t) => t.name),
    checkedAt: '',
  };
}

afterEach(() => {
  for (const d of dirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* best-effort */ }
  }
});

describe('P2 scorer registry', () => {
  it('exposes eight scorers with dimension mappings', () => {
    expect(P2_SCORERS).toHaveLength(8);
    for (const name of P2_SCORERS) {
      expect(isP2Scorer(name)).toBe(true);
      expect(P2_DIMENSIONS[name].length).toBeGreaterThan(0);
    }
    expect(isP2Scorer('deep')).toBe(false);
  });
});

describe('pure parsers', () => {
  it('parseLicenseChecker flags copyleft and unknown licenses', () => {
    const findings = parseLicenseChecker({
      'a@1.0.0': { licenses: 'MIT' },
      'b@1.0.0': { licenses: 'GPL-3.0' },
      'c@1.0.0': { licenses: '' },
    });
    expect(findings.map((f) => f.category).sort()).toEqual(['license-copyleft', 'license-unknown']);
    expect(findings.find((f) => f.category === 'license-copyleft')!.severity).toBe('medium');
  });

  it('parseJscpdReport maps duplicates to relative locations', () => {
    const findings = parseJscpdReport({
      duplicates: [{ tokens: 500, lines: 30, firstFile: { name: '/r/src/a.ts', start: 3 }, secondFile: { name: '/r/src/b.ts', start: 9 } }],
    }, '/r');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ source: 'duplication', category: 'duplicate-code', severity: 'high', location: { file: 'src/a.ts', line: 3 } });
  });

  it('parsePa11yIssues maps errors and warnings', () => {
    const findings = parsePa11yIssues([
      { type: 'error', code: 'WCAG2AA.Principle1', message: 'contrast', selector: 'h1' },
      { type: 'warning', code: 'W1', message: 'notice' },
    ], 'index.html');
    expect(findings[0].severity).toBe('high');
    expect(findings[1].severity).toBe('medium');
    expect(findings[0].category).toBe('a11y:WCAG2AA.Principle1');
  });

  it('scanPerformance finds N+1, nested loops and sync IO', () => {
    const src = [
      'export async function f(xs: any[]) {',
      '  for (const x of xs) {',
      '    for (const y of xs) {',
      '      await db.query("select 1");',
      '      fs.readFileSync("a");',
      '    }',
      '  }',
      '}',
    ].join('\n');
    const categories = scanPerformance(src, 'svc.ts').map((f) => f.category);
    expect(categories).toContain('n-plus-one');
    expect(categories).toContain('nested-loop');
    expect(categories).toContain('sync-io-in-loop');
  });

  it('parseApiSurface reads JSON and YAML specs', () => {
    const json = parseApiSurface(JSON.stringify({ paths: { '/a': { get: {}, post: {} }, '/b': { get: {} } } }), 'openapi.json')!;
    expect(json.operations.sort()).toEqual(['get /a', 'get /b', 'post /a']);
    const yaml = parseApiSurface('openapi: 3.0.0\npaths:\n  /a:\n    get:\n      summary: a\n', 'openapi.yaml')!;
    expect(yaml.paths).toEqual(['/a']);
    expect(yaml.operations).toEqual(['get /a']);
  });

  it('scanIacContent applies Dockerfile and Terraform rules', () => {
    const docker = scanIacContent('FROM node:latest\nUSER root\nENV API_KEY=secret\n', 'Dockerfile');
    expect(docker.map((f) => f.category)).toEqual(
      expect.arrayContaining(['iac-docker-latest', 'iac-docker-root', 'iac-docker-secret-env']),
    );
    const tf = scanIacContent('cidr_blocks = ["0.0.0.0/0"]\n', 'main.tf');
    expect(tf.map((f) => f.category)).toContain('iac-tf-open-ingress');
  });
});

describe('tool-backed scorers report honest skips', () => {
  it('deps_freshness skips without a manifest', async () => {
    const r = await runDepsFreshnessScorer(tmpProject({ 'README.md': 'x' }));
    expect(r.score).toBeNull();
    expect(r.error).toContain('manifest');
  });

  it('licenses_sbom falls back to the project license when license-checker is unavailable', async () => {
    const dir = tmpProject({ 'package.json': '{"name":"x"}', 'LICENSE': 'MIT License\n\nPermission is hereby granted...' });
    const r = await runLicensesSbomScorer(dir, { preflight: preflight([{ name: 'license-checker', available: false, reason: 'not installed' }]) });
    expect(typeof r.score).toBe('number');
    expect(r.summary).toContain('LICENSE');
    expect(r.findings!.some((f) => f.category === 'license-missing')).toBe(false);
  });

  it('licenses_sbom flags a missing project license (never uncovered)', async () => {
    const dir = tmpProject({ 'package.json': '{"name":"x"}' });
    const r = await runLicensesSbomScorer(dir, { preflight: preflight([{ name: 'license-checker', available: false, reason: 'not installed' }]) });
    expect(typeof r.score).toBe('number');
    expect(r.findings!.some((f) => f.category === 'license-missing')).toBe(true);
    expect(r.score!).toBeLessThan(100);
  });

  it('builtinDuplication detects cross-file duplication', () => {
    const block = [
      'const alpha = compute(1, 2);',
      'const beta = compute(3, 4);',
      'const gamma = alpha + beta;',
      'const delta = gamma * 2;',
      'export function run() { return delta; }',
      'export const TOTAL = gamma + delta;',
    ].join('\n');
    const dir = tmpProject({ 'a.py': block, 'b.py': block });
    const findings = builtinDuplication(dir);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0].category).toBe('duplicate-code');
    expect(findings[0].determinism).toBe('heuristic');
  });

  it('duplication falls back to the built-in detector without jscpd/pylint', async () => {
    const dir = tmpProject({ 'package.json': '{"name":"x"}' });
    const r = await runDuplicationScorer(dir, { preflight: preflight([{ name: 'jscpd', available: false, reason: 'no jscpd' }]) });
    expect(typeof r.score).toBe('number');
    expect(r.summary).toContain('built-in');
  });

  it('a11y skips when pa11y is unavailable', async () => {
    const dir = tmpProject({ 'index.html': '<html></html>' });
    const r = await runA11yScorer(dir, { preflight: preflight([{ name: 'pa11y', available: false, reason: 'no pa11y' }]) });
    expect(r.score).toBeNull();
    expect(r.error).toBe('no pa11y');
  });

  it('api_contract skips without a spec', async () => {
    const r = await runApiContractScorer(tmpProject({ 'README.md': 'x' }));
    expect(r.score).toBeNull();
    expect(r.error).toContain('OpenAPI');
  });
});

describe('static scorers produce real evidence', () => {
  it('perf scans a JS/TS fixture', async () => {
    const dir = tmpProject({
      'svc.ts': 'export async function f(xs: any[]) {\n  for (const x of xs) {\n    await db.query("select 1");\n  }\n}\n',
    });
    const r = await runPerfScorer(dir);
    expect(r.dimension).toBe('performance');
    expect(r.score).not.toBeNull();
    expect(r.findings!.some((f) => f.category === 'n-plus-one')).toBe(true);
  });

  it('iac runs the built-in ruleset without external tools', async () => {
    const dir = tmpProject({ 'Dockerfile': 'FROM node:latest\nUSER root\n' });
    const r = await runIacScorer(dir);
    expect(r.dimension).toBe('security');
    expect(r.findings!.map((f) => f.category)).toEqual(expect.arrayContaining(['iac-docker-latest', 'iac-docker-root']));
  });

  it('git_history finds large files, vague commits and committed secrets', async () => {
    const dir = tmpProject({
      'big.bin': Buffer.alloc(1_100_000),
      // A real-looking key, NOT the AWS documented example (which is a
      // placeholder the scanner now deliberately ignores).
      'config.ts': 'export const KEY = "AKIAZ3XQ7PLMN4VW2RTY";\n',
    });
    git(dir, ['init', '-q']);
    commit(dir, 'wip');

    const r = await runGitHistoryScorer(dir);
    expect(r.score).not.toBeNull();
    const categories = r.findings!.map((f) => f.category);
    expect(categories).toContain('large-file');
    expect(categories).toContain('commit-hygiene');
    expect(categories).toContain('secret-aws-key');
  }, 60_000);

  it('git_history skips outside a git worktree', async () => {
    const r = await runGitHistoryScorer(tmpProject({ 'a.ts': 'x' }));
    expect(r.score).toBeNull();
    expect(r.error).toContain('git');
  });

  it('api_contract detects a removed operation vs HEAD', async () => {
    const dir = tmpProject({
      'openapi.yaml': 'openapi: 3.0.0\npaths:\n  /a:\n    get:\n      summary: a\n  /b:\n    get:\n      summary: b\n',
    });
    git(dir, ['init', '-q']);
    commit(dir, 'add spec');
    fs.writeFileSync(path.join(dir, 'openapi.yaml'), 'openapi: 3.0.0\npaths:\n  /a:\n    get:\n      summary: a\n');

    const r = await runApiContractScorer(dir);
    expect(r.findings!.some((f) => f.category === 'api-breaking')).toBe(true);
    expect(r.summary).toContain('breaking');
  }, 60_000);
});
