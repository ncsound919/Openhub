import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDb, initializeDatabase } from '../src/auth/db';

vi.mock('../src/services/axiomClient', () => ({
  startAxiomProjectLoop: vi.fn(),
  getAxiomProjectStatus: vi.fn(),
}));
vi.mock('../src/services/auditSuite', () => ({ executeAuditSuite: vi.fn() }));
vi.mock('../src/services/repairClient', () => ({ triggerRepairTriage: vi.fn() }));
vi.mock('../src/services/fleetCatalog', () => ({ loadFleetCatalog: vi.fn() }));
vi.mock('../src/services/ecosystemKnowledge', () => ({ searchKnowledge: vi.fn() }));
vi.mock('../src/services/recourseClient', () => ({
  recourseMemoryRecall: vi.fn(),
  recourseMemoryIndex: vi.fn(),
}));
vi.mock('../src/services/projectStatus', () => ({ saveProjectStatus: vi.fn() }));
vi.mock('../src/services/agentReadouts', () => ({
  getAgentReadouts: vi.fn(),
  buildWorkOrder: vi.fn(),
}));
vi.mock('../src/services/incidentBus', () => ({ reportIncident: vi.fn() }));
vi.mock('../src/services/telemetry', () => ({ recordEvent: vi.fn() }));
vi.mock('../src/services/selfLearning', () => ({
  advise: vi.fn(),
  recordEpisode: vi.fn(),
}));

import { startAxiomProjectLoop, getAxiomProjectStatus } from '../src/services/axiomClient';
import { executeAuditSuite } from '../src/services/auditSuite';
import { triggerRepairTriage } from '../src/services/repairClient';
import { loadFleetCatalog } from '../src/services/fleetCatalog';
import { searchKnowledge } from '../src/services/ecosystemKnowledge';
import { recourseMemoryRecall, recourseMemoryIndex } from '../src/services/recourseClient';
import { saveProjectStatus } from '../src/services/projectStatus';
import { getAgentReadouts, buildWorkOrder } from '../src/services/agentReadouts';
import { reportIncident } from '../src/services/incidentBus';
import { recordEvent } from '../src/services/telemetry';
import { advise, recordEpisode } from '../src/services/selfLearning';

import {
  startSupervision,
  listRuns,
  getRun,
  stopSupervision,
  resumeSupervision,
  bestSkillsFor,
} from '../src/services/supervisor';

const passAudit = { overallStatus: 'pass', results: [{ scorer: 'reporank', score: 88, summary: 'looks good', error: null }] };
const failAudit = { overallStatus: 'fail', results: [{ scorer: 'grader', score: null, summary: 'broken', error: 'missing dep' }] };

function insertRun(id: string, status: string, loopId: string | null = null): void {
  getDb().prepare(`
    INSERT INTO supervision_runs (id, goal, target_dir, loop_id, status, iteration, max_iterations, skills, audit_json, error, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 0, 8, '[]', NULL, NULL, ?, ?)
  `).run(id, 'goal', 'target', loopId, status, new Date().toISOString(), new Date().toISOString());
}

