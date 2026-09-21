// Route tests for the editor model-picker proxies added to
// src/routes/axiomProxy.ts: the provider catalog passthrough and the
// default-model setter (POST /axiom/editor/model -> Axiom /api/settings).
import { describe, it, expect, vi, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

import { createAxiomProxyRouter } from '../src/routes/axiomProxy';

function okJson(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use((req, _res, next) => { (req as unknown as { user: unknown }).user = { sub: 'u1' }; next(); });
  instance.use('/api', createAxiomProxyRouter({ authMiddleware: (_req, _res, next) => next() }));
  return instance;
}

afterEach(() => vi.unstubAllGlobals());

describe('axiomProxy editor model picker routes', () => {
  it('proxies the provider catalog from /api/pipeline/models', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return okJson({ groups: [{ provider: 'ollama', label: 'Ollama', models: ['minicpm'] }], current: 'minicpm' });
    }));
    const res = await request(app()).get('/api/axiom/editor/catalog');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.current).toBe('minicpm');
    expect(res.body.data.groups[0].provider).toBe('ollama');
    expect(calls[0].url).toContain('/api/pipeline/models');
  });

  it('sets the default model through Axiom settings', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return okJson({ model: 'minicpm' });
    }));
    const res = await request(app()).post('/api/axiom/editor/model').send({ model: '  minicpm  ' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.model).toBe('minicpm');
    expect(calls[0].url).toContain('/api/settings');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ model: 'minicpm' });
  });

  it('400s a missing model without calling Axiom', async () => {
    const fetchMock = vi.fn(async () => okJson({}));
    vi.stubGlobal('fetch', fetchMock);
    const res = await request(app()).post('/api/axiom/editor/model').send({ model: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('502s when Axiom rejects the settings write', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    const res = await request(app()).post('/api/axiom/editor/model').send({ model: 'x' });
    expect(res.status).toBe(502);
    expect(res.body.ok).toBe(false);
  });
});
