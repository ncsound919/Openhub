import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../src/services/projectGit', () => ({
  readProjectGitState: vi.fn(),
  commitProject: vi.fn(),
  pushProject: vi.fn(),
  readProjectDrift: vi.fn(),
}));
vi.mock('../src/services/projectStatus', () => ({
  saveProjectStatus: vi.fn(),
  readProjectStatus: vi.fn(),
  buildProjectStatusSnapshot: vi.fn(),
  STATUS_FILE_PATH: '.openhub/status.json',
}));

import { closeDb, getDb, initializeDatabase } from '../src/auth/db';
import { selectActiveProject } from '../src/services/projectContext';
import { readProjectGitState, commitProject, pushProject, readProjectDrift } from '../src/services/projectGit';
import { saveProjectStatus, readProjectStatus, buildProjectStatusSnapshot } from '../src/services/projectStatus';
import { createProjectContextRouter } from '../src/routes/projectContext';

const U_MAIN = 'pc-main';
const U_NONE = 'pc-none';
const U_SELECT = 'pc-select';
const U_DELETE = 'pc-delete';
const U_GONE = 'pc-gone';
const U_FILE = 'pc-file';
const U_BAD = 'pc-bad';

let tmp: string;
let repoMain: string;
let previousDbPath: string | undefined;
let snapshot: any;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'project-context-routes-'));
  previousDbPath = process.env.OPENHUB_DB_PATH;
  process.env.OPENHUB_DB_PATH = path.join(tmp, 'test.db');
  closeDb();
  initializeDatabase();

  const db = getDb();
  const insertUser = (id: string) =>
    db.prepare('INSERT INTO users (id, username, email) VALUES (?, ?, ?)').run(id, id, `${id}@example.test`);
  const insertRepo = (id: string, owner: string, fullPath: string, branch = 'main') =>
    db.prepare('INSERT INTO repositories (id, owner_id, name, full_path, default_branch) VALUES (?, ?, ?, ?, ?)')
      .run(id, owner, id, fullPath, branch);
  const mkdir = (p: string) => fs.mkdirSync(p, { recursive: true });

  for (const id of [U_MAIN, U_NONE, U_SELECT, U_DELETE, U_GONE, U_FILE, U_BAD]) insertUser(id);

  repoMain = path.join(tmp, 'repo-main');
  mkdir(path.join(repoMain, 'src', 'nested'));
  mkdir(path.join(repoMain, 'node_modules'));
  mkdir(path.join(repoMain, '.git'));
  fs.writeFileSync(path.join(repoMain, 'README.md'), '# Main\n');
  fs.writeFileSync(path.join(repoMain, 'src', 'index.ts'), 'export const value = 1;\n');
  fs.writeFileSync(path.join(repoMain, 'src', 'nested', 'deep.txt'), 'deep\n');
  fs.writeFileSync(path.join(repoMain, 'node_modules', 'skipme.js'), 'skip\n');

  const repoSelect = path.join(tmp, 'repo-select');
  const repoSelectAlt = path.join(tmp, 'repo-select-alt');
  const repoDelete = path.join(tmp, 'repo-delete');
  const repoGone = path.join(tmp, 'repo-gone');
  const repoFile = path.join(tmp, 'repo-file');
  const badFile = path.join(tmp, 'not-a-dir.txt');
  const missingPath = path.join(tmp, 'missing-dir');
  for (const dir of [repoSelect, repoSelectAlt, repoDelete, repoGone, repoFile]) mkdir(dir);
  fs.writeFileSync(badFile, 'i am a file\n');

  insertRepo('repo-main', U_MAIN, repoMain);
  insertRepo('repo-select', U_SELECT, repoSelect);
  insertRepo('repo-select-alt', U_SELECT, repoSelectAlt);
  insertRepo('repo-delete', U_DELETE, repoDelete);
  insertRepo('repo-gone', U_GONE, repoGone);
  insertRepo('repo-file', U_FILE, repoFile);
  insertRepo('repo-bad-file', U_BAD, badFile);
  insertRepo('repo-missing', U_BAD, missingPath);

  expect(selectActiveProject(U_MAIN, 'repo-main').ok).toBe(true);
  expect(selectActiveProject(U_DELETE, 'repo-delete').ok).toBe(true);
  expect(selectActiveProject(U_GONE, 'repo-gone').ok).toBe(true);
  expect(selectActiveProject(U_FILE, 'repo-file').ok).toBe(true);

  fs.rmSync(repoGone, { recursive: true, force: true });
  fs.rmSync(repoFile, { recursive: true, force: true });
  fs.writeFileSync(repoFile, 'now a file\n');

  snapshot = {
    generatedAt: '2026-01-01T00:00:00.000Z',
    project: { name: 'repo-main', path: repoMain, githubFullName: null, branch: 'main' },
    lastRun: null,
    lastAudit: null,
    todos: 0,
    modelRoutes: {},
  };
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
  vi.mocked(readProjectGitState).mockResolvedValue({
    branch: 'main',
    head: 'abc',
    subject: 'init',
    changed: [],
    remote: 'origin',
  });
  vi.mocked(commitProject).mockResolvedValue({
    branch: 'main',
    head: 'def',
    subject: 'commit',
    changed: [],
    remote: 'origin',
  });
  vi.mocked(pushProject).mockResolvedValue({
    branch: 'main',
    head: 'def',
    subject: 'commit',
    changed: [],
    remote: 'origin',
  });
  vi.mocked(readProjectDrift).mockResolvedValue({
    available: true,
    fetched: true,
    hasUpstream: true,
    branch: 'main',
    remote: 'origin',
    ahead: 0,
    behind: 0,
    uncommitted: 1,
    files: [],
    stat: null,
    lastPush: null,
  });
  vi.mocked(readProjectStatus).mockReturnValue(snapshot);
  vi.mocked(buildProjectStatusSnapshot).mockReturnValue(snapshot);
  vi.mocked(saveProjectStatus).mockReturnValue(snapshot);
});

