process.env.OPENHUB_RECEIPTS_DISABLE = '1';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, vi, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createOpencodeProxyRouter, defaultPromptModel } from '../src/routes/opencodeProxy.js';
import { listReceipts } from '../src/services/receipts.js';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api', createOpencodeProxyRouter({
    authMiddleware: (_req, _res, next) => next(),
    // Pure env resolution: no local-model probe in unit tests.
    resolveDefaultModel: async () => defaultPromptModel(),
  }));
  return a;
}

function engineOk(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
}

afterEach(() => vi.unstubAllGlobals());

describe('opencodeProxy', () => {
  it('GET /api/opencode/status reports available:true only when the engine says healthy', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => engineOk('{"healthy":true,"version":"1.2.3"}')));
    const up = await request(app()).get('/api/opencode/status');
    expect(up.body.data).toMatchObject({ available: true, version: '1.2.3' });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    const down = await request(app()).get('/api/opencode/status');
    expect(down.status).toBe(200);
    expect(down.body.data).toMatchObject({ available: false });
    expect(String(down.body.data.error)).toMatch(/ECONNREFUSED/);
  });

  it('GET /api/opencode/permissions reads the engine-wide pending list', async () => {
    const list = [{ id: 'per_1', sessionID: 'ses_1', permission: 'bash', patterns: ['ls'], metadata: {} }];
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => engineOk(JSON.stringify(list)));
    vi.stubGlobal('fetch', fetchMock);
    const res = await request(app()).get('/api/opencode/permissions');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, data: list });
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/permission$/);
  });

  it('prompt rejects empty parts (400, no engine call)', async () => {
    const fetchMock = vi.fn(async () => engineOk('true'));
    vi.stubGlobal('fetch', fetchMock);
    const res = await request(app()).post('/api/opencode/sessions/ses_1/prompt').send({ parts: [] });
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('permission reply validates the verdict and forwards it', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => engineOk('true'));
    vi.stubGlobal('fetch', fetchMock);
    const bad = await request(app()).post('/api/opencode/sessions/ses_1/permissions/per_1').send({ response: 'yolo' });
    expect(bad.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    const ok = await request(app()).post('/api/opencode/sessions/ses_1/permissions/per_1').send({ response: 'once' });
    expect(ok.body).toEqual({ ok: true, data: true });
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/session\/ses_1\/permissions\/per_1$/);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ response: 'once' });
  });

  it('operator gate covers permission replies and is case-insensitive', async () => {
    process.env.OPENHUB_ADMIN_ROLES = 'owner';
    try {
      const fetchMock = vi.fn(async () => engineOk('true'));
      vi.stubGlobal('fetch', fetchMock);
      const a = await request(app()).post('/api/opencode/sessions/ses_1/permissions/per_1').send({ response: 'once' });
      const b = await request(app()).post('/api/OPENCODE/Engine/Start').send({});
      expect(a.status).toBe(403);
      expect(b.status).toBe(403);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally { delete process.env.OPENHUB_ADMIN_ROLES; }
  });

  it('POST /api/opencode/sessions/:id/revert rejects a missing messageID (400, no engine call)', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => engineOk('true'));
    vi.stubGlobal('fetch', fetchMock);
    const res = await request(app()).post('/api/opencode/sessions/ses_1/revert').send({});
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(String(res.body.error)).toMatch(/messageID/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POST /api/opencode/sessions/:id/revert forwards the messageID and keeps the envelope', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => engineOk('true'));
    vi.stubGlobal('fetch', fetchMock);
    const res = await request(app()).post('/api/opencode/sessions/ses_1/revert').send({ messageID: 'msg_1' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, data: true });
    const call = fetchMock.mock.calls[0];
    expect(String(call[0])).toMatch(/\/session\/ses_1\/revert$/);
    expect(call[1]?.method).toBe('POST');
    expect(JSON.parse(String(call[1]?.body))).toEqual({ messageID: 'msg_1' });
  });

  it('POST /api/opencode/sessions/:id/unrevert is reachable and keeps the envelope', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => engineOk('true'));
    vi.stubGlobal('fetch', fetchMock);
    const res = await request(app()).post('/api/opencode/sessions/ses_1/unrevert').send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, data: true });
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/session\/ses_1\/unrevert$/);
  });

  it('POST /api/opencode/sessions/:id/prompt_async forwards steer parts', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await request(app())
      .post('/api/opencode/sessions/ses_1/prompt_async')
      .send({ parts: [{ type: 'text', text: 'keep going' }] });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const call = fetchMock.mock.calls[0];
    expect(String(call[0])).toMatch(/\/session\/ses_1\/prompt_async$/);
    expect(JSON.parse(String(call[1]?.body))).toEqual({ parts: [{ type: 'text', text: 'keep going' }] });
  });

  it('prompt forwards a validated model and agent, and rejects malformed ones', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const ok = await request(app()).post('/api/opencode/sessions/ses_1/prompt')
      .send({ parts: [{ type: 'text', text: 'hi' }], model: { providerID: 'opencode-go', modelID: 'deepseek-v4.1-flash' }, agent: 'build' });
    expect(ok.status).toBe(200);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      parts: [{ type: 'text', text: 'hi' }], model: { providerID: 'opencode-go', modelID: 'deepseek-v4.1-flash' }, agent: 'build',
    });
    const badModel = await request(app()).post('/api/opencode/sessions/ses_1/prompt').send({ parts: [{}], model: { providerID: 'x' } });
    const badAgent = await request(app()).post('/api/opencode/sessions/ses_1/prompt').send({ parts: [{}], agent: '../../etc' });
    expect(badModel.status).toBe(400);
    expect(badAgent.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('applies OPENHUB_OPENCODE_MODEL only when the prompt names no model', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    process.env.OPENHUB_OPENCODE_MODEL = 'opencode/beam-free';
    try {
      await request(app()).post('/api/opencode/sessions/ses_1/prompt').send({ parts: [{ type: 'text', text: 'go' }] });
      expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
        parts: [{ type: 'text', text: 'go' }], model: { providerID: 'opencode', modelID: 'beam-free' },
      });
      // A provider id containing slashes keeps everything after the first slash as the model.
      process.env.OPENHUB_OPENCODE_MODEL = 'cloudflare-ai-gateway/openai/gpt-5.4-mini';
      await request(app()).post('/api/opencode/sessions/ses_1/prompt').send({ parts: [{ type: 'text', text: 'go' }] });
      expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).model).toEqual({
        providerID: 'cloudflare-ai-gateway', modelID: 'openai/gpt-5.4-mini',
      });
      // An explicit client model still wins.
      await request(app()).post('/api/opencode/sessions/ses_1/prompt')
        .send({ parts: [{ type: 'text', text: 'go' }], model: { providerID: 'mistral', modelID: 'codestral-latest' } });
      expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body)).model).toEqual({ providerID: 'mistral', modelID: 'codestral-latest' });
    } finally {
      delete process.env.OPENHUB_OPENCODE_MODEL;
    }
  });

  it('ignores an unset or malformed OPENHUB_OPENCODE_MODEL (never invents a model)', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const before = process.env.OPENHUB_OPENCODE_MODEL;
    try {
      await request(app()).post('/api/opencode/sessions/ses_1/prompt').send({ parts: [{ type: 'text', text: 'go' }] });
      expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).not.toHaveProperty('model');
      for (const bad of ['', '  ', 'opencode', 'opencode/', '/beam-free']) {
        process.env.OPENHUB_OPENCODE_MODEL = bad;
        await request(app()).post('/api/opencode/sessions/ses_1/prompt').send({ parts: [{ type: 'text', text: 'go' }] });
      }
      for (const call of fetchMock.mock.calls) {
        expect(JSON.parse(String(call[1]?.body))).not.toHaveProperty('model');
      }
    } finally {
      if (before === undefined) delete process.env.OPENHUB_OPENCODE_MODEL;
      else process.env.OPENHUB_OPENCODE_MODEL = before;
    }
  });

  it('falls back to the resolver local model when nothing is configured', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const a = express();
    a.use(express.json());
    a.use('/api', createOpencodeProxyRouter({
      authMiddleware: (_req, _res, next) => next(),
      resolveDefaultModel: async () => ({ providerID: 'local', modelID: 'qwen3.5-4b' }),
    }));
    await request(a).post('/api/opencode/sessions/ses_1/prompt').send({ parts: [{ type: 'text', text: 'go' }] });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).model).toEqual({ providerID: 'local', modelID: 'qwen3.5-4b' });
  });

  it('records an audit receipt for mutating calls (verdict included, body text excluded)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => engineOk('true')));
    const before = listReceipts({ limit: 1000 }).length;
    await request(app()).post('/api/opencode/sessions/ses_1/permissions/per_1').send({ response: 'always' });
    await request(app()).post('/api/opencode/sessions/ses_1/prompt').send({ parts: [{ type: 'text', text: 'SECRET-PROMPT-TEXT' }] });
    await request(app()).get('/api/opencode/sessions');
    const fresh = listReceipts({ limit: 1000 }).slice(0, listReceipts({ limit: 1000 }).length - before);
    const mine = fresh.filter((r) => r.tool === 'opencode');
    expect(mine).toHaveLength(2); // the GET is not audited
    expect(mine.some((r) => r.command.endsWith('/permissions/per_1') && r.meta?.verdict === 'always')).toBe(true);
    expect(JSON.stringify(mine)).not.toContain('SECRET-PROMPT-TEXT');
  });

  it('fans one upstream event stream out to every client', async () => {
    let push!: (s: string) => void;
    const body = new ReadableStream<Uint8Array>({
      start(c) { const enc = new TextEncoder(); push = (s) => c.enqueue(enc.encode(s)); },
    });
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => new Response(body, { status: 200 }));
    // supertest/http to localhost must still hit the real network, so only the
    // upstream engine URL is stubbed.
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', (url: string | URL, init?: RequestInit) =>
      String(url).includes(':4196/event') ? fetchMock(url, init) : realFetch(url, init));
    const server = app().listen(0);
    const port = (server.address() as AddressInfo).port;
    const open = () => new Promise<{ got: () => string; close: () => void }>((resolve) => {
      let buf = '';
      const req = http.get({ port, path: '/api/opencode/events' }, (res) => {
        res.on('data', (d) => { buf += d; });
        resolve({ got: () => buf, close: () => req.destroy() });
      });
    });
    try {
      const [a, b] = [await open(), await open()];
      await new Promise((r) => setTimeout(r, 50));
      push('data: {"type":"session.idle"}\n\n');
      await new Promise((r) => setTimeout(r, 100));
      expect(a.got()).toContain('session.idle');
      expect(b.got()).toContain('session.idle');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      a.close(); b.close();
    } finally { server.closeAllConnections?.(); server.close(); }
  });

  it('status reports providerCount (0 when the engine has none, null when unknown)', async () => {
    const route = (providers: string) => vi.fn(async (url: string | URL) =>
      String(url).includes('/config/providers') ? engineOk(providers) : engineOk('{"healthy":true}'));
    vi.stubGlobal('fetch', route('{"providers":[],"default":{}}'));
    expect((await request(app()).get('/api/opencode/status')).body.data.providerCount).toBe(0);
    vi.stubGlobal('fetch', route('{"providers":[{"id":"opencode-go"}]}'));
    expect((await request(app()).get('/api/opencode/status')).body.data.providerCount).toBe(1);
    vi.stubGlobal('fetch', route('not json'));
    expect((await request(app()).get('/api/opencode/status')).body.data.providerCount).toBeNull();
  });

  it('prompt rejects malformed parts', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => engineOk('true')));
    for (const parts of [['str'], [null], Array.from({ length: 21 }, () => ({ type: 'text' }))]) {
      expect((await request(app()).post('/api/opencode/sessions/ses_1/prompt').send({ parts })).status).toBe(400);
    }
  });

  it('with the operator gate set, reads are operator-only but status stays open', async () => {
    process.env.OPENHUB_ADMIN_ROLES = 'owner';
    try {
      vi.stubGlobal('fetch', vi.fn(async () => engineOk('{"healthy":true}')));
      expect((await request(app()).get('/api/opencode/sessions')).status).toBe(403);
      expect((await request(app()).get('/api/OPENCODE/events')).status).toBe(403);
      expect((await request(app()).get('/api/opencode/status')).status).toBe(200);
    } finally { delete process.env.OPENHUB_ADMIN_ROLES; }
  });
});
