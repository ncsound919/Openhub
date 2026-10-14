import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import request from 'supertest';
import {
  loadFleetCatalog,
  resolveCatalogPath,
  MAX_CATALOG_ASSETS,
} from '../src/services/fleetCatalog';
import { createFleetAgentsRouter, resolveGsdCli } from '../src/routes/fleetAgents';

/**
 * Fixture mirrors the real fleet catalog shape (OPS-CATALOG.md): a `## Totals`
 * `| Kind | Count |` table followed by `### category` asset sections with
 * `| Name | Kind | Slug | Active | Invocation |` tables. One section uses a
 * `Description` variant header to exercise description extraction.
 */
const CATALOG_FIXTURE = `# OpenHub Test Fleet Catalog

Generated: 2026-01-01T00:00:00.000Z

## Totals

| Kind | Count |
| --- | --- |
| skill | 3 |
| agent | 2 |
| chain | 1 |
| mcp-server | 2 |
| **Total** | **8** |

## By Category

### marketing (3)

| Name | Kind | Slug | Active | Invocation |
| --- | --- | --- | --- | --- |
| ab-testing | skill | \`ab-testing\` | ✅ | path:agents/skills/skills/ab-testing |
| cold-email | skill | \`cold-email\` | ✅ | path:agents/skills/skills/cold-email |
| Ad Creative | skill | \`ad-creative\` | ✅ | path:agents/skills/skills/ad-creative |

### agents (3)

| Name | Kind | Slug | Active | Invocation |
| --- | --- | --- | --- | --- |
| Aetherdesk Call Center | agent | \`aetherdesk\` | ✅ | http |
| Agent Browser | agent | \`agent-browser\` | ✅ | cli |
| Overlay Treasurer | agent | \`overlay-treasurer\` | ✅ | http |

### services (2)

| Name | Kind | Description | Invocation |
| --- | --- | --- | --- |
| invoice-sage | service | Books revenue and tracks invoices | path:agents/services/invoice-sage |
| treasury-bot | service | Monitors treasury pulse | path:agents/services/treasury-bot |
`;

/** Apply env overrides for the duration of an async test (restores after). */
async function withEnv<T>(
  env: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function makeApp(): { app: express.Express; applied: string[] } {
  const applied: string[] = [];
  const app = express();
  app.use(express.json());
  app.use(
    '/api',
    createFleetAgentsRouter({
      authMiddleware: (
        req: express.Request,
        _res: express.Response,
        next: express.NextFunction,
      ) => {
        		applied.push('auth');
        // Same runtime contract as auth.middleware(): user attached to req.
        req.user = { sub: 'test-user', email: 'test@example.com', username: 'tester' };
        next();
      },
    }),
  );
  return { app, applied };
}

describe('resolveCatalogPath', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-catalog-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('prefers OPENHUB_FLEET_CATALOG over the ecosystem-root fallback', () => {
    const ecoRoot = path.join(tmp, 'eco');
    const fallback = path.join(ecoRoot, 'Draymond-Orchestrator', 'OPS-CATALOG.md');
    fs.mkdirSync(path.dirname(fallback), { recursive: true });
    fs.writeFileSync(fallback, '# fallback', 'utf-8');
    const explicit = path.join(tmp, 'explicit.md');
    fs.writeFileSync(explicit, '# explicit', 'utf-8');

    expect(
      resolveCatalogPath({ OPENHUB_FLEET_CATALOG: explicit, OPENHUB_ECOSYSTEM_ROOT: ecoRoot }),
    ).toBe(explicit);
  });

  it('falls back to OPENHUB_ECOSYSTEM_ROOT/Draymond-Orchestrator/OPS-CATALOG.md', () => {
    const ecoRoot = path.join(tmp, 'eco');
    const fallback = path.join(ecoRoot, 'Draymond-Orchestrator', 'OPS-CATALOG.md');
    fs.mkdirSync(path.dirname(fallback), { recursive: true });
    fs.writeFileSync(fallback, '# fallback', 'utf-8');

    expect(resolveCatalogPath({ OPENHUB_ECOSYSTEM_ROOT: ecoRoot })).toBe(fallback);
  });

  it('returns null when the configured catalog does not exist', () => {
    expect(
      resolveCatalogPath({ OPENHUB_FLEET_CATALOG: path.join(tmp, 'missing.md') }),
    ).toBeNull();
    expect(resolveCatalogPath({ OPENHUB_ECOSYSTEM_ROOT: path.join(tmp, 'no-eco') })).toBeNull();
  });
});

