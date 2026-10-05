import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../src/services/projectContext', () => ({ getActiveProject: vi.fn() }));
vi.mock('../src/services/projectGit', () => ({ readProjectDrift: vi.fn() }));
vi.mock('../src/services/supervisor', () => ({ listRuns: vi.fn() }));
vi.mock('../src/services/incidentBus', () => ({ listIncidents: vi.fn(), dispatchState: vi.fn() }));
vi.mock('../src/services/ecosystemKnowledge', () => ({ sourceCounts: vi.fn() }));
vi.mock('../src/services/recourseClient', () => ({
  recourseSummary: vi.fn(),
  recourseRegistry: vi.fn(),
  recourseAgendaNext: vi.fn(),
  normalizeRegistryTools: vi.fn(),
}));

import { closeDb, getDb, initializeDatabase } from '../src/auth/db';
import { getActiveProject } from '../src/services/projectContext';
import { readProjectDrift } from '../src/services/projectGit';
import { listRuns } from '../src/services/supervisor';
import { listIncidents, dispatchState } from '../src/services/incidentBus';
import { sourceCounts } from '../src/services/ecosystemKnowledge';
import {
  recourseSummary,
  recourseRegistry,
  recourseAgendaNext,
  normalizeRegistryTools,
} from '../src/services/recourseClient';
import { createSystemSnapshotRouter } from '../src/routes/systemSnapshot';

const USER = 'snapshot-user';

let tmp: string;
let previousDbPath: string | undefined;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'system-snapshot-routes-'));
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

function createAuditTable() {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS audit_reports (
      id TEXT PRIMARY KEY, target TEXT NOT NULL, created_at TEXT NOT NULL,
      overall_status TEXT NOT NULL, report_json TEXT NOT NULL
    );
  `);
}

function createResearchTable() {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS research_queries (
      id TEXT PRIMARY KEY, query TEXT NOT NULL, result_json TEXT NOT NULL, created_at TEXT NOT NULL
    );
  `);
}

beforeEach(() => {
  vi.clearAllMocks();
  try { getDb().exec('DROP TABLE IF EXISTS audit_reports'); } catch { /* noop */ }
  try { getDb().exec('DROP TABLE IF EXISTS research_queries'); } catch { /* noop */ }

  vi.mocked(getActiveProject).mockReturnValue(null);
  vi.mocked(readProjectDrift).mockResolvedValue({ available: true } as any);
  vi.mocked(listRuns).mockReturnValue([]);
  vi.mocked(listIncidents).mockReturnValue([]);
  vi.mocked(dispatchState).mockReturnValue({ inFlight: false, queued: 0 });
  vi.mocked(sourceCounts).mockReturnValue([]);
  vi.mocked(recourseSummary).mockResolvedValue('recourse online');
  vi.mocked(recourseRegistry).mockResolvedValue({ available: true, data: { registry: [] } });
  vi.mocked(recourseAgendaNext).mockResolvedValue({ available: true, data: { next: { title: 'Ship it' } } });
  vi.mocked(normalizeRegistryTools).mockReturnValue([
    { name: 'bloom', domain: 'memory', selfHosted: true, health: 'healthy' },
    { name: 'kv', domain: 'storage', selfHosted: false, health: 'degraded' },
  ]);
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
  app.use('/api', createSystemSnapshotRouter({ authMiddleware: (_req, _res, next) => next() }));
  return app;
}

function section(body: any, key: string): any {
  return body.snapshot[key];
}

describe('systemSnapshot — degraded node', () => {
  it('returns a 200 envelope with independently-degraded sections', async () => {
    const res = await request(makeApp(null)).get('/api/system/snapshot');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.snapshot.generatedAt).toBe('string');

    expect(section(res.body, 'project').ok).toBe(false);
    expect(section(res.body, 'drift').ok).toBe(false);
    expect(section(res.body, 'audit').ok).toBe(false);
    expect(section(res.body, 'research').ok).toBe(false);
    expect(section(res.body, 'ecosystem').ok).toBe(false);
  });

  it('treats an authenticated user with no active project the same way', async () => {
    const res = await request(makeApp()).get('/api/system/snapshot');
    expect(res.status).toBe(200);
    expect(section(res.body, 'project').ok).toBe(false);
    expect(section(res.body, 'drift').ok).toBe(false);
  });
});

describe('systemSnapshot — project + drift', () => {
  it('reports the active project and its drift', async () => {
    vi.mocked(getActiveProject).mockReturnValue({ repoId: 'r1', path: tmp, repositoryName: 'repo' } as any);
    const res = await request(makeApp()).get('/api/system/snapshot');
    expect(section(res.body, 'project').ok).toBe(true);
    expect(section(res.body, 'drift').ok).toBe(true);
  });

  it('degrades drift when the drift read fails', async () => {
    vi.mocked(getActiveProject).mockReturnValue({ repoId: 'r1', path: tmp, repositoryName: 'repo' } as any);
    vi.mocked(readProjectDrift).mockRejectedValueOnce(new Error('drift down'));
    const res = await request(makeApp()).get('/api/system/snapshot');
    expect(section(res.body, 'drift').ok).toBe(false);
    expect(section(res.body, 'drift').error).toBe('drift down');
  });

  it('degrades the whole project block when lookup throws', async () => {
    vi.mocked(getActiveProject).mockImplementationOnce(() => {
      throw new Error('db blew up');
    });
    const res = await request(makeApp()).get('/api/system/snapshot');
    expect(section(res.body, 'project').ok).toBe(false);
    expect(section(res.body, 'drift').error).toBe('project unavailable');
  });
});

