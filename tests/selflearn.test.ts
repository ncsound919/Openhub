import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import request from 'supertest';
import { createSelfLearnRouter } from '../src/routes/selflearn';

let dir: string;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openhub-selflearnroute-'));
  vi.stubEnv('OPENHUB_SELFLEARNING_DIR', dir);
  vi.stubEnv('RECOURSE_API_SECRET', '');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use('/api', createSelfLearnRouter({ authMiddleware: (_req, _res, next) => next() }));
  return instance;
}

describe('selflearn router', () => {
  it('serves empty learner state initially', async () => {
    const res = await request(app()).get('/api/selflearn/state');
    expect(res.status).toBe(200);
    expect(res.body.state.episodeCount).toBe(0);
  });

  it('records an episode and reflects it in skills', async () => {
    const posted = await request(app())
      .post('/api/selflearn/outcome')
      .send({ kind: 'supervision', outcome: 'accepted', skills: ['RepoRank'] });
    expect(posted.status).toBe(200);
    expect(posted.body.wrote).toBe(true);

    const skills = await request(app()).get('/api/selflearn/skills');
    expect(skills.body.skills[0].name).toBe('RepoRank');
  });

  it('validates episode input', async () => {
    const noKind = await request(app()).post('/api/selflearn/outcome').send({ outcome: 'accepted' });
    expect(noKind.status).toBe(400);
    const noOutcome = await request(app()).post('/api/selflearn/outcome').send({ kind: 'supervision' });
    expect(noOutcome.status).toBe(400);
  });

  it('reports Recourse self-development offline honestly (503)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('down', { status: 503 })));
    const registry = await request(app()).get('/api/selflearn/registry');
    expect(registry.status).toBe(503);
    expect(registry.body.available).toBe(false);
  });

  it('is fail-closed for the guarded forge without a Recourse secret', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await request(app()).post('/api/selflearn/forge').send({});
    expect(res.status).toBe(503);
    expect(res.body.available).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an invalid self-hosted tool name', async () => {
    const res = await request(app()).post('/api/selflearn/tools/../evil/execute').send({ args: {} });
    // Express normalizes the path; either a 404 or the guarded 400 is acceptable.
    expect([400, 404]).toContain(res.status);
  });
});
