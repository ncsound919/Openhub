import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { closeDb, getDb, initializeDatabase } from '../src/auth/db';
import {
  getActiveProject,
  selectActiveProject,
  unloadActiveProject,
} from '../src/services/projectContext';
import { createProjectContextRouter } from '../src/routes/projectContext';

const USER_ONE = 'project-context-user-one';
const USER_TWO = 'project-context-user-two';

function insertUser(id: string): void {
  getDb().prepare('INSERT INTO users (id, username, email) VALUES (?, ?, ?)').run(id, id, `${id}@example.test`);
}

function insertRepository(id: string, ownerId: string, fullPath: string, defaultBranch = 'main'): void {
  getDb().prepare(`
    INSERT INTO repositories (id, owner_id, name, full_path, default_branch)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, ownerId, id, fullPath, defaultBranch);
}

describe('projectContext', () => {
  let tmp: string;
  let previousDbPath: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'project-context-'));
    previousDbPath = process.env.OPENHUB_DB_PATH;
    process.env.OPENHUB_DB_PATH = path.join(tmp, 'test.db');
    closeDb();
    initializeDatabase();
    insertUser(USER_ONE);
    insertUser(USER_TWO);
  });

  afterEach(() => {
    closeDb();
    if (previousDbPath === undefined) delete process.env.OPENHUB_DB_PATH;
    else process.env.OPENHUB_DB_PATH = previousDbPath;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('persists one owned directory and resolves its GitHub metadata', () => {
    const repoPath = path.join(tmp, 'owned-repository');
    fs.mkdirSync(repoPath);
    insertRepository('repo-one', USER_ONE, repoPath, 'local-main');
    getDb().prepare(`
      INSERT INTO github_synced_repos (
        id, user_id, local_repo_id, github_repo_id, github_full_name,
        github_owner, github_name, default_branch, last_synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'sync-one',
      USER_ONE,
      'repo-one',
      42,
      'openhub/owned-repository',
      'openhub',
      'owned-repository',
      'trunk',
      '2026-09-13T10:00:00.000Z',
    );

    const selected = selectActiveProject(USER_ONE, 'repo-one');

    expect(selected).toEqual({
      ok: true,
      project: {
        repoId: 'repo-one',
        path: repoPath,
        selectedAt: expect.any(String),
        repositoryName: 'repo-one',
        githubFullName: 'openhub/owned-repository',
        defaultBranch: 'trunk',
      },
    });
    if (!selected.ok) throw new Error('Expected the repository selection to succeed');
    expect(getActiveProject(USER_ONE)).toEqual(selected.project);

    const columns = getDb().prepare('PRAGMA table_info(active_project_context)').all() as Array<{ name: string; pk: number }>;
    expect(columns).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'user_id', pk: 1 }),
      expect.objectContaining({ name: 'repo_id', pk: 0 }),
      expect.objectContaining({ name: 'path', pk: 0 }),
      expect.objectContaining({ name: 'selected_at', pk: 0 }),
    ]));
    const foreignKeys = getDb().prepare('PRAGMA foreign_key_list(active_project_context)').all() as Array<{ table: string }>;
    expect(foreignKeys.map((foreignKey) => foreignKey.table)).toEqual(expect.arrayContaining(['users', 'repositories']));
  });

  it('rejects repositories that are unowned, missing, or not directories', () => {
    const otherPath = path.join(tmp, 'other-users-repository');
    const filePath = path.join(tmp, 'not-a-directory');
    const missingPath = path.join(tmp, 'missing-directory');
    fs.mkdirSync(otherPath);
    fs.writeFileSync(filePath, 'not a repository directory');
    insertRepository('other-repo', USER_TWO, otherPath);
    insertRepository('file-repo', USER_ONE, filePath);
    insertRepository('missing-path-repo', USER_ONE, missingPath);

    expect(selectActiveProject(USER_ONE, 'other-repo')).toMatchObject({
      ok: false,
      code: 'REPOSITORY_NOT_FOUND',
    });
    expect(selectActiveProject(USER_ONE, 'missing-repo')).toMatchObject({
      ok: false,
      code: 'REPOSITORY_NOT_FOUND',
    });
    expect(selectActiveProject(USER_ONE, 'file-repo')).toMatchObject({
      ok: false,
      code: 'REPOSITORY_PATH_INVALID',
    });
    expect(selectActiveProject(USER_ONE, 'missing-path-repo')).toMatchObject({
      ok: false,
      code: 'REPOSITORY_PATH_INVALID',
    });
    expect(getActiveProject(USER_ONE)).toBeNull();
  });

  it('does not replace an existing selection until it is unloaded', () => {
    const firstPath = path.join(tmp, 'first');
    const secondPath = path.join(tmp, 'second');
    const otherUserPath = path.join(tmp, 'other-user');
    fs.mkdirSync(firstPath);
    fs.mkdirSync(secondPath);
    fs.mkdirSync(otherUserPath);
    insertRepository('first-repo', USER_ONE, firstPath);
    insertRepository('second-repo', USER_ONE, secondPath);
    insertRepository('other-user-repo', USER_TWO, otherUserPath);

    expect(selectActiveProject(USER_ONE, 'first-repo')).toMatchObject({ ok: true });
    expect(selectActiveProject(USER_ONE, 'second-repo')).toMatchObject({
      ok: false,
      code: 'ACTIVE_PROJECT_EXISTS',
      active: { repoId: 'first-repo' },
    });
    expect(getActiveProject(USER_ONE)?.repoId).toBe('first-repo');
    expect(selectActiveProject(USER_TWO, 'other-user-repo')).toMatchObject({ ok: true });

    expect(unloadActiveProject(USER_ONE)).toMatchObject({
      ok: true,
      project: { repoId: 'first-repo' },
    });
    expect(getActiveProject(USER_ONE)).toBeNull();
    expect(unloadActiveProject(USER_ONE)).toMatchObject({
      ok: false,
      code: 'NO_ACTIVE_PROJECT',
    });
    expect(selectActiveProject(USER_ONE, 'second-repo')).toMatchObject({
      ok: true,
      project: { repoId: 'second-repo' },
    });
  });

  it('reads, writes, and protects active-project files', async () => {
    const repoPath = path.join(tmp, 'file-api-repo');
    fs.mkdirSync(repoPath);
    fs.writeFileSync(path.join(repoPath, 'README.md'), '# Initial\n');
    execFileSync('git', ['init', '--initial-branch=main'], { cwd: repoPath });
    execFileSync('git', ['config', 'user.name', 'OpenHub Test'], { cwd: repoPath });
    execFileSync('git', ['config', 'user.email', 'openhub-test@example.test'], { cwd: repoPath });
    execFileSync('git', ['add', 'README.md'], { cwd: repoPath });
    execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: repoPath });
    insertRepository('file-api-repo', USER_ONE, repoPath);

    const app = express();
    app.use(express.json());
    app.use('/api', createProjectContextRouter({
      authMiddleware: (req, res, next) => {
        if (req.header('authorization') !== 'Bearer test-token') return void res.sendStatus(401);
        req.user = { sub: USER_ONE, email: 'user-one@example.test' };
        next();
      },
    }));
    const auth = { Authorization: 'Bearer test-token' };

    expect((await request(app).post('/api/project/active').set(auth).send({ repoId: 'file-api-repo' })).status).toBe(200);
    const initial = await request(app).get('/api/project/active/contents?path=README.md').set(auth);
    expect(initial.status).toBe(200);
    expect(initial.body).toMatchObject({ type: 'file', path: 'README.md', content: '# Initial\n' });

    const traversal = await request(app).get('/api/project/active/contents?path=../outside.txt').set(auth);
    expect(traversal.status).toBe(400);
    expect(traversal.body.error).toBe('Path traversal denied');

    const write = await request(app).put('/api/project/active/contents').set(auth).send({ path: 'src/index.ts', content: 'export const value = 1;\n' });
    expect(write.status).toBe(200);
    expect(fs.readFileSync(path.join(repoPath, 'src', 'index.ts'), 'utf8')).toBe('export const value = 1;\n');

    const dirty = await request(app).get('/api/project/active/git').set(auth);
    expect(dirty.status).toBe(200);
    expect(dirty.body.git.changed).toContain('?? src/index.ts');

    const invalidCommit = await request(app).post('/api/project/active/git/commit').set(auth).send({ message: 'first\nsecond' });
    expect(invalidCommit.status).toBe(409);
    const committed = await request(app).post('/api/project/active/git/commit').set(auth).send({ message: 'Add active project file' });
    expect(committed.status).toBe(200);
    expect(committed.body.git).toMatchObject({ subject: 'Add active project file', changed: [] });
  });

  it('exposes authenticated active-project routes with explicit statuses', async () => {
    const firstPath = path.join(tmp, 'route-first');
    const secondPath = path.join(tmp, 'route-second');
    fs.mkdirSync(firstPath);
    fs.mkdirSync(secondPath);
    insertRepository('route-first-repo', USER_ONE, firstPath);
    insertRepository('route-second-repo', USER_ONE, secondPath);

    const app = express();
    app.use(express.json());
    app.use('/api', createProjectContextRouter({
      authMiddleware: (req, res, next) => {
        if (req.header('authorization') !== 'Bearer test-token') {
          res.sendStatus(401);
          return;
        }
        req.user = { sub: USER_ONE, email: 'user-one@example.test' };
        next();
      },
    }));

    expect((await request(app).get('/api/project/active')).status).toBe(401);
    expect((await request(app).get('/api/project/active').set('Authorization', 'Bearer test-token')).status).toBe(404);

    const invalid = await request(app)
      .post('/api/project/active')
      .set('Authorization', 'Bearer test-token')
      .send({});
    expect(invalid.status).toBe(400);
    expect(invalid.body.code).toBe('INVALID_REPOSITORY');

    const selected = await request(app)
      .post('/api/project/active')
      .set('Authorization', 'Bearer test-token')
      .send({ repoId: 'route-first-repo' });
    expect(selected.status).toBe(200);
    expect(selected.body.project.repoId).toBe('route-first-repo');

    const conflict = await request(app)
      .post('/api/project/active')
      .set('Authorization', 'Bearer test-token')
      .send({ repoId: 'route-second-repo' });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('ACTIVE_PROJECT_EXISTS');

    const unloaded = await request(app)
      .delete('/api/project/active')
      .set('Authorization', 'Bearer test-token');
    expect(unloaded.status).toBe(200);
    expect(unloaded.body.project.repoId).toBe('route-first-repo');
    expect((await request(app).get('/api/project/active').set('Authorization', 'Bearer test-token')).status).toBe(404);
  });
});