describe('systemSnapshot — persisted history', () => {
  it('reads the latest audit verdict and research log', async () => {
    createAuditTable();
    createResearchTable();
    getDb().prepare(
      'INSERT INTO audit_reports (id, target, created_at, overall_status, report_json) VALUES (?, ?, ?, ?, ?)',
    ).run('audit_1', '/proj', '2026-01-02T00:00:00.000Z', 'pass', '{}');
    getDb().prepare(
      'INSERT INTO research_queries (id, query, result_json, created_at) VALUES (?, ?, ?, ?)',
    ).run('rq1', 'how', '{}', '2026-01-02T00:00:00.000Z');

    const res = await request(makeApp()).get('/api/system/snapshot');
    expect(section(res.body, 'audit')).toMatchObject({ ok: true, verdict: 'pass', reportId: 'audit_1' });
    expect(section(res.body, 'research').ok).toBe(true);
    expect(section(res.body, 'research').total).toBe(1);
  });
});

describe('systemSnapshot — runs + incidents', () => {
  it('aggregates active supervision runs and incident severities', async () => {
    vi.mocked(listRuns).mockReturnValue([
      { id: 'run1', status: 'looping' },
      { id: 'run2', status: 'complete' },
    ] as any);
    vi.mocked(listIncidents).mockReturnValue([
      { severity: 'high' },
      { severity: 'high' },
      { severity: 'low' },
    ] as any);
    vi.mocked(dispatchState).mockReturnValue({ inFlight: true, queued: 2 });

    const res = await request(makeApp()).get('/api/system/snapshot');
    expect(section(res.body, 'runs')).toMatchObject({ ok: true, total: 2, active: 1 });
    expect(section(res.body, 'runs').latest.id).toBe('run1');
    expect(section(res.body, 'incidents').ok).toBe(true);
    expect(section(res.body, 'incidents').bySeverity).toEqual({ high: 2, low: 1 });
    expect(section(res.body, 'incidents').dispatch.inFlight).toBe(true);
  });

  it('degrades runs and incidents when their sources throw', async () => {
    vi.mocked(listRuns).mockImplementation(() => {
      throw new Error('runs down');
    });
    vi.mocked(listIncidents).mockImplementation(() => {
      throw new Error('incidents down');
    });
    const res = await request(makeApp()).get('/api/system/snapshot');
    expect(section(res.body, 'runs').ok).toBe(false);
    expect(section(res.body, 'incidents').ok).toBe(false);
  });
});

describe('systemSnapshot — ecosystem', () => {
  it('sums ecosystem source entries', async () => {
    vi.mocked(sourceCounts).mockReturnValue([
      { root: '/a', label: 'a', entries: 3 },
      { root: '/b', label: 'b', entries: 2 },
    ]);
    const res = await request(makeApp()).get('/api/system/snapshot');
    expect(section(res.body, 'ecosystem')).toMatchObject({ ok: true, entries: 5 });
  });

  it('degrades ecosystem when counting throws', async () => {
    vi.mocked(sourceCounts).mockImplementation(() => {
      throw new Error('index down');
    });
    const res = await request(makeApp()).get('/api/system/snapshot');
    expect(section(res.body, 'ecosystem').ok).toBe(false);
    expect(section(res.body, 'ecosystem').error).toBe('index down');
  });
});

describe('systemSnapshot — recourse', () => {
  it('flattens an available registry and agenda', async () => {
    const res = await request(makeApp()).get('/api/system/snapshot');
    const recourse = section(res.body, 'recourse');
    expect(recourse.ok).toBe(true);
    expect(recourse.summary).toBe('recourse online');
    expect(recourse.registry).toMatchObject({ count: 2, domains: 2, selfHosted: 1, healthy: 1 });
    expect(recourse.agenda.next).toBe('Ship it');
  });

  it('reports unavailable registry + agenda without failing the whole call', async () => {
    vi.mocked(recourseRegistry).mockResolvedValue({ available: false, error: 'registry down' });
    vi.mocked(recourseAgendaNext).mockResolvedValue({ available: false, error: 'agenda down' });
    const res = await request(makeApp()).get('/api/system/snapshot');
    const recourse = section(res.body, 'recourse');
    expect(recourse.ok).toBe(true);
    expect(recourse.registry).toMatchObject({ available: false, error: 'registry down' });
    expect(recourse.agenda).toMatchObject({ available: false, error: 'agenda down' });
  });

  it('resolves agenda labels from goal, summary, or nothing', async () => {
    vi.mocked(recourseAgendaNext).mockResolvedValue({ available: true, data: { next: { goal: 'Goal text' } } });
    const byGoal = await request(makeApp()).get('/api/system/snapshot');
    expect(section(byGoal.body, 'recourse').agenda.next).toBe('Goal text');

    vi.mocked(recourseAgendaNext).mockResolvedValue({ available: true, data: { next: { summary: 'Summary text' } } });
    const bySummary = await request(makeApp()).get('/api/system/snapshot');
    expect(section(bySummary.body, 'recourse').agenda.next).toBe('Summary text');

    vi.mocked(recourseAgendaNext).mockResolvedValue({ available: true, data: { next: { unrelated: true } } });
    const none = await request(makeApp()).get('/api/system/snapshot');
    expect(section(none.body, 'recourse').agenda.next).toBeNull();
  });

  it('degrades recourse when the summary call throws', async () => {
    vi.mocked(recourseSummary).mockRejectedValueOnce(new Error('offline'));
    const res = await request(makeApp()).get('/api/system/snapshot');
    expect(section(res.body, 'recourse').ok).toBe(false);
    expect(section(res.body, 'recourse').error).toBe('offline');
  });
});
