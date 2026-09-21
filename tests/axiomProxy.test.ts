import { describe, it, expect, vi, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../src/services/projectContext', () => ({
  getActiveProject: () => ({ id: 'p1', path: 'C:/work/proj', repositoryName: 'acme/app' }),
}));

import { createAxiomProxyRouter } from '../src/routes/axiomProxy';
import { resetLocalTierCache, clearLocalCompletionCache } from '../src/services/localCompletion';

function okJson(body: unknown = { ok: true }) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

function app() {
  const instance = express();
  instance.use(express.json());
  // Simulate an authenticated session for the routes that require req.user.
  instance.use((req, _res, next) => {
    (req as any).user = { sub: 'u1' };
    next();
  });
  instance.use('/api', createAxiomProxyRouter({ authMiddleware: (_req, _res, next) => next() }));
  return instance;
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetLocalTierCache();
  clearLocalCompletionCache();
});

describe('axiomProxy routes — success', () => {
  it('proxies the full Axiom surface', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okJson({ ok: true, status: 'done', id: 'x' })));
    const a = app();
    const cases: Array<[string, string, unknown?]> = [
      ['get', '/api/axiom/status'],
      ['get', '/api/axiom/capabilities'],
      ['post', '/api/axiom/project/run', { goal: 'build it' }],
      ['get', '/api/axiom/project/status/loop_1'],
      ['post', '/api/axiom/project/stop/loop_1'],
      ['post', '/api/axiom/project/rewind/loop_1'],
      ['get', '/api/axiom/project/diff/loop_1'],
      ['get', '/api/axiom/project/share/loop_1'],
      ['get', '/api/axiom/mission/share/m1'],
      ['post', '/api/axiom/mission/run', { goal: 'mission', skills: ['a'] }],
      ['get', '/api/axiom/mission/status/m1'],
      ['get', '/api/axiom/mission/list'],
      ['post', '/api/axiom/mission/approve/m1', { by: 'me' }],
      ['post', '/api/axiom/mission/reject/m1', { reason: 'no' }],
      ['get', '/api/axiom/mission/m1/worktrees'],
      ['get', '/api/axiom/mission/m1/worktree/t1/diff'],
      ['post', '/api/axiom/mission/m1/worktree/t1/merge', { message: 'merge t1' }],
      ['post', '/api/axiom/mission/m1/worktree/t1/discard'],
      ['get', '/api/axiom/skills'],
      ['get', '/api/axiom/telemetry/export'],
      ['post', '/api/axiom/retrieve', { goal: 'recall' }],
      ['get', '/api/axiom/sessions'],
      ['post', '/api/axiom/sessions', { title: 't' }],
      ['get', '/api/axiom/sessions/s1'],
      ['post', '/api/axiom/sessions/s1/messages', { messages: [{ role: 'user', text: 'hi' }] }],
      ['post', '/api/axiom/editor/complete', { file: 'a.ts', content: 'x', line: 1, column: 1 }],
      ['post', '/api/axiom/editor/inline-edit', { file: 'a.ts', content: 'x', selection: 'x', instruction: 'y' }],
      ['post', '/api/axiom/editor/latency-probe', { file: 'a.ts', content: 'x', line: 1, column: 1, dir: 'proj' }],
      ['post', '/api/axiom/editor/next-edit', { dir: 'proj', file: 'a.ts', content: 'x', line: 1, column: 1 }],
      ['get', '/api/axiom/editor/models'],
      ['post', '/api/axiom/editor/diagnostics', { file: 'a.ts' }],
      ['get', '/api/axiom/editor/warm'],
      ['post', '/api/axiom/editor/warm/start'],
      ['post', '/api/axiom/editor/warm/stop'],
    ];
    for (const [method, path, body] of cases) {
      const res = method === 'get'
        ? await request(a).get(path)
        : await request(a).post(path).send(body ?? {});
      expect(res.status, `${method} ${path}`).toBe(200);
      expect(res.body.ok).toBe(true);
    }
  });
});

describe('axiomProxy editor lane — timed proxies', () => {
  it('reports proxyMs alongside the Axiom payload', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okJson({ ok: true, text: 'hi', source: 'local-model' })));
    const a = app();
    const res = await request(a).post('/api/axiom/editor/complete').send({ file: 'a.ts', content: 'x', line: 1, column: 1 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.proxyMs).toBe('number');
  });
});

