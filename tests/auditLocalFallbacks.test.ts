import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runClawProtectScorer, runScaScorer } from '../src/services/auditSuite.js';

const dirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openhub-audit-fallback-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.CLAW_PROTECT_SYSTEM_AGENT_KEY;
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('audit SCA fallback without Claw credentials', () => {
  it('scans lockfiles with local OSV and reports the CVE', async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({
      packages: {
        '': { name: 'fixture', version: '1.0.0' },
        'node_modules/lodash': { version: '4.17.20' },
      },
    }));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      results: [{
        vulns: [{
          id: 'GHSA-test-1234',
          summary: 'Prototype pollution in lodash',
          database_specific: { severity: 'HIGH' },
          affected: [{ ranges: [{ events: [{ fixed: '4.17.21' }] }] }],
        }],
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })));

    const result = await runScaScorer(dir);

    expect(result.status).toBe('ok');
    expect(result.score).toBe(85);
    expect(result.findings).toHaveLength(1);
    expect(result.findings?.[0]?.cve).toBe('GHSA-test-1234');
    expect(result.summary).toContain('local OSV');
  });

  it('stays unavailable instead of claiming a clean scan when no manifest is supported', async () => {
    const result = await runScaScorer(tempDir());
    expect(result.score).toBeNull();
    expect(result.error).toContain('no supported dependency manifests');
  });

  it('reports OSV network failure as unassessed, never as zero findings', async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({
      packages: { '': {}, 'node_modules/left-pad': { version: '1.0.0' } },
    }));
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));

    const result = await runScaScorer(dir);

    expect(result.score).toBeNull();
    expect(result.error).toContain('OSV unreachable');
  });
});

describe('audit secret-scan fallback without Claw credentials', () => {
  it('uses the deterministic secret rules locally', async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, '.env'), 'OPENAI_API_KEY=sk-proj-AbCdEfGhIjKlMnOpQrStUvWx\n');

    const result = await runClawProtectScorer({ targetDir: dir });

    expect(result.status).toBe('ok');
    expect(result.score).toBeLessThan(100);
    expect(result.findings?.length).toBeGreaterThan(0);
    expect(result.summary).toContain('local secret scan');
  });
});
