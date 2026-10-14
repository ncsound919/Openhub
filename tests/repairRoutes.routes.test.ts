import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../src/services/repairClient', () => ({
  readRepairLogs: vi.fn(),
  triggerRepairTriage: vi.fn(),
}));
vi.mock('../src/services/auditSuite', () => ({ executeAuditSuite: vi.fn() }));
vi.mock('../src/services/projectContext', () => ({ getActiveProject: vi.fn() }));

import { readRepairLogs, triggerRepairTriage } from '../src/services/repairClient';
import { executeAuditSuite } from '../src/services/auditSuite';
import { getActiveProject } from '../src/services/projectContext';
import { createRepairRouter } from '../src/routes/repairRoutes';

const USER = 'repair-user';

const passAudit = {
  id: 'audit_1',
  timestamp: '2026-01-01T00:00:00.000Z',
  target: '/proj',
  results: [{ scorer: 'reporank', score: 90, summary: 'clean' }],
  overallStatus: 'pass' as const,
};

const failAudit = {
  id: 'audit_2',
  timestamp: '2026-01-01T00:00:00.000Z',
  target: '/proj',
  results: [{ scorer: 'grader', score: null, summary: 'broken', error: 'missing dep' }],
  overallStatus: 'fail' as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(executeAuditSuite).mockResolvedValue(passAudit as any);
  vi.mocked(triggerRepairTriage).mockResolvedValue({ ok: true });
  vi.mocked(readRepairLogs).mockReturnValue({ repairLog: [], teamLog: [] });
  vi.mocked(getActiveProject).mockReturnValue({
    repoId: 'r1', path: '/proj', repositoryName: 'repo', githubFullName: 'owner/repo',
    defaultBranch: 'main', selectedAt: '2026-01-01T00:00:00.000Z',
  } as any);
});

function makeApp(userId: string | null = USER) {
  const app = express();
  app.use(express.json());
  if (userId) {
    app.use((req, _res, next) => {
      (req as { user?: unknown }).user = { sub: userId };
      next();
    });
  }
  app.use('/api', createRepairRouter({ authMiddleware: (_req, _res, next) => next() }));
  return app;
}

describe('repairRoutes — POST /repair/audit-and-repair', () => {
  it('401s without a user and 409s without an active project', async () => {
    expect((await request(makeApp(null)).post('/api/repair/audit-and-repair').send({})).status).toBe(401);

    vi.mocked(getActiveProject).mockReturnValueOnce(null);
    const res = await request(makeApp()).post('/api/repair/audit-and-repair').send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NO_ACTIVE_PROJECT');
  });

  it('skips repair when the audit passes', async () => {
    const res = await request(makeApp()).post('/api/repair/audit-and-repair').send({});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.repair).toBeNull();
    expect(res.body.message).toContain('Audit passed');
    expect(vi.mocked(triggerRepairTriage)).not.toHaveBeenCalled();
  });

  it('dispatches repair when the audit fails, carrying the repo URL', async () => {
    vi.mocked(executeAuditSuite).mockResolvedValue(failAudit as any);
    const res = await request(makeApp()).post('/api/repair/audit-and-repair').send({});
    expect(res.status).toBe(200);
    expect(res.body.repair).toEqual({ ok: true });
    expect(res.body.message).toContain('repair dispatched');
    expect(vi.mocked(triggerRepairTriage)).toHaveBeenCalledWith(
      expect.objectContaining({ signal: 'openhub:audit-failed', repoUrl: 'https://github.com/owner/repo', kind: 'job' }),
    );
  });

  it('reports a failed dispatch honestly and omits repoUrl without GitHub metadata', async () => {
    vi.mocked(executeAuditSuite).mockResolvedValue(failAudit as any);
    vi.mocked(triggerRepairTriage).mockResolvedValueOnce({ ok: false, error: 'draymond down' });
    vi.mocked(getActiveProject).mockReturnValueOnce({
      repoId: 'r1', path: '/proj', repositoryName: 'repo', githubFullName: null,
      defaultBranch: 'main', selectedAt: '',
    } as any);

    const res = await request(makeApp()).post('/api/repair/audit-and-repair').send({});
    expect(res.status).toBe(200);
    expect(res.body.repair).toEqual({ ok: false, error: 'draymond down' });
    expect(res.body.message).toContain('repair dispatch failed');
    expect(vi.mocked(triggerRepairTriage).mock.calls[0][0].repoUrl).toBeUndefined();
  });

  it('500s when the audit throws', async () => {
    vi.mocked(executeAuditSuite).mockRejectedValueOnce(new Error('audit exploded'));
    const res = await request(makeApp()).post('/api/repair/audit-and-repair').send({});
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('audit exploded');
  });
});

describe('repairRoutes — GET /repair/logs', () => {
  it('returns logs and 500s when the reader throws', async () => {
    vi.mocked(readRepairLogs).mockReturnValueOnce({ repairLog: [{ signal: 'x' }], teamLog: [] } as any);
    const ok = await request(makeApp()).get('/api/repair/logs');
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ ok: true, logs: { repairLog: [{ signal: 'x' }], teamLog: [] } });

    vi.mocked(readRepairLogs).mockImplementationOnce(() => {
      throw new Error('logs unavailable');
    });
    expect((await request(makeApp()).get('/api/repair/logs')).status).toBe(500);
  });
});

describe('repairRoutes — POST /repair/trigger', () => {
  it('401s and 409s before validation', async () => {
    expect((await request(makeApp(null)).post('/api/repair/trigger').send({ signal: 'x' })).status).toBe(401);
    vi.mocked(getActiveProject).mockReturnValueOnce(null);
    expect((await request(makeApp()).post('/api/repair/trigger').send({ signal: 'x' })).status).toBe(409);
  });

  it('400s when the signal is missing', async () => {
    const res = await request(makeApp()).post('/api/repair/trigger').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('signal is required');
  });

  it('dispatches with the signal and defaults the detail', async () => {
    const explicit = await request(makeApp()).post('/api/repair/trigger').send({ signal: ' build ', detail: ' broke ', kind: 'monitor' });
    expect(explicit.status).toBe(200);
    expect(explicit.body.outcome).toEqual({ ok: true });
    expect(vi.mocked(triggerRepairTriage)).toHaveBeenCalledWith(
      expect.objectContaining({ signal: 'build', detail: 'broke', kind: 'monitor' }),
    );

    vi.mocked(triggerRepairTriage).mockClear();
    await request(makeApp()).post('/api/repair/trigger').send({ signal: 'signal-only' });
    expect(vi.mocked(triggerRepairTriage)).toHaveBeenCalledWith(
      expect.objectContaining({ signal: 'signal-only', detail: 'signal-only' }),
    );
  });

  it('500s when the dispatch throws', async () => {
    vi.mocked(triggerRepairTriage).mockRejectedValueOnce(new Error('boom'));
    expect((await request(makeApp()).post('/api/repair/trigger').send({ signal: 'x' })).status).toBe(500);
  });
});
