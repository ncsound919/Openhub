import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  detectTargetSignals,
  planToolProbes,
  preflightAuditTools,
  toolReady,
  toolReason,
  type PreflightReport,
} from '../src/services/preflight';

const dirs: string[] = [];

function tmpProject(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openhub-preflight-'));
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
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

function report(over: Partial<PreflightReport> = {}): PreflightReport {
  return { target: '/x', tools: [], ready: [], missing: [], checkedAt: '', ...over };
}

describe('detectTargetSignals', () => {
  it('detects JS/TS, Python, IaC, HTML and OpenAPI surfaces', () => {
    const dir = tmpProject({
      'package.json': '{"name":"x"}',
      'tsconfig.json': '{}',
      'eslint.config.js': 'export default [];',
      'engine/main.py': 'print(1)',
      'Dockerfile': 'FROM node:latest',
      'public/index.html': '<html></html>',
      'openapi.yaml': 'openapi: 3.0.0',
      '.git/HEAD': 'ref: refs/heads/main',
    });
    const s = detectTargetSignals(dir);
    expect(s.hasPackageJson).toBe(true);
    expect(s.hasTsconfig).toBe(true);
    expect(s.hasEslintConfig).toBe(true);
    expect(s.hasPython).toBe(true);
    expect(s.hasIaC).toBe(true);
    expect(s.hasHtml).toBe(true);
    expect(s.hasOpenApi).toBe(true);
    expect(s.isGitRepo).toBe(true);
  });

  it('reports no signals for an empty or missing dir', () => {
    const s = detectTargetSignals(tmpProject({ 'README.md': '# x' }));
    expect(s.hasPackageJson).toBe(false);
    expect(s.hasPython).toBe(false);
    expect(detectTargetSignals(undefined).isGitRepo).toBe(false);
  });
});

describe('planToolProbes', () => {
  it('only probes tools the target justifies, always including gitleaks', () => {
    const ts = planToolProbes(detectTargetSignals(tmpProject({ 'tsconfig.json': '{}' })));
    const names = ts.map((t) => t.name);
    expect(names).toContain('tsc');
    expect(names).not.toContain('pytest');
    expect(names).toContain('gitleaks');

    const py = planToolProbes(detectTargetSignals(tmpProject({ 'pyproject.toml': '[project]' })));
    expect(py.map((t) => t.name)).toEqual(expect.arrayContaining(['pytest', 'ruff', 'mypy']));
  });
});

describe('preflightAuditTools', () => {
  it('reports everything missing when probing is disabled', async () => {
    const dir = tmpProject({ 'package.json': '{"name":"x"}' });
    const pf = await preflightAuditTools(dir, { probe: false });
    expect(pf.ready).toEqual([]);
    expect(pf.missing.length).toBeGreaterThan(0);
    expect(pf.tools.every((t) => !t.available)).toBe(true);
    expect(pf.tools.every((t) => t.reason === 'probe disabled')).toBe(true);
  });

  it('reports a no-target audit as unavailable rather than throwing', async () => {
    const pf = await preflightAuditTools(undefined, { probe: false });
    expect(pf.target).toBeNull();
    expect(pf.tools.every((t) => t.reason === 'no local target dir')).toBe(true);
  });
});

describe('toolReady / toolReason', () => {
  it('reads availability and the reason from a report', () => {
    const pf = report({ tools: [
      { name: 'tsc', kind: 'local', available: true, version: '5.8.3' },
      { name: 'pa11y', kind: 'local', available: false, reason: 'pa11y not runnable' },
    ], ready: ['tsc'], missing: ['pa11y'] });
    expect(toolReady(pf, 'tsc')).toBe(true);
    expect(toolReady(pf, 'pa11y')).toBe(false);
    expect(toolReady(undefined, 'tsc')).toBe(false);
    expect(toolReason(pf, 'pa11y')).toBe('pa11y not runnable');
    expect(toolReason(pf, 'unknown')).toContain('not probed');
  });
});
