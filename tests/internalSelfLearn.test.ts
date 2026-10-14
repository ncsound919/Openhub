import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';

// recordEpisode/skillStats are the service under construction of the selflern
// surface; mocked so the routes test only the contract and the guard.
vi.mock('../src/services/selfLearning', () => ({
  recordEpisode: vi.fn(() => ({ wrote: true, id: 'ep_1' })),
  skillStats: vi.fn(() => [
    { name: 'sieve-rule-calibration', kind: 'tool', attempts: 3, accepted: 2, successRate: 2 / 3 },
  ]),
}));

import { recordEpisode, skillStats } from '../src/services/selfLearning';
import { createInternalAuditRouter, isInternalAuthed } from '../src/routes/internalAuditRoutes';

const SECRET = 'test-internal-secret-123';

function makeApp(env: Record<string, string | undefined> = { OPENHUB_INTERNAL_SECRET: SECRET }) {
  const app = express();
  const prev = { ...process.env };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  app.use('/api', createInternalAuditRouter());
  return { app, cleanup: () => { for (const k of Object.keys(env)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; } } };
}

const episode = {
  kind: 'sieve-rule-calibration',
  outcome: 'accepted',
  goal: 'calibrate detector rule SQLI_001',
  action: 'rule-calibration',
  skills: ['SQLI_001'],
  systems: ['sieve'],
  signals: { ruleId: 'SQLI_001', precision: 0.75 },
};

describe('internal selflearn surface (machine-to-machine)', () => {
  let app: express.Express;
  let cleanup: () => void;

  beforeAll(() => {
    const made = makeApp();
    app = made.app;
    cleanup = made.cleanup;
  });

  afterAll(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('isInternalAuthed fails closed when the secret is unset', () => {
    expect(isInternalAuthed('anything', {} as NodeJS.ProcessEnv)).toBe(false);
    expect(isInternalAuthed(undefined, { OPENHUB_INTERNAL_SECRET: SECRET } as NodeJS.ProcessEnv)).toBe(false);
    // Wrong length answers false; wrong value of the same length answers false.
    expect(isInternalAuthed('short', { OPENHUB_INTERNAL_SECRET: SECRET } as NodeJS.ProcessEnv)).toBe(false);
    expect(isInternalAuthed('x'.repeat(SECRET.length), { OPENHUB_INTERNAL_SECRET: SECRET } as NodeJS.ProcessEnv)).toBe(false);
    expect(isInternalAuthed(SECRET, { OPENHUB_INTERNAL_SECRET: SECRET } as NodeJS.ProcessEnv)).toBe(true);
  });

  it('answers 503 fail-closed when the route env has no secret', async () => {
    const made = makeApp({ OPENHUB_INTERNAL_SECRET: undefined });
    try {
      const res = await request(made.app).post('/api/internal/selflearn/outcome').send(episode);
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('INTERNAL_AUDIT_DISABLED');
    } finally {
      made.cleanup();
    }
  });

  it('answers 401 with a wrong secret even when configured', async () => {
    const res = await request(app)
      .post('/api/internal/selflearn/outcome')
      .set('x-internal-secret', 'not-the-secret')
      .send(episode);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
  });

  it('records a valid episode via x-internal-secret', async () => {
    const res = await request(app)
      .post('/api/internal/selflearn/outcome')
      .set('x-internal-secret', SECRET)
      .send(episode);
    expect(res.status).toBe(200);
    expect(res.body.wrote).toBe(true);
    expect(recordEpisode).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'sieve-rule-calibration',
      outcome: 'accepted',
      skills: ['SQLI_001'],
    }));
  });

  it('records a valid episode via Bearer too', async () => {
    vi.mocked(recordEpisode).mockClear();
    const res = await request(app)
      .post('/api/internal/selflearn/outcome')
      .set('authorization', `Bearer ${SECRET}`)
      .send(episode);
    expect(res.status).toBe(200);
    expect(recordEpisode).toHaveBeenCalledOnce();
  });

  it('rejects a body without kind / outcome (400) without calling the service', async () => {
    vi.mocked(recordEpisode).mockClear();
    const noKind = await request(app).post('/api/internal/selflearn/outcome').set('x-internal-secret', SECRET).send({ ...episode, kind: undefined });
    expect(noKind.status).toBe(400);
    const noOutcome = await request(app).post('/api/internal/selflearn/outcome').set('x-internal-secret', SECRET).send({ ...episode, outcome: undefined });
    expect(noOutcome.status).toBe(400);
    expect(recordEpisode).not.toHaveBeenCalled();
  });

  it('maps recordEpisode refusal to 400', async () => {
    vi.mocked(recordEpisode).mockReturnValueOnce({ wrote: false, error: 'episode requires kind and outcome' });
    const res = await request(app).post('/api/internal/selflearn/outcome').set('x-internal-secret', SECRET).send(episode);
    expect(res.status).toBe(400);
  });

  it('serves the skill fold behind the same secret', async () => {
    const res = await request(app).get('/api/internal/selflearn/skills').set('x-internal-secret', SECRET);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.skills?.[0]?.name).toBe('sieve-rule-calibration');
    expect(skillStats).toHaveBeenCalled();
  });

  it('skill readback is also guarded (unauthenticated read -> 401/503)', async () => {
    const resNoSecret = await request(app).get('/api/internal/selflearn/skills');
    expect([401, 503]).toContain(resNoSecret.status);
  });
});