function makeApp(userId: string | null = U_MAIN) {
  const app = express();
  app.use(express.json());
  if (userId) {
    app.use((req, _res, next) => {
      (req as { user?: unknown }).user = { sub: userId };
      next();
    });
  }
  app.use('/api', createProjectContextRouter({ authMiddleware: (_req, _res, next) => next() }));
  return app;
}

describe('projectContext — /project/active', () => {
  it('GET requires auth, 404s without a selection, and returns the project', async () => {
    expect((await request(makeApp(null)).get('/api/project/active')).status).toBe(401);

    const none = await request(makeApp(U_NONE)).get('/api/project/active');
    expect(none.status).toBe(404);
    expect(none.body.code).toBe('NO_ACTIVE_PROJECT');

    const active = await request(makeApp()).get('/api/project/active');
    expect(active.status).toBe(200);
    expect(active.body.ok).toBe(true);
    expect(active.body.project.repoId).toBe('repo-main');
  });

  it('POST validates the repoId and selects a project', async () => {
    expect((await request(makeApp(null)).post('/api/project/active').send({ repoId: 'x' })).status).toBe(401);

    const empty = await request(makeApp(U_SELECT)).post('/api/project/active').send({});
    expect(empty.status).toBe(400);
    expect(empty.body.code).toBe('INVALID_REPOSITORY');

    const blank = await request(makeApp(U_SELECT)).post('/api/project/active').send({ repoId: '   ' });
    expect(blank.status).toBe(400);

    const unknown = await request(makeApp(U_BAD)).post('/api/project/active').send({ repoId: 'repo-unknown' });
    expect(unknown.status).toBe(400);
    expect(unknown.body.code).toBe('REPOSITORY_NOT_FOUND');

    const filePath = await request(makeApp(U_BAD)).post('/api/project/active').send({ repoId: 'repo-bad-file' });
    expect(filePath.status).toBe(400);
    expect(filePath.body.code).toBe('REPOSITORY_PATH_INVALID');

    const missing = await request(makeApp(U_BAD)).post('/api/project/active').send({ repoId: 'repo-missing' });
    expect(missing.status).toBe(400);

    const selected = await request(makeApp(U_SELECT)).post('/api/project/active').send({ repoId: 'repo-select' });
    expect(selected.status).toBe(200);
    expect(selected.body.project.repoId).toBe('repo-select');

    const conflict = await request(makeApp(U_SELECT)).post('/api/project/active').send({ repoId: 'repo-select-alt' });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('ACTIVE_PROJECT_EXISTS');
  });

  it('DELETE unloads, 404s when nothing is loaded, and requires auth', async () => {
    expect((await request(makeApp(null)).delete('/api/project/active')).status).toBe(401);
    expect((await request(makeApp(U_NONE)).delete('/api/project/active')).status).toBe(404);

    const unloaded = await request(makeApp(U_DELETE)).delete('/api/project/active');
    expect(unloaded.status).toBe(200);
    expect(unloaded.body.project.repoId).toBe('repo-delete');
  });
});

