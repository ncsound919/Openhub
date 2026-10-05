import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../src/services/agentRegistry', () => ({ getAgentRoster: vi.fn() }));

import { closeDb, getDb, initializeDatabase } from '../src/auth/db';
import { getAgentRoster } from '../src/services/agentRegistry';
import { createResearchRouter } from '../src/routes/research';

let tmp: string;
let previousDbPath: string | undefined;
let reachableDir: string;
let noEndpointDir: string;
let badJsonDir: string;
let noManifestDir: string;
let absentPath: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'research-routes-'));
  previousDbPath = process.env.OPENHUB_DB_PATH;
  process.env.OPENHUB_DB_PATH = path.join(tmp, 'test.db');
  closeDb();
  initializeDatabase();

  reachableDir = path.join(tmp, 'reachable');
  noEndpointDir = path.join(tmp, 'no-endpoint');
  badJsonDir = path.join(tmp, 'bad-json');
  noManifestDir = path.join(tmp, 'no-manifest');
  absentPath = path.join(tmp, 'absent');
  for (const dir of [reachableDir, noEndpointDir, badJsonDir, noManifestDir]) fs.mkdirSync(dir, { recursive: true });

  fs.writeFileSync(
    path.join(reachableDir, 'agent.json'),
    JSON.stringify({ name: 'AgentBrowser', runtime: { endpoint: 'http://127.0.0.1:9999/', healthPath: '/health' } }),
  );
  fs.writeFileSync(path.join(noEndpointDir, 'agent.json'), JSON.stringify({ name: 'No Endpoint' }));
  fs.writeFileSync(path.join(badJsonDir, 'agent.json'), '{ not json');
});

afterAll(() => {
  closeDb();
  if (previousDbPath === undefined) delete process.env.OPENHUB_DB_PATH;
  else process.env.OPENHUB_DB_PATH = previousDbPath;
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  try { getDb().prepare('DELETE FROM research_queries').run(); } catch { /* table not created yet */ }

  vi.mocked(getAgentRoster).mockReturnValue({
    audit: [],
    research: [
      { role: 'research', path: reachableDir, slug: 'agentbrowser', name: 'AgentBrowser', description: '', present: true, manifest: 'agent.json' },
      { role: 'research', path: noEndpointDir, slug: 'no-endpoint', name: 'No Endpoint', description: '', present: true, manifest: 'agent.json' },
      { role: 'research', path: badJsonDir, slug: 'bad-json', name: 'Bad Json', description: '', present: true, manifest: 'agent.json' },
      { role: 'research', path: noManifestDir, slug: 'no-manifest', name: 'No Manifest', description: '', present: true, manifest: 'directory' },
      { role: 'research', path: absentPath, slug: 'absent', name: 'Absent', description: '', present: false, manifest: null },
    ],
  } as any);
});

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', createResearchRouter({ authMiddleware: (_req, _res, next) => next() }));
  return app;
}

function healthOk() {
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('research — POST /research/ask validation', () => {
  it('400s when the query is missing, blank, or not a string', async () => {
    const app = makeApp();
    expect((await request(app).post('/api/research/ask').send({})).status).toBe(400);
    expect((await request(app).post('/api/research/ask').send({ query: '   ' })).status).toBe(400);
    const numeric = await request(app).post('/api/research/ask').send({ query: 123 });
    expect(numeric.status).toBe(400);
    expect(numeric.body.error).toBe('query is required');
  });
});

describe('research — POST /research/ask probing', () => {
  it('reports the whole backend roster and persists the query', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => healthOk()));
    const res = await request(makeApp()).post('/api/research/ask').send({ query: '  what is up  ' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.query).toBe('what is up');
    expect(res.body.answered).toBe(true);
    expect(res.body.note).toContain('1 research engine reachable');

    const backends = res.body.backends as Array<{ slug: string; reachable: boolean; note: string; endpoint?: string }>;
    expect(backends).toHaveLength(5);
    const bySlug = Object.fromEntries(backends.map((b) => [b.slug, b]));
    expect(bySlug.agentbrowser.reachable).toBe(true);
    expect(bySlug.agentbrowser.endpoint).toBe('http://127.0.0.1:9999/');
    expect(bySlug['no-endpoint'].reachable).toBe(false);
    expect(bySlug['no-endpoint'].note).toContain('no runtime.endpoint advertised');
    expect(bySlug['bad-json'].reachable).toBe(false);
    expect(bySlug['no-manifest'].reachable).toBe(false);
    expect(bySlug.absent.reachable).toBe(false);
    expect(bySlug.absent.note).toBe('directory not on disk');

    const queries = await request(makeApp()).get('/api/research/queries');
    expect(queries.status).toBe(200);
    expect(queries.body.queries).toHaveLength(1);
    expect(queries.body.queries[0].query).toBe('what is up');
    expect(queries.body.queries[0].result).not.toBeNull();
  });

  it('reports answered:false when a backend responds non-200', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('down', { status: 500 })));
    const res = await request(makeApp()).post('/api/research/ask').send({ query: 'anything' });
    expect(res.status).toBe(200);
    expect(res.body.answered).toBe(false);
    expect(res.body.note).toContain('No research engine reachable');
    const reachable = (res.body.backends as Array<{ slug: string; reachable: boolean; note: string }>).find(
      (b) => b.slug === 'agentbrowser',
    );
    expect(reachable?.reachable).toBe(false);
    expect(reachable?.note).toBe('HTTP 500');
  });

  it('reports answered:false when the backend fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const res = await request(makeApp()).post('/api/research/ask').send({ query: 'anything' });
    expect(res.status).toBe(200);
    expect(res.body.answered).toBe(false);
    const reachable = (res.body.backends as Array<{ slug: string; reachable: boolean; note: string }>).find(
      (b) => b.slug === 'agentbrowser',
    );
    expect(reachable?.note).toBe('ECONNREFUSED');
  });
});

describe('research — GET /research/queries', () => {
  it('returns an empty list, then tolerates a corrupt persisted row', async () => {
    const empty = await request(makeApp()).get('/api/research/queries');
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ ok: true, queries: [] });

    getDb().prepare(
      'INSERT INTO research_queries (id, query, result_json, created_at) VALUES (?, ?, ?, ?)',
    ).run('bad', 'q', '{ not json', new Date().toISOString());

    const res = await request(makeApp()).get('/api/research/queries');
    expect(res.status).toBe(200);
    expect(res.body.queries).toHaveLength(1);
    expect(res.body.queries[0].result).toBeNull();
  });
});
