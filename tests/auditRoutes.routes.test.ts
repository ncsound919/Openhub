import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../src/services/auditSuite', () => ({ executeAuditSuite: vi.fn() }));
vi.mock('../src/services/projectContext', () => ({ getActiveProject: vi.fn() }));
vi.mock('../src/services/projectStatus', () => ({ saveProjectStatus: vi.fn() }));
vi.mock('../src/services/agentRegistry', () => ({ getAgentRoster: vi.fn() }));
vi.mock('../src/services/agentReadouts', () => ({
  getAgentReadouts: vi.fn(),
  buildWorkOrder: vi.fn(),
  getOssReviewReadouts: vi.fn(),
}));

import { closeDb, getDb, initializeDatabase } from '../src/auth/db';
import { executeAuditSuite } from '../src/services/auditSuite';
import { getActiveProject } from '../src/services/projectContext';
import { saveProjectStatus } from '../src/services/projectStatus';
import { getAgentRoster } from '../src/services/agentRegistry';
import { getAgentReadouts, buildWorkOrder, getOssReviewReadouts } from '../src/services/agentReadouts';
import { createAuditRouter } from '../src/routes/auditRoutes';

const USER = 'audit-routes-user';

const passReport = {
  id: 'audit_pass',
  timestamp: '2026-01-01T00:00:00.000Z',
  target: '/proj',
  results: [
    { scorer: 'reporank', score: 90, summary: 'great' },
    { scorer: 'deep', score: null, summary: 'unavailable', error: 'deep down' },
  ],
  overallStatus: 'pass' as const,
};

let tmp: string;
let previousDbPath: string | undefined;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-routes-'));
  previousDbPath = process.env.OPENHUB_DB_PATH;
  process.env.OPENHUB_DB_PATH = path.join(tmp, 'test.db');
  closeDb();
  initializeDatabase();
});

