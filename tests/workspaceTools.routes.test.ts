import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../src/services/projectGit', () => ({
  diffFile: vi.fn(),
  listBranches: vi.fn(),
  createBranch: vi.fn(),
  switchBranch: vi.fn(),
  deleteBranch: vi.fn(),
  searchWorkspace: vi.fn(),
  listWorkspaceFiles: vi.fn(),
  readProjectGitState: vi.fn(),
}));
vi.mock('../src/services/llmRouter', () => ({ runLlm: vi.fn() }));
vi.mock('../src/services/typecheck', () => ({ runTypecheck: vi.fn() }));

import { closeDb, getDb, initializeDatabase } from '../src/auth/db';
import { selectActiveProject } from '../src/services/projectContext';
import {
  diffFile,
  listBranches,
  createBranch,
  switchBranch,
  deleteBranch,
  searchWorkspace,
  listWorkspaceFiles,
  readProjectGitState,
} from '../src/services/projectGit';
import { runLlm } from '../src/services/llmRouter';
import { runTypecheck } from '../src/services/typecheck';
import { createWorkspaceToolsRouter } from '../src/routes/workspaceTools';

const USER = 'workspace-tools-user';
const NO_PROJECT_USER = 'workspace-tools-no-project';

let tmp: string;
let repoDir: string;
let previousDbPath: string | undefined;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-tools-routes-'));
  previousDbPath = process.env.OPENHUB_DB_PATH;
  process.env.OPENHUB_DB_PATH = path.join(tmp, 'test.db');
  closeDb();
  initializeDatabase();

  const db = getDb();
  const insertUser = (id: string) =>
    db.prepare('INSERT INTO users (id, username, email) VALUES (?, ?, ?)').run(id, id, `${id}@example.test`);
  insertUser(USER);
  insertUser(NO_PROJECT_USER);

  repoDir = path.join(tmp, 'repo');
  fs.mkdirSync(repoDir, { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# hello\n');
  db.prepare('INSERT INTO repositories (id, owner_id, name, full_path, default_branch) VALUES (?, ?, ?, ?, ?)')
    .run('repo-1', USER, 'repo-1', repoDir, 'main');

  expect(selectActiveProject(USER, 'repo-1').ok).toBe(true);
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
  vi.mocked(diffFile).mockResolvedValue({
    path: 'README.md',
    tracked: true,
    original: '# old\n',
    modified: '# hello\n',
    patch: 'diff',
  });
  vi.mocked(listBranches).mockResolvedValue({ current: 'main', branches: ['main', 'dev'] });
  vi.mocked(createBranch).mockResolvedValue({ current: 'feature', branches: ['main', 'feature'] });
  vi.mocked(switchBranch).mockResolvedValue({ current: 'dev', branches: ['main', 'dev'] });
  vi.mocked(deleteBranch).mockResolvedValue({ current: 'main', branches: ['main'] });
  vi.mocked(searchWorkspace).mockResolvedValue([{ file: 'README.md', line: 1, text: '# hello' }]);
  vi.mocked(readProjectGitState).mockResolvedValue({
    branch: 'main',
    head: 'abc123',
    subject: 'init',
    changed: [],
    remote: 'origin',
  });
  vi.mocked(runLlm).mockResolvedValue({ ok: true, text: 'A tidy summary', provider: 'http://127.0.0.1:4100' });
  vi.mocked(runTypecheck).mockResolvedValue({ available: true, errors: [] });
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
  app.use('/api', createWorkspaceToolsRouter({ authMiddleware: (_req, _res, next) => next() }));
  return app;
}

describe('workspaceTools — authentication + active project gates', () => {
  it('401s every route when there is no authenticated user', async () => {
    const app = makeApp(null);
    const paths = [
      '/api/project/active/git/diff?path=README.md',
      '/api/project/active/git/branches',
      '/api/project/active/search?q=hello',
    ];
    for (const p of paths) expect((await request(app).get(p)).status, p).toBe(401);
    expect((await request(app).post('/api/project/active/git/branch').send({ action: 'create', name: 'x' })).status).toBe(401);
    expect((await request(app).post('/api/project/active/git/explain').send({ diff: 'x' })).status).toBe(401);
    expect((await request(app).post('/api/project/active/typecheck').send({})).status).toBe(401);
  });

  it('409s when the user has no active project', async () => {
    const app = makeApp(NO_PROJECT_USER);
    const res = await request(app).get('/api/project/active/git/branches');
    expect(res.status).toBe(409);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('Load a project first');
  });
});

describe('workspaceTools — git diff', () => {
  it('400s on a missing or unsafe path', async () => {
    const app = makeApp();
    expect((await request(app).get('/api/project/active/git/diff')).status).toBe(400);
    expect((await request(app).get('/api/project/active/git/diff').query({ path: '   ' })).status).toBe(400);
    expect((await request(app).get('/api/project/active/git/diff').query({ path: '../escape.txt' })).status).toBe(400);
  });

  it('returns the working-tree diff (and honors the cached flag)', async () => {
    const app = makeApp();
    const plain = await request(app).get('/api/project/active/git/diff').query({ path: 'README.md' });
    expect(plain.status).toBe(200);
    expect(plain.body.ok).toBe(true);
    expect(vi.mocked(diffFile)).toHaveBeenCalledWith(repoDir, 'README.md', false);

    const cached = await request(app).get('/api/project/active/git/diff').query({ path: 'README.md', cached: '1' });
    expect(cached.status).toBe(200);
    expect(vi.mocked(diffFile)).toHaveBeenLastCalledWith(repoDir, 'README.md', true);

    const cachedTrue = await request(app).get('/api/project/active/git/diff').query({ path: 'README.md', cached: 'true' });
    expect(cachedTrue.status).toBe(200);
    expect(vi.mocked(diffFile)).toHaveBeenLastCalledWith(repoDir, 'README.md', true);
  });

  it('500s when the diff service throws', async () => {
    vi.mocked(diffFile).mockRejectedValueOnce(new Error('git exploded'));
    const res = await request(makeApp()).get('/api/project/active/git/diff').query({ path: 'README.md' });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('git exploded');
  });
});

describe('workspaceTools — branches', () => {
  it('lists branches', async () => {
    const res = await request(makeApp()).get('/api/project/active/git/branches');
    expect(res.status).toBe(200);
    expect(res.body.branches).toEqual({ current: 'main', branches: ['main', 'dev'] });
  });

  it('500s when listing branches throws', async () => {
    vi.mocked(listBranches).mockRejectedValueOnce(new Error('no git'));
    expect((await request(makeApp()).get('/api/project/active/git/branches')).status).toBe(500);
  });

  it('creates, switches, and deletes branches', async () => {
    const app = makeApp();
    const create = await request(app).post('/api/project/active/git/branch').send({ action: 'create', name: 'feature' });
    expect(create.status).toBe(200);
    expect(create.body.ok).toBe(true);
    expect(vi.mocked(createBranch)).toHaveBeenCalledWith(repoDir, 'feature');
    expect(vi.mocked(readProjectGitState)).toHaveBeenCalledWith(repoDir);

    const swap = await request(app).post('/api/project/active/git/branch').send({ action: 'switch', name: 'dev' });
    expect(swap.status).toBe(200);
    expect(vi.mocked(switchBranch)).toHaveBeenCalledWith(repoDir, 'dev');

    const del = await request(app).post('/api/project/active/git/branch').send({ action: 'delete', name: 'dev' });
    expect(del.status).toBe(200);
    expect(vi.mocked(deleteBranch)).toHaveBeenCalledWith(repoDir, 'dev');
  });

  it('400s on an unknown action and on a service failure', async () => {
    const app = makeApp();
    const invalid = await request(app).post('/api/project/active/git/branch').send({ action: 'rename', name: 'x' });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toBe('action must be create|switch|delete');

    vi.mocked(createBranch).mockRejectedValueOnce(new Error('Invalid branch name'));
    const failed = await request(app).post('/api/project/active/git/branch').send({ action: 'create', name: '..' });
    expect(failed.status).toBe(400);
    expect(failed.body.error).toBe('Invalid branch name');
  });
});

describe('workspaceTools — search', () => {
  it('returns an empty result set for a blank query', async () => {
    const res = await request(makeApp()).get('/api/project/active/search');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, query: '', hits: [] });
    expect(vi.mocked(searchWorkspace)).not.toHaveBeenCalled();
  });

  it('returns hits for a query and ignores non-string queries', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/project/active/search').query({ q: 'hello' });
    expect(res.status).toBe(200);
    expect(res.body.query).toBe('hello');
    expect(res.body.hits).toHaveLength(1);
    expect(vi.mocked(searchWorkspace)).toHaveBeenCalledWith(repoDir, 'hello', expect.objectContaining({ signal: expect.anything() }));

    const array = await request(app).get('/api/project/active/search?q=a&q=b');
    expect(array.status).toBe(200);
    expect(array.body.query).toBe('');
    expect(array.body.hits).toEqual([]);
  });

  it('500s when the search service throws', async () => {
    vi.mocked(searchWorkspace).mockImplementationOnce(() => {
      throw new Error('walk failed');
    });
    expect((await request(makeApp()).get('/api/project/active/search').query({ q: 'x' })).status).toBe(500);
  });
});

