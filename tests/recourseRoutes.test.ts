import { describe, it, expect, vi, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRecourseRouter } from '../src/routes/recourse';

function okJson(body: unknown = { success: true }) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use('/api', createRecourseRouter({ authMiddleware: (_req, _res, next) => next() }));
  return instance;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('recourse router — reads', () => {
  it('proxies the read surface', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okJson()));
    const a = app();
    const paths = [
      '/api/recourse/status',
      '/api/recourse/synergy/map',
      '/api/recourse/agenda',
      '/api/recourse/agenda/next',
      '/api/recourse/registry',
      '/api/recourse/capabilities',
      '/api/recourse/upgrade-report',
      '/api/recourse/learn/status',
      '/api/recourse/dream/status',
      '/api/recourse/selfhosted',
      '/api/recourse/skills',
    ];
    for (const path of paths) {
      const res = await request(a).get(path);
      expect(res.status, path).toBe(200);
      expect(res.body.available).toBe(true);
    }
    expect((await request(a).get('/api/recourse/memory/recall?q=bloom')).status).toBe(200);
    expect((await request(a).get('/api/recourse/provenance?limit=5')).status).toBe(200);
  });

  it('validates query/targetDir inputs', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okJson()));
    const a = app();
    expect((await request(a).get('/api/recourse/memory/recall')).status).toBe(400);
    expect((await request(a).post('/api/recourse/repair/scan-heal').send({})).status).toBe(400);
  });

  it('503s when Recourse is offline', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('down', { status: 503 })));
    const a = app();
    const res = await request(a).get('/api/recourse/status');
    expect(res.status).toBe(503);
    expect(res.body.available).toBe(false);
  });
});

describe('recourse router — guarded writes', () => {
  it('fails closed without RECOURSE_API_SECRET', async () => {
    vi.stubEnv('RECOURSE_API_SECRET', '');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const a = app();
    const forge = await request(a).post('/api/recourse/forge/run').send({});
    expect(forge.status).toBe(503);
    expect(forge.body.available).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('runs guarded writes with a secret', async () => {
    vi.stubEnv('RECOURSE_API_SECRET', 'secret');
    vi.stubGlobal('fetch', vi.fn(async () => okJson({ success: true })));
    const a = app();
    expect((await request(a).post('/api/recourse/forge/run').send({})).status).toBe(200);
    expect((await request(a).post('/api/recourse/selfhosted/bloomFilter/execute').send({ args: { n: 1 } })).status).toBe(200);
  });

  it('rejects an invalid self-hosted tool name', async () => {
    vi.stubEnv('RECOURSE_API_SECRET', 'secret');
    vi.stubGlobal('fetch', vi.fn(async () => okJson()));
    const a = app();
    const res = await request(a).post('/api/recourse/selfhosted/a b/execute').send({ args: {} });
    expect(res.status).toBe(400);
  });
});