describe('projectContext — contents', () => {
  it('GET enforces auth, active project, and path safety', async () => {
    expect((await request(makeApp(null)).get('/api/project/active/contents')).status).toBe(401);
    expect((await request(makeApp(U_NONE)).get('/api/project/active/contents')).status).toBe(409);
    expect((await request(makeApp(U_GONE)).get('/api/project/active/contents')).status).toBe(409);
    expect((await request(makeApp(U_FILE)).get('/api/project/active/contents')).status).toBe(409);

    const traversal = await request(makeApp()).get('/api/project/active/contents').query({ path: '../escape.txt' });
    expect(traversal.status).toBe(400);
    expect(traversal.body.error).toBe('Path traversal denied');

    const array = await request(makeApp()).get('/api/project/active/contents?path=a&path=b');
    expect(array.status).toBe(400);
    expect(array.body.error).toBe('path must be a string');

    const missing = await request(makeApp()).get('/api/project/active/contents').query({ path: 'missing.txt' });
    expect(missing.status).toBe(404);
  });

  it('GET lists a directory (filtering noise) and reads a file', async () => {
    const dir = await request(makeApp()).get('/api/project/active/contents');
    expect(dir.status).toBe(200);
    expect(dir.body.type).toBe('dir');
    const names = (dir.body.entries as Array<{ name: string }>).map((e) => e.name).sort();
    expect(names).toContain('README.md');
    expect(names).toContain('src');
    expect(names).not.toContain('node_modules');
    expect(names).not.toContain('.git');

    const sub = await request(makeApp()).get('/api/project/active/contents').query({ path: 'src' });
    expect(sub.status).toBe(200);
    expect(sub.body.type).toBe('dir');

    const file = await request(makeApp()).get('/api/project/active/contents').query({ path: 'README.md' });
    expect(file.status).toBe(200);
    expect(file.body.type).toBe('file');
    expect(file.body.content).toBe('# Main\n');
    expect(file.body.language).toBe('md');
  });

  it('PUT validates path/content and writes files', async () => {
    expect((await request(makeApp(null)).put('/api/project/active/contents').send({ path: 'a', content: 'b' })).status).toBe(401);
    expect((await request(makeApp(U_NONE)).put('/api/project/active/contents').send({ path: 'a', content: 'b' })).status).toBe(409);

    const noPath = await request(makeApp()).put('/api/project/active/contents').send({ content: 'x' });
    expect(noPath.status).toBe(400);
    expect(noPath.body.error).toBe('path must be a string');

    const traversal = await request(makeApp()).put('/api/project/active/contents').send({ path: '../x', content: 'y' });
    expect(traversal.status).toBe(400);

    const noContent = await request(makeApp()).put('/api/project/active/contents').send({ path: 'new.txt' });
    expect(noContent.status).toBe(400);
    expect(noContent.body.error).toBe('content must be a string');

    const overwriteDir = await request(makeApp()).put('/api/project/active/contents').send({ path: 'src', content: 'x' });
    expect(overwriteDir.status).toBe(409);

    const written = await request(makeApp())
      .put('/api/project/active/contents')
      .send({ path: 'src/new.ts', content: 'export const added = true;\n' });
    expect(written.status).toBe(200);
    expect(written.body.bytes).toBeGreaterThan(0);
    expect(fs.readFileSync(path.join(repoMain, 'src', 'new.ts'), 'utf8')).toBe('export const added = true;\n');

    const underFile = await request(makeApp())
      .put('/api/project/active/contents')
      .send({ path: 'README.md/nested.txt', content: 'x' });
    expect(underFile.status).toBe(500);
  });
});