describe('axiomProxy editor lane — LSP diagnostics', () => {
  it('passes real diagnostics through and 503s honestly when unconfigured', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okJson({
      ok: true,
      file: '/p/a.ts',
      diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 1, message: 'boom' }],
    })));
    const a = app();
    const res = await request(a).post('/api/axiom/editor/diagnostics').send({ file: '/p/a.ts' });
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(true);
    expect(res.body.diagnostics).toHaveLength(1);

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: false, error: 'no language server configured' }), { status: 503, headers: { 'content-type': 'application/json' } })));
    const b = await request(a).post('/api/axiom/editor/diagnostics').send({ file: '/p/a.rs' });
    expect(b.status).toBe(503);
    expect(b.body.available).toBe(false);

    expect((await request(a).post('/api/axiom/editor/diagnostics').send({})).status).toBe(400);
  });
});

describe('axiomProxy editor lane — warm transport', () => {
  it('proxies warm status + start to the client', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okJson({ ok: true, target: { base: 'http://127.0.0.1:11434/v1', model: 'm' }, keepalive: true })));
    const a = app();
    const status = await request(a).get('/api/axiom/editor/warm');
    expect(status.status).toBe(200);
    expect(status.body.data.target.model).toBe('m');
    const start = await request(a).post('/api/axiom/editor/warm/start');
    expect(start.status).toBe(200);
    expect(start.body.ok).toBe(true);
  });
});

describe('axiomProxy editor lane — warm path', () => {
  it('serves completion from the local model directly when a tier is discovered', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      const u = String(url);
      calls.push(u);
      if (u.endsWith('/api/editor/models')) return okJson({ ok: true, configured: 'm', models: ['m'], base: 'http://127.0.0.1:11434/v1' });
      if (u.endsWith('/api/generate')) return okJson({ response: ' warm()' });
      return okJson({ ok: true, text: 'axiom-path' });
    }));
    const a = app();
    const res = await request(a).post('/api/axiom/editor/complete').send({ file: 'warm.ts', content: 'const w = ', line: 1, column: 11 });
    expect(res.status).toBe(200);
    expect(res.body.warm).toBe(true);
    expect(res.body.data.text).toContain('warm()');
    expect(res.body.data.lane).toBe('fim');
    // The model was called directly, not only through Axiom.
    expect(calls.some((u) => u.includes('127.0.0.1:11434'))).toBe(true);
  });

  it('falls back to the Axiom proxy when no local tier is configured', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      if (String(url).endsWith('/api/editor/models')) return okJson({ ok: true, configured: null, models: [], base: null });
      return okJson({ ok: true, text: 'axiom-path', source: 'local-model', lane: 'chat' });
    }));
    const a = app();
    const res = await request(a).post('/api/axiom/editor/complete').send({ file: 'f.ts', content: 'x', line: 1, column: 1 });
    expect(res.status).toBe(200);
    expect(res.body.warm).toBe(false);
    expect(res.body.data.text).toBe('axiom-path');
  });
});

describe('axiomProxy routes — validation + failures', () => {
  it('validates required goals', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okJson()));
    const a = app();
    expect((await request(a).post('/api/axiom/project/run').send({})).status).toBe(400);
    expect((await request(a).post('/api/axiom/mission/run').send({})).status).toBe(400);
    expect((await request(a).post('/api/axiom/retrieve').send({})).status).toBe(400);
  });

  it('502s when Axiom rejects the upstream call', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    const a = app();
    expect((await request(a).get('/api/axiom/status')).status).toBe(502);
    expect((await request(a).post('/api/axiom/project/run').send({ goal: 'x' })).status).toBe(502);
  });

  it('401s protected routes without an authenticated user', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okJson()));
    const instance = express();
    instance.use(express.json());
    instance.use('/api', createAxiomProxyRouter({ authMiddleware: (_req, _res, next) => next() }));
    const noGoal = await request(instance).post('/api/axiom/mission/run').send({ goal: 'x' });
    expect(noGoal.status).toBe(401);
    const retrieve = await request(instance).post('/api/axiom/retrieve').send({ goal: 'x' });
    expect(retrieve.status).toBe(401);
  });
});

describe('editor completion stream lane', () => {
  // Regression: the browser client POSTs /api/axiom/editor/complete-stream. That
  // proxy route was missing, so the whole streaming Tab lane 404'd and silently
  // fell back while the status bar advertised a stream lane.
  it('pipes SSE frames from Axiom through /axiom/editor/complete-stream', async () => {
    const sse = 'data: {"type":"delta","text":"const x","source":"local-model","firstTokenMs":42}\n\n'
      + 'data: {"type":"done","text":"const x = 1","source":"local-model","lane":"fim"}\n\n';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(sse, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })));
    const res = await request(app())
      .post('/api/axiom/editor/complete-stream')
      .send({ file: 'a.ts', content: 'const ', line: 1, column: 7 });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.text).toContain('"type":"delta"');
    expect(res.text).toContain('"type":"done"');
  });
});