describe('workspaceTools — files index (Quick Open)', () => {
  it('returns the flat file list, and 409s without a project', async () => {
    vi.mocked(listWorkspaceFiles).mockResolvedValue(['src/a.ts', 'README.md']);
    const res = await request(makeApp()).get('/api/project/active/files');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, files: ['src/a.ts', 'README.md'] });

    expect((await request(makeApp(NO_PROJECT_USER)).get('/api/project/active/files')).status).toBe(409);
  });

  it('500s when the file index throws', async () => {
    vi.mocked(listWorkspaceFiles).mockImplementationOnce(() => {
      throw new Error('walk failed');
    });
    expect((await request(makeApp()).get('/api/project/active/files')).status).toBe(500);
  });
});

describe('workspaceTools — explain + typecheck', () => {
  it('400s when the diff is missing', async () => {
    const res = await request(makeApp()).post('/api/project/active/git/explain').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('diff is required');
  });

  it('returns the LLM summary', async () => {
    const res = await request(makeApp()).post('/api/project/active/git/explain').send({ diff: '+ const x = 1;' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.text).toBe('A tidy summary');
    const [messages] = vi.mocked(runLlm).mock.calls[0];
    expect(Array.isArray(messages)).toBe(true);
  });

  it('surfaces an honest LLM failure without a 500', async () => {
    vi.mocked(runLlm).mockResolvedValueOnce({ ok: false, text: null, provider: null, error: 'gateway down' });
    const res = await request(makeApp()).post('/api/project/active/git/explain').send({ diff: '+ x' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('gateway down');
  });

  it('500s when the LLM router throws', async () => {
    vi.mocked(runLlm).mockRejectedValueOnce(new Error('unexpected'));
    expect((await request(makeApp()).post('/api/project/active/git/explain').send({ diff: '+ x' })).status).toBe(500);
  });

  it('runs a typecheck and reports failures', async () => {
    const ok = await request(makeApp()).post('/api/project/active/typecheck').send({});
    expect(ok.status).toBe(200);
    expect(ok.body.ok).toBe(true);
    expect(ok.body.available).toBe(true);

    vi.mocked(runTypecheck).mockRejectedValueOnce(new Error('tsc missing'));
    expect((await request(makeApp()).post('/api/project/active/typecheck').send({})).status).toBe(500);
  });
});