describe('projectContext — git routes', () => {
  it('GET /git requires an active project and returns state or 409', async () => {
    expect((await request(makeApp(null)).get('/api/project/active/git')).status).toBe(401);
    expect((await request(makeApp(U_NONE)).get('/api/project/active/git')).status).toBe(409);

    const ok = await request(makeApp()).get('/api/project/active/git');
    expect(ok.status).toBe(200);
    expect(ok.body.git.branch).toBe('main');

    vi.mocked(readProjectGitState).mockRejectedValueOnce(new Error('no git'));
    expect((await request(makeApp()).get('/api/project/active/git')).status).toBe(409);
  });

  it('commit validates the message and reports failures', async () => {
    expect((await request(makeApp(null)).post('/api/project/active/git/commit').send({ message: 'm' })).status).toBe(401);
    expect((await request(makeApp(U_NONE)).post('/api/project/active/git/commit').send({ message: 'm' })).status).toBe(409);

    const invalid = await request(makeApp()).post('/api/project/active/git/commit').send({ message: 42 });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toBe('message must be a string');

    const ok = await request(makeApp()).post('/api/project/active/git/commit').send({ message: 'real message' });
    expect(ok.status).toBe(200);
    expect(vi.mocked(commitProject)).toHaveBeenCalledWith(repoMain, 'real message');

    vi.mocked(commitProject).mockRejectedValueOnce(new Error('nothing to commit'));
    expect((await request(makeApp()).post('/api/project/active/git/commit').send({ message: 'x' })).status).toBe(409);
  });

  it('push reports success and failure', async () => {
    expect((await request(makeApp(null)).post('/api/project/active/git/push')).status).toBe(401);
    expect((await request(makeApp(U_NONE)).post('/api/project/active/git/push')).status).toBe(409);

    expect((await request(makeApp()).post('/api/project/active/git/push')).status).toBe(200);

    vi.mocked(pushProject).mockRejectedValueOnce(new Error('no remote'));
    expect((await request(makeApp()).post('/api/project/active/git/push')).status).toBe(409);
  });

  it('drift reports success and a 500 on failure', async () => {
    expect((await request(makeApp(null)).get('/api/project/active/drift')).status).toBe(401);
    expect((await request(makeApp(U_NONE)).get('/api/project/active/drift')).status).toBe(409);

    const ok = await request(makeApp()).get('/api/project/active/drift');
    expect(ok.status).toBe(200);
    expect(ok.body.drift.available).toBe(true);

    vi.mocked(readProjectDrift).mockRejectedValueOnce(new Error('drift fail'));
    expect((await request(makeApp()).get('/api/project/active/drift')).status).toBe(500);
  });
});