describe('loadFleetCatalog', () => {
  let tmp: string;
  let fixturePath: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-catalog-'));
    fixturePath = path.join(tmp, 'OPS-CATALOG.md');
    fs.writeFileSync(fixturePath, CATALOG_FIXTURE, 'utf-8');
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('parses the Totals table and per-section assets from a real-shaped fixture', () => {
    const result = loadFleetCatalog({ OPENHUB_FLEET_CATALOG: fixturePath });

    expect(result.source).toBe('live');
    expect(result.path).toBe(fixturePath);
    expect(result.error).toBeUndefined();

    // Totals: normalized keys, `mcp-server` → `mcp_server`; **Total** excluded.
    expect(result.totals).toEqual({ skill: 3, agent: 2, chain: 1, mcp_server: 2 });
    expect(result.totals.total).toBeUndefined();

    expect(result.assets).toHaveLength(8);
    expect(result.assets[0]).toEqual({
      kind: 'skill',
      name: 'ab-testing',
      description: '',
      path: 'agents/skills/skills/ab-testing',
    });
    // Non-path invocations (http/cli) leave path null — never invented paths.
    expect(result.assets[3]).toEqual({
      kind: 'agent',
      name: 'Aetherdesk Call Center',
      description: '',
      path: null,
    });
    // Description-column variant header is honored.
    expect(result.assets[6]).toEqual({
      kind: 'service',
      name: 'invoice-sage',
      description: 'Books revenue and tracks invoices',
      path: 'agents/services/invoice-sage',
    });
  });

  it('caps asset extraction at MAX_CATALOG_ASSETS', () => {
    const rows = Array.from(
      { length: 520 },
      (_, i) => `| asset-${String(i).padStart(3, '0')} | skill | \`asset-${i}\` | ✅ | path:agents/skills/${i} |`,
    ).join('\n');
    const md = `## Totals\n\n| Kind | Count |\n| --- | --- |\n| skill | 520 |\n\n## By Category\n\n### bulk (520)\n\n| Name | Kind | Slug | Active | Invocation |\n| --- | --- | --- | --- | --- |\n${rows}\n`;
    const bulkPath = path.join(tmp, 'bulk.md');
    fs.writeFileSync(bulkPath, md, 'utf-8');

    const result = loadFleetCatalog({ OPENHUB_FLEET_CATALOG: bulkPath });

    expect(result.assets).toHaveLength(MAX_CATALOG_ASSETS);
    expect(result.assets[MAX_CATALOG_ASSETS - 1].name).toBe('asset-499');
    expect(result.totals).toEqual({ skill: 520 });
  });

  it('degrades with the exact missing-catalog shape when nothing resolves (no throw)', () => {
    const missing = path.join(tmp, 'not-here.md');

    expect(() => loadFleetCatalog({ OPENHUB_FLEET_CATALOG: missing })).not.toThrow();
    expect(loadFleetCatalog({ OPENHUB_FLEET_CATALOG: missing })).toEqual({
      path: null,
      source: 'degraded',
      totals: {},
      assets: [],
      error: 'fleet catalog not found',
    });
  });

  it('degrades honestly when no catalog is configured (no hardcoded path)', () => {
    const r = loadFleetCatalog({});
    expect(r).toEqual({
      path: null,
      source: 'degraded',
      totals: {},
      assets: [],
      error: 'fleet catalog not found',
    });
  });
});

