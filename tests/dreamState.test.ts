import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { closeDb, getDb, initializeDatabase } from '../src/auth/db';

vi.mock('../src/services/agentReadouts', () => ({
  getAgentReadouts: vi.fn(),
  buildWorkOrder: vi.fn(),
}));

import { getAgentReadouts, buildWorkOrder } from '../src/services/agentReadouts';
import { analyzeRepo, dreamTick, dreamState, startDreamLoop } from '../src/services/dreamState';

const USER = 'dream-state-user';
const DAY = 86_400_000;

interface RepoInput {
  id: string;
  name: string;
  description: string;
  full_path: string;
  language: string;
}

function ensureAuditTable(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS audit_reports (
      id TEXT PRIMARY KEY,
      target TEXT NOT NULL,
      created_at TEXT NOT NULL,
      overall_status TEXT NOT NULL,
      report_json TEXT NOT NULL
    );
  `);
}

function insertReport(target: string, resultScores: number[], overallStatus = 'pass'): void {
  ensureAuditTable();
  const report = {
    target,
    overallStatus,
    results: resultScores.map((score, i) => ({ scorer: `s${i}`, score, summary: `summary ${i}` })),
  };
  getDb().prepare(
    'INSERT INTO audit_reports (id, target, created_at, overall_status, report_json) VALUES (?, ?, ?, ?, ?)',
  ).run(crypto.randomUUID(), target, new Date().toISOString(), overallStatus, JSON.stringify(report));
}

describe('dreamState', () => {
  let tmp: string;
  let previousDbPath: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dream-state-'));
    previousDbPath = process.env.OPENHUB_DB_PATH;
    process.env.OPENHUB_DB_PATH = path.join(tmp, 'test.db');
    closeDb();
    initializeDatabase();
    getDb().prepare('INSERT INTO users (id, username, email) VALUES (?, ?, ?)').run(USER, USER, `${USER}@example.test`);
    vi.clearAllMocks();
    vi.mocked(getAgentReadouts).mockReturnValue([]);
    vi.mocked(buildWorkOrder).mockReturnValue({ items: [], total: 0 });
  });

  afterEach(() => {
    closeDb();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    if (previousDbPath === undefined) delete process.env.OPENHUB_DB_PATH;
    else process.env.OPENHUB_DB_PATH = previousDbPath;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function repoDir(name: string): string {
    const dir = path.join(tmp, `repo-${name}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  function makeRepo(over: Partial<RepoInput> = {}): RepoInput {
    return { id: 'r1', name: 'alpha', description: 'Alpha description', full_path: repoDir('alpha'), language: 'TypeScript', ...over };
  }

  describe('analyzeRepo', () => {
    it('reports an unanalyzed repo with no README, git, or audit data', () => {
      const repo = makeRepo();
      const entry = analyzeRepo(repo);
      expect(entry).toMatchObject({
        repoId: 'r1',
        name: 'alpha',
        status: 'unanalyzed',
        purpose: 'Alpha description',
        development: 'not a git repo',
        grade: null,
        score: null,
        findings: 0,
      });
      expect(entry.summary).toContain('alpha');
      expect(typeof entry.lastAnalyzedAt).toBe('string');
    });

    it('prefers the README heading for the purpose', () => {
      const repo = makeRepo();
      fs.writeFileSync(path.join(repo.full_path, 'README.md'), '# Cool Project\n\nSome body text.\n', 'utf8');
      expect(analyzeRepo(repo).purpose).toBe('Cool Project');
    });

    it('falls back to the first non-heading line of the README', () => {
      const repo = makeRepo();
      fs.writeFileSync(path.join(repo.full_path, 'readme.md'), 'First line of prose\nSecond line\n', 'utf8');
      expect(analyzeRepo(repo).purpose).toBe('First line of prose');
    });

    it('uses the description when the README has no usable text', () => {
      const repo = makeRepo({ description: 'Only description' });
      fs.writeFileSync(path.join(repo.full_path, 'Readme.md'), '', 'utf8');
      expect(analyzeRepo(repo).purpose).toBe('Only description');
    });

    it('classifies development activity from the git HEAD mtime', () => {
      const cases: Array<[number, string]> = [
        [0, 'active (today)'],
        [3, 'active (3d ago)'],
        [15, 'dormant (15d ago)'],
        [60, 'stale (60d ago)'],
      ];
      for (const [days, expected] of cases) {
        const repo = makeRepo({ id: `r-${days}`, name: `repo${days}`, full_path: repoDir(`dev${days}`) });
        const gitDir = path.join(repo.full_path, '.git');
        fs.mkdirSync(gitDir, { recursive: true });
        const head = path.join(gitDir, 'HEAD');
        fs.writeFileSync(head, 'ref: refs/heads/main\n', 'utf8');
        const mtime = new Date(Date.now() - days * DAY);
        fs.utimesSync(head, mtime, mtime);
        expect(analyzeRepo(repo).development).toBe(expected);
      }
    });

    it('reports no commits when the HEAD file is absent', () => {
      const repo = makeRepo();
      fs.mkdirSync(path.join(repo.full_path, '.git'), { recursive: true });
      expect(analyzeRepo(repo).development).toBe('no commits');
    });

    it.each([
      [95, 'A', 'healthy'],
      [80, 'B', 'healthy'],
      [65, 'C', 'attention'],
      [50, 'D', 'critical'],
      [10, 'F', 'critical'],
    ] as const)('derives grade %s -> %s / %s from an audit report', (score, grade, status) => {
      const repo = makeRepo();
      insertReport(repo.full_path, [score]);
      const entry = analyzeRepo(repo);
      expect(entry.score).toBe(score);
      expect(entry.grade).toBe(grade);
      expect(entry.status).toBe(status);
    });

    it('averages multiple scorer results and rounds to one decimal', () => {
      const repo = makeRepo();
      insertReport(repo.full_path, [90, 81, 70]);
      expect(analyzeRepo(repo).score).toBe(80.3);
    });

    it('matches an audit report by repo name when the target path differs', () => {
      const repo = makeRepo({ name: 'namedrepo' });
      insertReport(`/some/other/path/namedrepo`, [92]);
      const entry = analyzeRepo(repo);
      expect(entry.grade).toBe('A');
      expect(entry.score).toBe(92);
    });

    it('skips corrupt audit report rows', () => {
      const repo = makeRepo();
      ensureAuditTable();
      getDb().prepare(
        'INSERT INTO audit_reports (id, target, created_at, overall_status, report_json) VALUES (?, ?, ?, ?, ?)',
      ).run(crypto.randomUUID(), repo.full_path, new Date().toISOString(), 'pass', '{not json');
      insertReport(repo.full_path, [75]);
      expect(analyzeRepo(repo).grade).toBe('B');
    });

    it('reports a null score when audit results have no numeric scores', () => {
      const repo = makeRepo();
      insertReport(repo.full_path, []);
      const entry = analyzeRepo(repo);
      expect(entry.score).toBeNull();
      expect(entry.grade).toBeNull();
      expect(entry.status).toBe('unanalyzed');
    });

    it('counts findings from the agent work order', () => {
      const repo = makeRepo();
      insertReport(repo.full_path, [95]);
      vi.mocked(buildWorkOrder).mockReturnValue({ items: [], total: 4 });
      const entry = analyzeRepo(repo);
      expect(entry.findings).toBe(4);
      expect(entry.summary).toContain('4 findings');
    });
  });

  describe('dreamTick / dreamState', () => {
    function insertRepo(id: string, name: string, fullPath: string, description = ''): void {
      getDb().prepare(
        'INSERT INTO repositories (id, owner_id, name, description, full_path, language) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(id, USER, name, description, fullPath, 'TypeScript');
    }

    it('analyzes every repository and upserts dream state idempotently', () => {
      const dirOne = repoDir('one');
      const dirTwo = repoDir('two');
      fs.writeFileSync(path.join(dirOne, 'README.md'), '# One\n', 'utf8');
      fs.writeFileSync(path.join(dirTwo, 'README.md'), '# Two\n', 'utf8');
      insertRepo('one', 'one', dirOne);
      insertRepo('two', 'two', dirTwo);

      expect(dreamTick()).toBe(2);
      const first = dreamState();
      expect(first).toHaveLength(2);
      expect(first.map((e) => e.name).sort()).toEqual(['one', 'two']);
      expect(first[0].lastAnalyzedAt).toBeTruthy();

      expect(dreamTick()).toBe(2);
      expect(dreamState()).toHaveLength(2);
    });

    it('startDreamLoop ticks immediately and returns an interval handle', () => {
      const dir = repoDir('loop');
      fs.writeFileSync(path.join(dir, 'README.md'), '# Loop\n', 'utf8');
      insertRepo('loop', 'loop', dir);

      const handle = startDreamLoop(60_000);
      try {
        expect(dreamState()).toHaveLength(1);
        expect(dreamState()[0].name).toBe('loop');
      } finally {
        clearInterval(handle);
      }
    });
  });
});