describe('projectContext — status routes', () => {
  it('GET /status gates on auth + active project and returns snapshot data', async () => {
    expect((await request(makeApp(null)).get('/api/project/active/status')).status).toBe(401);
    expect((await request(makeApp(U_NONE)).get('/api/project/active/status')).status).toBe(409);

    const res = await request(makeApp()).get('/api/project/active/status');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.persisted).toEqual(snapshot);
    expect(res.body.current).toEqual(snapshot);
  });

  it('POST /status saves the snapshot or 409s when there is no project', async () => {
    expect((await request(makeApp(null)).post('/api/project/active/status')).status).toBe(401);

    vi.mocked(saveProjectStatus).mockReturnValueOnce(null);
    const none = await request(makeApp(U_NONE)).post('/api/project/active/status');
    expect(none.status).toBe(409);
    expect(none.body.code).toBe('NO_ACTIVE_PROJECT');

    const ok = await request(makeApp()).post('/api/project/active/status');
    expect(ok.status).toBe(200);
    expect(ok.body.snapshot).toEqual(snapshot);
  });

  it('POST /status/sync commits the status file', async () => {
    expect((await request(makeApp(null)).post('/api/project/active/status/sync')).status).toBe(401);
    expect((await request(makeApp(U_NONE)).post('/api/project/active/status/sync')).status).toBe(409);

    const ok = await request(makeApp()).post('/api/project/active/status/sync');
    expect(ok.status).toBe(200);
    expect(vi.mocked(commitProject)).toHaveBeenCalled();

    vi.mocked(saveProjectStatus).mockReturnValueOnce(null);
    expect((await request(makeApp()).post('/api/project/active/status/sync')).status).toBe(409);

    vi.mocked(commitProject).mockRejectedValueOnce(new Error('commit fail'));
    expect((await request(makeApp()).post('/api/project/active/status/sync')).status).toBe(409);
  });
});

describe('projectContext — file operations', () => {
  it('creates a file, refuses duplicates and protected/traversal paths', async () => {
    const created = await request(makeApp()).post('/api/project/active/file').send({ path: 'src/created-op.ts' });
    expect(created.status).toBe(200);
    expect(created.body.ok).toBe(true);
    expect(fs.existsSync(path.join(repoMain, 'src', 'created-op.ts'))).toBe(true);

    expect((await request(makeApp()).post('/api/project/active/file').send({ path: 'src/created-op.ts' })).status).toBe(409);
    expect((await request(makeApp()).post('/api/project/active/file').send({ path: '.git/hooks/pre-commit' })).status).toBe(400);
    expect((await request(makeApp()).post('/api/project/active/file').send({ path: '../escape.ts' })).status).toBe(400);
  });

  it('renames a file and refuses missing sources / existing destinations', async () => {
    await request(makeApp()).post('/api/project/active/file').send({ path: 'src/rename-me.ts' });

    const renamed = await request(makeApp()).post('/api/project/active/file/rename').send({ from: 'src/rename-me.ts', to: 'src/renamed.ts' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.to).toBe('src/renamed.ts');
    expect(fs.existsSync(path.join(repoMain, 'src', 'renamed.ts'))).toBe(true);
    expect(fs.existsSync(path.join(repoMain, 'src', 'rename-me.ts'))).toBe(false);

    expect((await request(makeApp()).post('/api/project/active/file/rename').send({ from: 'src/nope.ts', to: 'src/x.ts' })).status).toBe(404);
    expect((await request(makeApp()).post('/api/project/active/file/rename').send({ from: 'src/renamed.ts', to: 'README.md' })).status).toBe(409);
    expect((await request(makeApp()).post('/api/project/active/file/rename').send({ from: 'src/renamed.ts', to: 'node_modules/x.ts' })).status).toBe(400);
  });

  it('deletes a file, refusing protected paths and directories', async () => {
    await request(makeApp()).post('/api/project/active/file').send({ path: 'src/delete-me.ts' });
    const del = await request(makeApp()).delete('/api/project/active/file').query({ path: 'src/delete-me.ts' });
    expect(del.status).toBe(200);
    expect(fs.existsSync(path.join(repoMain, 'src', 'delete-me.ts'))).toBe(false);

    expect((await request(makeApp()).delete('/api/project/active/file').query({ path: 'src/delete-me.ts' })).status).toBe(404);
    expect((await request(makeApp()).delete('/api/project/active/file').query({ path: 'src' })).status).toBe(409);
    expect((await request(makeApp()).delete('/api/project/active/file').query({ path: 'node_modules/skipme.js' })).status).toBe(400);
  });
});
