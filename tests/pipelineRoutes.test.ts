import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { AuditReport } from '../src/services/auditSuite.js';

// The route resolves the active project from the DB; stub it so the test does
// not depend on a seeded project row.
vi.mock('../src/services/projectContext.js', () => ({
  getActiveProject: () => ({
    repoId: 'r1',
    path: '/tmp/proj',
    repositoryName: 'Proj',
    selectedAt: new Date().toISOString(),
    githubFullName: null,
    defaultBranch: 'main',
  }),
}));

import { createPipelineRouter } from '../src/routes/pipelineRoutes.js';

function passReport(): AuditReport {
  return {
    id: 'r', timestamp: new Date().toISOString(), target: '/tmp/proj', results: [],
    overallStatus: 'pass', overallScore: 92, overallScoreDeterministic: 92, grade: 'A',
    reconciliation: {} as never, dimensions: [], coverage: {} as never, coveragePercent: 0,
    findings: [], dedup: {} as never, criticalFindings: 0,
  } as unknown as AuditReport;
}

const pipelineDeps = {
  typecheck: async () => ({ available: true, errors: [] }),
  audit: async () => passReport(),
  repair: async () => ({ ok: true }),
  startLoop: async () => ({ id: 'L1' }),
  loopStatus: async () => ({ status: 'done' }),
  stopLoop: async () => ({}),
  sleep: async () => {},
  pollIntervalMs: 0,
  maxLoopMs: 500,
};

function makeApp(user: { sub: string } | null) {
  const app = express();
  app.use(express.json());
  app.use('/api', createPipelineRouter({
    authMiddleware: (req, _res, next) => { (req as unknown as { user?: unknown }).user = user ?? undefined; next(); },
    pipelineDeps,
  }));
  return app;
}

async function waitTerminal(app: express.Express, id: string) {
  for (let i = 0; i < 100; i++) {
    const res = await request(app).get(`/api/pipeline/${id}`);
    if (res.body?.job?.status !== 'running') return res.body.job;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error('pipeline did not finish');
}

describe('pipeline routes', () => {
  it('401s without an authenticated user', async () => {
    const res = await request(makeApp(null)).post('/api/pipeline/run').send({ mode: 'audit' });
    expect(res.status).toBe(401);
  });

  it('starts a job and reports progress; list + get reflect it', async () => {
    const app = makeApp({ sub: 'u1' });
    const started = await request(app).post('/api/pipeline/run').send({ mode: 'audit' });
    expect(started.status).toBe(200);
    expect(started.body.ok).toBe(true);
    expect(typeof started.body.job.id).toBe('string');
    expect(Array.isArray(started.body.job.stages)).toBe(true);
    expect(started.body.job.stages.map((s: { id: string }) => s.id)).toEqual(['audit', 'repair']);

    const done = await waitTerminal(app, started.body.job.id);
    expect(done.status).toBe('complete');
    expect(done.progress).toBe(1);

    const list = await request(app).get('/api/pipeline');
    expect(list.status).toBe(200);
    expect(list.body.jobs.some((j: { id: string }) => j.id === started.body.job.id)).toBe(true);
  });

  it('404s for an unknown job and cannot cancel a finished one', async () => {
    const app = makeApp({ sub: 'u1' });
    expect((await request(app).get('/api/pipeline/nope')).status).toBe(404);
    const started = await request(app).post('/api/pipeline/run').send({ mode: 'audit' });
    await waitTerminal(app, started.body.job.id);
    const cancel = await request(app).post(`/api/pipeline/${started.body.job.id}/cancel`);
    expect(cancel.body.ok).toBe(false);
  });
});
