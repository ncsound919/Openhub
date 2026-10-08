import { describe, it, expect, vi, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createOpencodeProxyRouter } from '../src/routes/opencodeProxy.js';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api', createOpencodeProxyRouter({ authMiddleware: (_req, _res, next) => next() }));
  return a;
}

function engineOk(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
}

afterEach(() => vi.unstubAllGlobals());

describe('opencodeProxy', () => {
  it('GET /api/opencode/status reports engine availability honestly', async () => {
    const res = await request(app()).get('/api/opencode/status');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.data.available).toBe('boolean');
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
});
