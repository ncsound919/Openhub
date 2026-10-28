import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import request from 'supertest';
import { createMemoryRecallRouter } from '../src/routes/memoryRecall';

interface Recorded {
  path: string;
  body: Record<string, unknown>;
}

let gateway: Server;
let gatewayBase: string;
let calls: Recorded[] = [];
let gatewayResponder: (path: string) => { status: number; body: unknown };

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', createMemoryRecallRouter({ authMiddleware: (_req, _res, next) => next() }));
  return app;
}

const SIEVE_REPLY = {
  query: 'x',
  available: true,
  hits: [{ id: 'src/a.ts:1', text: 'answer', score: 0.9, path: 'src/a.ts', line: 1 }],
  layers: {
    code: { available: true, count: 1, mode: 'hybrid' },
    recourse: { available: false, count: 0, reason: 'recourse unreachable' },
  },
};

const RECOURSE_REPLY = {
  success: true,
  query: 'x',
  hits: [{ id: 'lesson-1', text: 'a durable memory', score: 0.7, kind: 'lesson' }],
};

beforeEach(async () => {
  calls = [];
  gatewayResponder = (path) => {
    if (path === '/v1/sieve/recall') return { status: 200, body: SIEVE_REPLY };
    if (path === '/v1/recourse/recall') return { status: 200, body: RECOURSE_REPLY };
    return { status: 404, body: { error: 'not found' } };
  };
  gateway = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const path = req.url ?? '';
      calls.push({ path, body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {} });
      const reply = gatewayResponder(path);
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  const { port } = gateway.address() as AddressInfo;
  gatewayBase = `http://127.0.0.1:${port}`;
  process.env.OPENHUB_MOBILE_GATEWAY_URL = gatewayBase;
});

afterEach(async () => {
  await new Promise<void>((resolve) => gateway.close(() => resolve()));
  delete process.env.OPENHUB_MOBILE_GATEWAY_URL;
});

describe('POST /api/memory/recall', () => {
  it('rejects an empty or malformed query', async () => {
    const app = makeApp();
    expect((await request(app).post('/api/memory/recall').send({})).status).toBe(400);
    expect((await request(app).post('/api/memory/recall').send({ query: '   ' })).status).toBe(400);
    const bad = await request(app)
      .post('/api/memory/recall')
      .send({ query: 'x', source: 'nope' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/source/);
  });

  it('reports 503 with an honest reason when the gateway is not configured', async () => {
    delete process.env.OPENHUB_MOBILE_GATEWAY_URL;
    const res = await request(makeApp())
      .post('/api/memory/recall')
      .send({ query: 'how do approvals work' });
    expect(res.status).toBe(503);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/OPENHUB_MOBILE_GATEWAY_URL/);
    expect(res.body.results).toEqual({});
    expect(calls).toHaveLength(0);
  });

  it('fans a query out to both sources and merges their results', async () => {
    const res = await request(makeApp())
      .post('/api/memory/recall')
      .send({ query: 'how do approvals work', k: 5 });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.gateway).toBe(gatewayBase);
    expect(res.body.results.sieve.available).toBe(true);
    expect(res.body.results.sieve.hits[0].path).toBe('src/a.ts');
    expect(res.body.results.sieve.layers.recourse.available).toBe(false);
    expect(res.body.results.sieve.layers.recourse.reason).toBe('recourse unreachable');
    expect(res.body.results.recourse.available).toBe(true);
    expect(res.body.results.recourse.hits[0].kind).toBe('lesson');

    expect(calls.map((c) => c.path).sort()).toEqual(['/v1/recourse/recall', '/v1/sieve/recall']);
    expect(calls.find((c) => c.path === '/v1/sieve/recall')?.body).toMatchObject({
      query: 'how do approvals work',
      k: 5,
    });
    expect(calls.find((c) => c.path === '/v1/recourse/recall')?.body).toMatchObject({
      query: 'how do approvals work',
      topK: 5,
    });
  });

  it('only calls the requested source', async () => {
    const res = await request(makeApp())
      .post('/api/memory/recall')
      .send({ query: 'x', source: 'sieve' });
    expect(res.status).toBe(200);
    expect(res.body.results.sieve).toBeDefined();
    expect(res.body.results.recourse).toBeUndefined();
    expect(calls.map((c) => c.path)).toEqual(['/v1/sieve/recall']);
  });

  it('returns 503 with per-source reasons when the gateway refuses', async () => {
    gatewayResponder = (path) =>
      path === '/v1/sieve/recall'
        ? { status: 503, body: { error: 'SIEVE_URL not configured' } }
        : { status: 503, body: { error: 'recourse not configured' } };

    const res = await request(makeApp()).post('/api/memory/recall').send({ query: 'x' });
    expect(res.status).toBe(503);
    expect(res.body.ok).toBe(false);
    expect(res.body.results.sieve.available).toBe(false);
    expect(res.body.results.sieve.reason).toBe('SIEVE_URL not configured');
    expect(res.body.results.recourse.reason).toBe('recourse not configured');
    expect(res.body.results.sieve.hits).toEqual([]);
  });

  it('keeps one source online when the other fails', async () => {
    gatewayResponder = (path) =>
      path === '/v1/sieve/recall'
        ? { status: 200, body: SIEVE_REPLY }
        : { status: 502, body: { error: 'upstream unreachable' } };

    const res = await request(makeApp()).post('/api/memory/recall').send({ query: 'x' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.results.sieve.available).toBe(true);
    expect(res.body.results.recourse.available).toBe(false);
    expect(res.body.results.recourse.reason).toBe('upstream unreachable');
  });

  it('clamps k into the supported range', async () => {
    await request(makeApp()).post('/api/memory/recall').send({ query: 'x', k: 5000 });
    expect(calls[0].body.k).toBe(50);

    calls = [];
    await request(makeApp()).post('/api/memory/recall').send({ query: 'x', k: 0 });
    expect(calls[0].body.k).toBe(1);
  });
});