describe('supervisor', () => {
  let tmp: string;
  let previousDbPath: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-'));
    previousDbPath = process.env.OPENHUB_DB_PATH;
    process.env.OPENHUB_DB_PATH = path.join(tmp, 'test.db');
    closeDb();
    initializeDatabase();

    vi.clearAllMocks();
    vi.mocked(advise).mockReturnValue({ skills: [], lessons: [] });
    vi.mocked(loadFleetCatalog).mockReturnValue({ path: null, source: 'degraded', totals: {}, assets: [] } as never);
    vi.mocked(searchKnowledge).mockReturnValue({ live: false, root: null, entries: [], totals: {}, refreshedAt: '' } as never);
    vi.mocked(recourseMemoryRecall).mockResolvedValue({ available: false });
    vi.mocked(recourseMemoryIndex).mockResolvedValue({ available: false });
    vi.mocked(executeAuditSuite).mockResolvedValue(passAudit as never);
    vi.mocked(triggerRepairTriage).mockResolvedValue({ ok: true });
    vi.mocked(getAgentReadouts).mockReturnValue([]);
    vi.mocked(buildWorkOrder).mockReturnValue({ items: [], total: 0 });
    vi.mocked(reportIncident).mockResolvedValue({ incident: {} as never, dispatchQueued: false });
    vi.mocked(recordEvent).mockReturnValue({ wrote: true });
    vi.mocked(recordEpisode).mockReturnValue({ wrote: true });
  });

  afterEach(() => {
    closeDb();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    if (previousDbPath === undefined) delete process.env.OPENHUB_DB_PATH;
    else process.env.OPENHUB_DB_PATH = previousDbPath;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  describe('startSupervision', () => {
    it('records a failed run when Axiom returns no loop id', async () => {
      vi.mocked(startAxiomProjectLoop).mockResolvedValue({});
      const run = await startSupervision({ goal: 'Fix the bug', targetDir: path.join(tmp, 'proj') });

      expect(run.status).toBe('failed');
      expect(run.error).toContain('no loop id');
      expect(run.loopId).toBeNull();
      expect(getRun(run.id)).toMatchObject({ status: 'failed' });
      expect(listRuns(10)[0].id).toBe(run.id);
      expect(recordEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: 'run-start', outcome: 'error' }));
    });

    it('records a failed run when the Axiom dispatch throws', async () => {
      vi.mocked(startAxiomProjectLoop).mockRejectedValue(new Error('axiom down'));
      const run = await startSupervision({ goal: 'g', targetDir: path.join(tmp, 'proj') });
      expect(run.status).toBe('failed');
      expect(run.error).toBe('axiom down');
    });

    it('dedupes and caps the selected skills', async () => {
      vi.mocked(startAxiomProjectLoop).mockResolvedValue({});
      vi.mocked(advise).mockReturnValue({
        skills: [{ name: 'Alpha', kind: 'learned', reason: 'a' }, { name: 'alpha', kind: 'learned', reason: 'dup' }],
        lessons: [],
      });
      vi.mocked(loadFleetCatalog).mockReturnValue({
        path: 'p', source: 'live', totals: {},
        assets: [{ kind: 'tool', name: 'Alpha', description: 'alpha tool', path: 'p' }],
      } as never);

      const run = await startSupervision({ goal: 'do alpha', targetDir: path.join(tmp, 'proj') });
      expect(run.skills.filter((s) => s.name.toLowerCase() === 'alpha')).toHaveLength(1);
    });

    it('completes a run when the audit passes', async () => {
      const dir = path.join(tmp, 'proj');
      vi.mocked(startAxiomProjectLoop).mockResolvedValue({ id: 'loop-pass' });
      vi.mocked(getAxiomProjectStatus).mockResolvedValue({ status: 'complete', iteration: 2 });

      const run = await startSupervision({ goal: 'ship it', targetDir: dir, userId: 'user-1' });
      expect(run.status).toBe('looping');
      expect(run.loopId).toBe('loop-pass');

      await vi.waitFor(() => expect(getRun(run.id)?.status).toBe('complete'));
      const persisted = getRun(run.id);
      expect(persisted?.iteration).toBe(2);
      expect(persisted?.audit).toMatchObject({ overallStatus: 'pass' });
      expect(recourseMemoryIndex).toHaveBeenCalled();
      expect(recordEpisode).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'accepted', skills: [] }));
      expect(saveProjectStatus).toHaveBeenCalledWith('user-1');
    });
  });

  describe('audit + repair chain', () => {
    function armFailingAudit(): void {
      vi.mocked(executeAuditSuite).mockResolvedValue(failAudit as never);
      vi.mocked(getAgentReadouts).mockReturnValue([]);
      vi.mocked(buildWorkOrder).mockReturnValue({
        items: [{ file: 'src/a.ts', line: '3', category: 'bug', title: 'Fix', suggestion: 'do it', ruleId: 'r', severity: 'high', tool: 'deep' }],
        total: 1,
      });
    }

    it('dispatches repair and completes when repair succeeds', async () => {
      armFailingAudit();
      vi.mocked(triggerRepairTriage).mockResolvedValue({ ok: true });
      vi.mocked(startAxiomProjectLoop).mockResolvedValue({ id: 'loop-fail' });
      vi.mocked(getAxiomProjectStatus).mockResolvedValue({ status: 'completed' });

      const run = await startSupervision({ goal: 'g', targetDir: path.join(tmp, 'proj') });
      await vi.waitFor(() => expect(getRun(run.id)?.status).toBe('complete'));
      expect(triggerRepairTriage).toHaveBeenCalledWith(expect.objectContaining({ signal: 'openhub:supervised-audit-failed', kind: 'job' }));
      expect(recordEpisode).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'rejected' }));
      expect(recordEvent).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'rejected' }));
    });

    it('fails the run and reports an incident when repair dispatch fails', async () => {
      armFailingAudit();
      vi.mocked(triggerRepairTriage).mockResolvedValue({ ok: false, error: 'repair offline' });
      vi.mocked(startAxiomProjectLoop).mockResolvedValue({ id: 'loop-fail-2' });
      vi.mocked(getAxiomProjectStatus).mockResolvedValue({ data: { status: 'finished', iteration: 4 } });

      const run = await startSupervision({ goal: 'g', targetDir: path.join(tmp, 'proj') });
      await vi.waitFor(() => expect(getRun(run.id)?.status).toBe('failed'));
      expect(getRun(run.id)?.error).toBe('repair offline');
      await vi.waitFor(() => expect(reportIncident).toHaveBeenCalledWith(expect.objectContaining({ kind: 'repair-dispatch-failed' })));
    });
  });

  describe('listRuns / getRun', () => {
    it('returns null for missing runs and tolerates corrupt JSON columns', async () => {
      expect(getRun('missing')).toBeNull();
      getDb().prepare(`
        INSERT INTO supervision_runs (id, goal, target_dir, loop_id, status, iteration, max_iterations, skills, audit_json, error, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 0, 8, ?, ?, NULL, ?, ?)
      `).run('bad-json', 'g', 'd', null, 'complete', '{not json', '{not json', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

      const run = getRun('bad-json');
      expect(run?.skills).toEqual([]);
      expect(run?.audit).toBeNull();
      expect(run?.maxIterations).toBe(8);
    });

    it('lists runs newest-first and honors the limit', async () => {
      getRun('seed');
      insertRun('old', 'complete');
      insertRun('new', 'failed');
      getDb().prepare('UPDATE supervision_runs SET created_at = ? WHERE id = ?').run('2026-01-01T00:00:00.000Z', 'old');
      getDb().prepare('UPDATE supervision_runs SET created_at = ? WHERE id = ?').run('2026-06-01T00:00:00.000Z', 'new');

      expect(listRuns(10).map((r) => r.id)).toEqual(['new', 'old']);
      expect(listRuns(1).map((r) => r.id)).toEqual(['new']);
    });
  });

  describe('stop / resume', () => {
    it('stops a looping run and records the operator note', () => {
      getRun('seed');
      insertRun('looping', 'looping', 'loop-x');
      expect(stopSupervision('looping')).toBe(true);
      expect(getRun('looping')?.error).toBe('Stopped by operator');
      expect(stopSupervision('does-not-exist')).toBe(true);
    });

    it('resumes only runs left looping with a loop id', () => {
      getRun('seed');
      insertRun('complete-run', 'complete', 'loop-1');
      expect(resumeSupervision('complete-run')?.status).toBe('complete');
      insertRun('no-loop', 'looping', null);
      expect(resumeSupervision('no-loop')?.status).toBe('looping');
      expect(resumeSupervision('missing')).toBeNull();
    });
  });

  describe('bestSkillsFor', () => {
    it('matches catalog assets and knowledge entries, skipping jobs', () => {
      vi.mocked(loadFleetCatalog).mockReturnValue({
        path: 'p', source: 'live', totals: {},
        assets: [
          { kind: 'tool', name: 'typescript-fixer', description: 'fix typescript', path: 'p' },
          { kind: 'job', name: 'typescript-job', description: 'a job', path: 'p' },
        ],
      } as never);
      vi.mocked(searchKnowledge).mockReturnValue({
        live: true, root: 'r', totals: {}, refreshedAt: '',
        entries: [{ kind: 'skill', key: 'k', name: 'TypeScript Review', description: 'review', path: 'p' }],
      } as never);

      const skills = bestSkillsFor('fix typescript code');
      expect(skills.some((s) => s.name === 'typescript-fixer' && s.kind === 'tool')).toBe(true);
      expect(skills.some((s) => s.name === 'TypeScript Review' && s.kind === 'skill')).toBe(true);
      expect(skills.some((s) => s.name === 'typescript-job')).toBe(false);
      expect(skills.length).toBeLessThanOrEqual(5);
    });

    it('degrades to no candidates when the catalog and knowledge index throw', () => {
      vi.mocked(loadFleetCatalog).mockImplementation(() => { throw new Error('no catalog'); });
      vi.mocked(searchKnowledge).mockImplementation(() => { throw new Error('no knowledge'); });
      expect(bestSkillsFor('anything')).toEqual([]);
      expect(recourseMemoryRecall).not.toHaveBeenCalled();
    });
  });
});
