process.env.OPENHUB_RECEIPTS_DISABLE = '1';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

// Hermetic DB: workbench settings live in SQLite. Set before any getDb() call.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openhub-workbench-'));
process.env.OPENHUB_DB_PATH = path.join(tmpDir, 'workbench-test.db');

import { initializeDatabase } from '../src/auth/db.js';
import { createWorkbenchRouter } from '../src/routes/workbenchRoutes.js';
import { resetWorkbenchConfigCache } from '../src/services/workbenchClient.js';

function app() {
  const a = express();
  a.use(express.json());
  a.use(
    '/api',
    createWorkbenchRouter({
      authMiddleware: (_req, _res, next) => next()
    })
  );
  return a;
}

beforeAll(() => {
  initializeDatabase();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetWorkbenchConfigCache();
});

describe('workbench settings', () => {
  it('returns defaults with the token omitted, not blanked', async () => {
    const res = await request(app()).get('/api/workbench/config');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.config.url).toBe('http://127.0.0.1:8790');
    expect(res.body.config.enabled).toBe(true);
    // Prompt rewriting is opt-in; the tool surface is on by default.
    expect(res.body.config.autoContext).toBe(false);
    expect(res.body.config.hasToken).toBe(false);
    expect('token' in res.body.config).toBe(false);
  });

  it('rejects unknown settings instead of storing them', async () => {
    const res = await request(app()).put('/api/workbench/config').send({ teleport: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unknown setting/);
  });

  it('refuses a non-loopback URL unless allowRemote is on', async () => {
    const off = await request(app()).put('/api/workbench/config').send({ url: 'http://192.168.1.50:8790' });
    expect(off.status).toBe(400);
    expect(off.body.error).toMatch(/non-loopback/);

    const on = await request(app())
      .put('/api/workbench/config')
      .send({ allowRemote: true, url: 'http://192.168.1.50:8790' });
    expect(on.status).toBe(200);
    expect(on.body.config.url).toBe('http://192.168.1.50:8790');
  });

  it('stores a token write-only and never echoes it', async () => {
    const saved = await request(app())
      .put('/api/workbench/config')
      .send({ token: 'local-workbench-secret', url: 'http://127.0.0.1:8790', allowRemote: false });
    expect(saved.status).toBe(200);
    expect(saved.body.config.hasToken).toBe(true);
    expect(JSON.stringify(saved.body)).not.toContain('local-workbench-secret');

    const read = await request(app()).get('/api/workbench/config');
    expect(JSON.stringify(read.body)).not.toContain('local-workbench-secret');

    const mcp = await request(app()).get('/api/workbench/mcp-config');
    expect(mcp.status).toBe(200);
    expect(JSON.stringify(mcp.body)).not.toContain('local-workbench-secret');
    expect(mcp.body.http.url).toMatch(/\/mcp$/);
  });

  it('clears a stored token on request', async () => {
    await request(app()).put('/api/workbench/config').send({ token: 'abc123token' });
    const cleared = await request(app()).put('/api/workbench/config').send({ clearToken: true });
    expect(cleared.status).toBe(200);
    expect(cleared.body.config.hasToken).toBe(false);
  });
});

describe('workbench proxy', () => {
  it('forwards a tool call and keeps the structured result', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      new Response(
        JSON.stringify({ ok: true, tool: 'workbench_math_equivalent', summary: 'equivalent', data: { status: 'equivalent' } }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await request(app())
      .post('/api/workbench/call')
      .send({ tool: 'workbench_math_equivalent', arguments: { left: 'x+x', right: '2x' } });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.result.summary).toBe('equivalent');
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/call$/);
  });

  it('reports an unreachable workbench as 502, not as a passing tool', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:8790');
    }));
    const res = await request(app()).post('/api/workbench/call').send({ tool: 'workbench_capabilities' });
    expect(res.status).toBe(502);
    expect(res.body.ok).toBe(false);
    expect(res.body.result.error).toMatch(/ECONNREFUSED/);
  });

  it('requires a tool name and a non-empty context query', async () => {
    expect((await request(app()).post('/api/workbench/call').send({})).status).toBe(400);
    expect((await request(app()).post('/api/workbench/context').send({ query: '  ' })).status).toBe(400);
  });
});