describe('fleetAgents router', () => {
  let tmp: string;
  let fixturePath: string;
  const { app, applied } = makeApp();

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-catalog-'));
    fixturePath = path.join(tmp, 'OPS-CATALOG.md');
    fs.writeFileSync(fixturePath, CATALOG_FIXTURE, 'utf-8');
    applied.length = 0;
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('GET /ecosystem/agents returns the parsed catalog behind the auth middleware', async () => {
    await withEnv({ OPENHUB_FLEET_CATALOG: fixturePath }, async () => {
      const res = await request(app).get('/api/ecosystem/agents');

      expect(res.status).toBe(200);
      expect(applied).toEqual(['auth']);
      expect(res.body.path).toBe(fixturePath);
      expect(res.body.source).toBe('live');
      expect(res.body.totals).toEqual({ skill: 3, agent: 2, chain: 1, mcp_server: 2 });
      expect(res.body.count).toBe(8);
      expect(res.body.assets).toHaveLength(8);
      expect(res.body.assets[0].name).toBe('ab-testing');
      expect(res.body.error).toBeUndefined();
    });
  });

  it('filters by kind (case-insensitive) and search against name/description/path', async () => {
    await withEnv({ OPENHUB_FLEET_CATALOG: fixturePath }, async () => {
      const byKind = await request(app).get('/api/ecosystem/agents').query({ kind: 'skill' });
      expect(byKind.status).toBe(200);
      expect(byKind.body.count).toBe(3);
      expect(byKind.body.assets.every((a: { kind: string }) => a.kind === 'skill')).toBe(true);

      const upperKind = await request(app).get('/api/ecosystem/agents').query({ kind: 'SKILL' });
      expect(upperKind.body.count).toBe(3);

      const kindAndSearch = await request(app)
        .get('/api/ecosystem/agents')
        .query({ kind: 'agent', search: 'AETH' });
      expect(kindAndSearch.body.count).toBe(1);
      expect(kindAndSearch.body.assets[0].name).toBe('Aetherdesk Call Center');

      const byDescription = await request(app).get('/api/ecosystem/agents').query({ search: 'invoice' });
      expect(byDescription.body.count).toBe(1);
      expect(byDescription.body.assets[0].name).toBe('invoice-sage');

      const byPath = await request(app)
        .get('/api/ecosystem/agents')
        .query({ search: 'agents/services' });
      expect(byPath.body.count).toBe(2);
    });
  });

  it('rejects an unknown kind with an explicit 400', async () => {
    await withEnv({ OPENHUB_FLEET_CATALOG: fixturePath }, async () => {
      const res = await request(app).get('/api/ecosystem/agents').query({ kind: 'quantum' });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Unknown agent kind "quantum"' });
    });
  });

  it('POST /ecosystem/agents/:name/run → explicit 501 when no gsd executable is mapped', async () => {
    // Skip on machines that genuinely have `gsd` on PATH (dispatch would be real).
    const gsdResolvable = (() => {
      const prev = process.env.OPENHUB_GSD_CLI;
      delete process.env.OPENHUB_GSD_CLI;
      try {
        return resolveGsdCli() !== null;
      } finally {
        if (prev === undefined) delete process.env.OPENHUB_GSD_CLI;
        else process.env.OPENHUB_GSD_CLI = prev;
      }
    })();

    await withEnv({ OPENHUB_GSD_CLI: undefined }, async () => {
      if (gsdResolvable) return;
      const res = await request(app).post('/api/ecosystem/agents/unknown/run');

      expect(res.status).toBe(501);
      expect(res.body).toEqual({
        error: 'No executable mapped for agent "unknown"; dispatch not implemented',
      });
    });
  });

  it('POST → 400 when repoPath is missing on disk (real mapped executable)', async () => {
    await withEnv({ OPENHUB_GSD_CLI: process.execPath }, async () => {
      const res = await request(app)
        .post('/api/ecosystem/agents/test-agent/run')
        .send({ repoPath: path.join(tmp, 'ghost-repo') });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('repoPath does not exist');
    });
  });

  it('POST → 400 for a malformed agent name (shell-safety guard)', async () => {
    await withEnv({ OPENHUB_GSD_CLI: process.execPath }, async () => {
      const res = await request(app).post('/api/ecosystem/agents/bad%3Bname/run');

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid agent name');
    });
  });

  it('POST dispatches for real when an executable is mapped (temp gsd CLI)', async () => {
    const cliPath = path.join(tmp, process.platform === 'win32' ? 'gsd.cmd' : 'gsd');
    if (process.platform === 'win32') {
      fs.writeFileSync(cliPath, '@echo off\r\necho DISPATCH_OK:%2\r\n', 'utf-8');
    } else {
      fs.writeFileSync(cliPath, '#!/bin/sh\necho DISPATCH_OK:"$2"\n', 'utf-8');
      fs.chmodSync(cliPath, 0o755);
    }
    const repoPath = path.join(tmp, 'repo');
    fs.mkdirSync(repoPath, { recursive: true });

    await withEnv({ OPENHUB_GSD_CLI: cliPath }, async () => {
      const res = await request(app)
        .post('/api/ecosystem/agents/test-agent/run')
        .send({ repoPath });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.name).toBe('test-agent');
      expect(res.body.output).toContain('DISPATCH_OK');
      expect(res.body.durationMs).toBeGreaterThanOrEqual(0);
    });
  });
});