afterAll(() => {
  closeDb();
  if (previousDbPath === undefined) delete process.env.OPENHUB_DB_PATH;
  else process.env.OPENHUB_DB_PATH = previousDbPath;
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.clearAllMocks();
  try { getDb().exec('DROP TABLE IF EXISTS audit_reports'); } catch { /* noop */ }

  vi.mocked(executeAuditSuite).mockResolvedValue(passReport as any);
  vi.mocked(getActiveProject).mockReturnValue({
    repoId: 'r1', path: '/proj', repositoryName: 'repo', githubFullName: 'owner/repo',
    defaultBranch: 'main', selectedAt: '2026-01-01T00:00:00.000Z',
  } as any);
  vi.mocked(saveProjectStatus).mockReturnValue(null);
  vi.mocked(getAgentRoster).mockReturnValue({
    audit: [{ slug: 'deep', name: 'The Deep', present: true, path: '/agents/deep', description: 'deep agent' }],
    research: [],
  } as any);
  vi.mocked(getAgentReadouts).mockReturnValue([]);
  vi.mocked(getOssReviewReadouts).mockResolvedValue([]);
  vi.mocked(buildWorkOrder).mockReturnValue({ items: [], total: 0 });
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
  app.use('/api', createAuditRouter({ authMiddleware: (_req, _res, next) => next() }));
  return app;
}

describe('auditRoutes — POST /audit/run', () => {
  it('401s without a user and 409s without an active project', async () => {
    expect((await request(makeApp(null)).post('/api/audit/run').send({})).status).toBe(401);

    vi.mocked(getActiveProject).mockReturnValueOnce(null);
    const noProject = await request(makeApp()).post('/api/audit/run').send({});
    expect(noProject.status).toBe(409);
    expect(noProject.body.code).toBe('NO_ACTIVE_PROJECT');
  });

  it('runs the suite, persists the report, and exposes it via history', async () => {
    const res = await request(makeApp()).post('/api/audit/run').send({ scorers: ['reporank'] });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.report.id).toBe('audit_pass');
    expect(res.body.project.repoId).toBe('r1');
    expect(vi.mocked(executeAuditSuite)).toHaveBeenCalledWith(
      expect.objectContaining({ targetDir: '/proj', repoUrl: 'https://github.com/owner/repo' }),
    );

    const history = await request(makeApp()).get('/api/audit/history');
    expect(history.status).toBe(200);
    expect(history.body.history).toHaveLength(1);
    expect(history.body.history[0].id).toBe('audit_pass');

    const single = await request(makeApp()).get('/api/audit/audit_pass');
    expect(single.status).toBe(200);
    expect(single.body.report.id).toBe('audit_pass');
  });

  it('omits repoUrl when the project has no GitHub full name', async () => {
    vi.mocked(getActiveProject).mockReturnValueOnce({
      repoId: 'r1', path: '/proj', repositoryName: 'repo', githubFullName: null,
      defaultBranch: 'main', selectedAt: '2026-01-01T00:00:00.000Z',
    } as any);
    await request(makeApp()).post('/api/audit/run').send({});
    const params = vi.mocked(executeAuditSuite).mock.calls[0][0];
    expect(params.repoUrl).toBeUndefined();
  });

  it('500s when the suite itself throws', async () => {
    vi.mocked(executeAuditSuite).mockRejectedValueOnce(new Error('suite exploded'));
    const res = await request(makeApp()).post('/api/audit/run').send({});
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('suite exploded');
  });

  it('still returns the audit when persistence fails', async () => {
    getDb().exec(`
      CREATE TABLE audit_reports (
        id TEXT PRIMARY KEY, target TEXT NOT NULL, created_at TEXT NOT NULL,
        overall_status TEXT NOT NULL, report_json TEXT NOT NULL,
        CHECK (overall_status = 'never')
      );
    `);
    const res = await request(makeApp()).post('/api/audit/run').send({});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('tolerates a failing project-status write', async () => {
    vi.mocked(saveProjectStatus).mockImplementationOnce(() => {
      throw new Error('status write failed');
    });
    const res = await request(makeApp()).post('/api/audit/run').send({});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe('auditRoutes — GET /audit/history + /audit/:id', () => {
  it('skips corrupt report rows and 404s unknown ids', async () => {
    getDb().exec(`
      CREATE TABLE audit_reports (
        id TEXT PRIMARY KEY, target TEXT NOT NULL, created_at TEXT NOT NULL,
        overall_status TEXT NOT NULL, report_json TEXT NOT NULL
      );
    `);
    const ins = getDb().prepare(
      'INSERT INTO audit_reports (id, target, created_at, overall_status, report_json) VALUES (?, ?, ?, ?, ?)',
    );
    ins.run('good', '/proj', '2026-01-02T00:00:00.000Z', 'pass', JSON.stringify(passReport));
    ins.run('bad', '/proj', '2026-01-03T00:00:00.000Z', 'pass', '{ not json');

    const history = await request(makeApp()).get('/api/audit/history');
    expect(history.status).toBe(200);
    expect(history.body.history).toHaveLength(1);
    expect(history.body.history[0].id).toBe('audit_pass');

    expect((await request(makeApp()).get('/api/audit/does-not-exist')).status).toBe(404);
  });

  it('500s on a malformed audit table', async () => {
    getDb().exec('CREATE TABLE audit_reports (id TEXT PRIMARY KEY)');
    expect((await request(makeApp()).get('/api/audit/history')).status).toBe(500);
    expect((await request(makeApp()).get('/api/audit/anything')).status).toBe(500);
  });
});

describe('auditRoutes — GET /audit/tools', () => {
  it('lists scorers, agent backends, and per-scorer stats', async () => {
    getDb().exec(`
      CREATE TABLE audit_reports (
        id TEXT PRIMARY KEY, target TEXT NOT NULL, created_at TEXT NOT NULL,
        overall_status TEXT NOT NULL, report_json TEXT NOT NULL
      );
    `);
    getDb().prepare(
      'INSERT INTO audit_reports (id, target, created_at, overall_status, report_json) VALUES (?, ?, ?, ?, ?)',
    ).run('audit_pass', '/proj', '2026-01-02T00:00:00.000Z', 'pass', JSON.stringify(passReport));

    const res = await request(makeApp()).get('/api/audit/tools');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.total).toBe(1);
    const tools = res.body.tools as Array<{ name: string; kind: string; stats: any }>;
    const names = tools.map((t) => t.name);
    for (const expected of ['reporank', 'grader', 'claw-protect', 'codegraph', 'ocr', 'deep', 'codegang', 'codenexus', 'local_qa']) {
      expect(names).toContain(expected);
    }
    const reporank = tools.find((t) => t.name === 'reporank');
    expect(reporank?.stats.runs).toBe(1);
    expect(reporank?.stats.avgScore).toBe(90);
    expect(reporank?.stats.lastScore).toBe(90);

    const deepScorer = tools.filter((t) => t.name === 'deep').find((t) => t.kind === 'scorer');
    expect(deepScorer?.stats.fails).toBe(1);
    expect(deepScorer?.stats.lastScore).toBeNull();

    const backend = tools.find((t) => t.kind === 'agent');
    expect(backend?.name).toBe('deep');
  });
});

describe('auditRoutes — GET /audit/readouts', () => {
  it('401s and 409s before work begins', async () => {
    expect((await request(makeApp(null)).get('/api/audit/readouts')).status).toBe(401);
    vi.mocked(getActiveProject).mockReturnValueOnce(null);
    expect((await request(makeApp()).get('/api/audit/readouts')).status).toBe(409);
  });

  it('merges agent + oss readouts into a work order summary', async () => {
    vi.mocked(getAgentReadouts).mockReturnValue([
      { tool: 'the-deep', available: true, findings: [{ ruleId: 'x', file: 'a.ts' }] },
    ] as any);
    vi.mocked(getOssReviewReadouts).mockResolvedValue([
      { tool: 'codegraph', available: false, findings: [] },
    ] as any);
    vi.mocked(buildWorkOrder).mockReturnValue({
      items: [{ file: 'a.ts', ruleId: 'x', title: 't', category: 'c', suggestion: 's', severity: 'high', tool: 'the-deep' }],
      total: 1,
    });

    const res = await request(makeApp()).get('/api/audit/readouts');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.project).toBe('repo');
    expect(res.body.readouts).toHaveLength(2);
    expect(res.body.summary).toMatchObject({ tools: 2, toolsWithReadouts: 1, totalFindings: 1, workOrderItems: 1 });
  });

  it('500s when a readout source throws', async () => {
    vi.mocked(getAgentReadouts).mockImplementationOnce(() => {
      throw new Error('readouts down');
    });
    const res = await request(makeApp()).get('/api/audit/readouts');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('readouts down');
  });
});
