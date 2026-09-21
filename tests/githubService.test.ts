import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDb, initializeDatabase } from '../src/auth/db';
import {
  getGitHubIntegration,
  saveGitHubIntegration,
  removeGitHubIntegration,
  verifyAndFetchGitHubProfile,
  fetchUserRepos,
  fetchGitHubIssues,
  createGitHubIssue,
  fetchGitHubPulls,
  fetchGitHubWorkflows,
  fetchGitHubWorkflowRuns,
  dispatchGitHubWorkflow,
  recordGitHubWebhookEvent,
  getGitHubWebhookEvents,
  importGitHubRepo,
  pushSyncToGitHub,
} from '../src/services/githubService';

const USER = 'github-service-user';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function textResponse(body: string, status = 500): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/plain' } });
}

function insertUser(id: string): void {
  getDb().prepare('INSERT INTO users (id, username, email) VALUES (?, ?, ?)').run(id, id, `${id}@example.test`);
}

describe('githubService', () => {
  let tmp: string;
  let previousDbPath: string | undefined;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'github-service-'));
    previousDbPath = process.env.OPENHUB_DB_PATH;
    process.env.OPENHUB_DB_PATH = path.join(tmp, 'test.db');
    closeDb();
    initializeDatabase();
    insertUser(USER);
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    closeDb();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    if (previousDbPath === undefined) delete process.env.OPENHUB_DB_PATH;
    else process.env.OPENHUB_DB_PATH = previousDbPath;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  describe('storage', () => {
    it('saves, reads and updates an integration (upsert)', () => {
      expect(getGitHubIntegration(USER)).toBeNull();

      saveGitHubIntegration(USER, 'token-one', {
        id: 42,
        login: 'octocat',
        avatar_url: 'https://avatar.test/one.png',
        email: 'octo@example.test',
      });
      const first = getGitHubIntegration(USER);
      expect(first).toMatchObject({
        accessToken: 'token-one',
        githubUsername: 'octocat',
        githubAvatar: 'https://avatar.test/one.png',
        githubEmail: 'octo@example.test',
        scope: 'repo,read:user,workflow',
      });
      expect(typeof first?.updatedAt).toBe('string');

      saveGitHubIntegration(USER, 'token-two', { login: 'newcat' }, 'repo');
      const second = getGitHubIntegration(USER);
      expect(second).toMatchObject({ accessToken: 'token-two', githubUsername: 'newcat', scope: 'repo' });
      expect(getDb().prepare('SELECT COUNT(*) AS n FROM github_integrations').get()).toEqual({ n: 1 });

      removeGitHubIntegration(USER);
      expect(getGitHubIntegration(USER)).toBeNull();
    });

    it('stores nulls for missing profile fields', () => {
      saveGitHubIntegration(USER, 'token', {});
      const row = getDb().prepare('SELECT github_id, github_avatar, github_email FROM github_integrations WHERE user_id = ?').get(USER) as {
        github_id: string | null;
        github_avatar: string | null;
        github_email: string | null;
      };
      expect(row).toEqual({ github_id: null, github_avatar: null, github_email: null });
    });
  });

  describe('verifyAndFetchGitHubProfile', () => {
    it('returns the profile on 200', async () => {
      const profile = { id: 1, login: 'octocat', name: 'Mona', avatar_url: 'a', email: null, bio: null, public_repos: 2, html_url: 'h' };
      fetchMock.mockResolvedValueOnce(jsonResponse(profile));
      await expect(verifyAndFetchGitHubProfile('token')).resolves.toEqual(profile);
      expect(fetchMock).toHaveBeenCalledWith('https://api.github.com/user', expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer token' }) }));
    });

    it('throws with the response text on non-200', async () => {
      fetchMock.mockResolvedValueOnce(textResponse('bad credentials', 401));
      await expect(verifyAndFetchGitHubProfile('token')).rejects.toThrow('GitHub token verification failed (401): bad credentials');
    });
  });

  describe('fetchUserRepos', () => {
    it('maps repos and marks already-imported ones', async () => {
      getDb().prepare(`
        INSERT INTO github_synced_repos (id, user_id, local_repo_id, github_repo_id, github_full_name, github_owner, github_name, default_branch)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run('sync-1', USER, 'local-1', 7, 'octo/seven', 'octo', 'seven', 'main');

      fetchMock.mockResolvedValueOnce(jsonResponse([
        {
          id: 7, name: 'seven', full_name: 'octo/seven', owner: { login: 'octo', avatar_url: 'a7' },
          private: false, html_url: 'h7', description: null, fork: false, default_branch: '', language: null,
        },
        {
          id: 8, name: 'eight', full_name: 'octo/eight', owner: { login: 'octo', avatar_url: 'a8' },
          private: true, html_url: 'h8', description: 'desc', fork: true, default_branch: 'dev', language: 'Go',
          stargazers_count: 3, forks_count: 1, open_issues_count: 4, updated_at: 'u8', pushed_at: 'p8',
        },
      ]));

      const repos = await fetchUserRepos('token', USER);
      expect(repos).toHaveLength(2);
      expect(repos[0]).toMatchObject({ id: 7, name: 'seven', is_imported: true, local_repo_id: 'local-1', default_branch: 'main' });
      expect(repos[1]).toMatchObject({
        id: 8, is_imported: false, stargazers_count: 3, forks_count: 1, open_issues_count: 4,
        default_branch: 'dev', language: 'Go', private: true,
      });
      expect(repos[1].local_repo_id).toBeUndefined();
    });

    it('throws on non-200', async () => {
      fetchMock.mockResolvedValueOnce(textResponse('nope', 403));
      await expect(fetchUserRepos('token', USER)).rejects.toThrow('Failed to fetch GitHub repos');
    });
  });

  describe('single-resource calls', () => {
    const cases: Array<[string, () => Promise<unknown>, string, string]> = [
      ['issues', () => fetchGitHubIssues('t', 'o', 'r'), 'Failed to fetch issues', 'Failed to fetch issues'],
      ['pulls', () => fetchGitHubPulls('t', 'o', 'r'), 'Failed to fetch PRs', 'Failed to fetch PRs'],
      ['workflows', () => fetchGitHubWorkflows('t', 'o', 'r'), 'Failed to fetch workflows', 'Failed to fetch workflows'],
      ['runs', () => fetchGitHubWorkflowRuns('t', 'o', 'r'), 'Failed to fetch workflow runs', 'Failed to fetch workflow runs'],
    ];

    it.each(cases)('returns the body for %s on 200', async (_name, fn) => {
      fetchMock.mockResolvedValueOnce(jsonResponse([{ id: 1 }]));
      await expect(fn()).resolves.toEqual([{ id: 1 }]);
    });

    it.each(cases)('throws for %s on non-200', async (_name, fn, _ok, error) => {
      fetchMock.mockResolvedValueOnce(textResponse('bad', 500));
      await expect(fn()).rejects.toThrow(error);
    });

    it('createGitHubIssue posts and returns the created issue', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ number: 5, title: 'Bug' }, 201));
      await expect(createGitHubIssue('t', 'o', 'r', 'Bug', 'body')).resolves.toEqual({ number: 5, title: 'Bug' });
      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.github.com/repos/o/r/issues',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ title: 'Bug', body: 'body' }) }),
      );
    });

    it('createGitHubIssue throws on non-200', async () => {
      fetchMock.mockResolvedValueOnce(textResponse('bad', 422));
      await expect(createGitHubIssue('t', 'o', 'r', 'Bug', 'body')).rejects.toThrow('Failed to create issue');
    });
  });

  describe('dispatchGitHubWorkflow', () => {
    it('succeeds on 204', async () => {
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
      await expect(dispatchGitHubWorkflow('t', 'o', 'r', 7)).resolves.toEqual({ success: true });
    });

    it('succeeds on 200', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({}, 200));
      await expect(dispatchGitHubWorkflow('t', 'o', 'r', 'ci.yml', 'dev', { env: 'prod' })).resolves.toEqual({ success: true });
    });

    it('throws with the response text on failure', async () => {
      fetchMock.mockResolvedValueOnce(textResponse('workflow not found', 404));
      await expect(dispatchGitHubWorkflow('t', 'o', 'r', 'ci.yml')).rejects.toThrow('Failed to dispatch workflow: workflow not found');
    });
  });

  describe('webhook events', () => {
    it('records and lists events, defaulting unknown payload fields', () => {
      const created = recordGitHubWebhookEvent('push', {
        repository: { full_name: 'octo/hello' },
        sender: { login: 'octocat' },
        action: 'opened',
      });
      expect(created.summary).toBe('push.opened on octo/hello by @octocat');
      expect(created.id).toBeTruthy();

      const unknown = recordGitHubWebhookEvent('ping', null, false);
      expect(unknown.summary).toBe('ping.event on unknown by @unknown');

      const events = getGitHubWebhookEvents();
      expect(events).toHaveLength(2);
      const limited = getGitHubWebhookEvents(1);
      expect(limited).toHaveLength(1);
    });
  });

  describe('importGitHubRepo', () => {
    it('throws when the repo cannot be loaded', async () => {
      fetchMock.mockResolvedValueOnce(textResponse('Not Found', 404));
      await expect(importGitHubRepo(USER, 'octo', 'octo', 'missing', 'token', path.join(tmp, 'repos'))).rejects.toThrow(
        'Failed to load GitHub repository octo/missing',
      );
    });
  });

  describe('pushSyncToGitHub', () => {
    function linkRepo(): void {
      getDb().prepare(`
        INSERT INTO repositories (id, owner_id, name, full_path, default_branch)
        VALUES (?, ?, ?, ?, ?)
      `).run('repo-local', USER, 'hello', path.join(tmp, 'hello'), 'main');
      getDb().prepare(`
        INSERT INTO github_synced_repos (id, user_id, local_repo_id, github_repo_id, github_full_name, github_owner, github_name, default_branch)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run('link-1', USER, 'repo-local', 1, 'octo/hello', 'octo', 'hello', 'main');
    }

    it('returns a reason when the repository is not linked to GitHub', async () => {
      await expect(pushSyncToGitHub(USER, 'octo', 'unlinked', 'a.txt', 'x', 'msg', 'token', tmp)).resolves.toEqual({
        syncedToGitHub: false,
        reason: 'Repository is not linked to GitHub',
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('pushes a new file and records the sync', async () => {
      linkRepo();
      fetchMock
        .mockResolvedValueOnce(textResponse('missing', 404))
        .mockResolvedValueOnce(jsonResponse({ commit: { sha: 'abc' } }, 200));

      const result = await pushSyncToGitHub(USER, 'octo', 'hello', 'src/a.ts', 'content', 'My commit', 'token', tmp);
      expect(result).toEqual({ syncedToGitHub: true, commit: { commit: { sha: 'abc' } } });
      const row = getDb().prepare('SELECT sync_status FROM github_synced_repos WHERE id = ?').get('link-1') as { sync_status: string };
      expect(row.sync_status).toBe('synced');
      const putBody = JSON.parse((fetchMock.mock.calls[1][1] as { body: string }).body);
      expect(putBody).toMatchObject({ message: 'My commit', branch: 'main' });
      expect(putBody.sha).toBeUndefined();
    });

    it('includes the existing file sha when GitHub returns one', async () => {
      linkRepo();
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ sha: 'sha-existing' }, 200))
        .mockResolvedValueOnce(jsonResponse({ commit: { sha: 'def' } }, 200));

      await pushSyncToGitHub(USER, 'octo', 'hello', 'src/a.ts', 'content', '', 'token', tmp);
      const putBody = JSON.parse((fetchMock.mock.calls[1][1] as { body: string }).body);
      expect(putBody.sha).toBe('sha-existing');
      expect(putBody.message).toBe('Update src/a.ts via OpenHub');
    });

    it('throws when the push fails', async () => {
      linkRepo();
      fetchMock
        .mockResolvedValueOnce(textResponse('missing', 404))
        .mockResolvedValueOnce(textResponse('conflict', 409));
      await expect(pushSyncToGitHub(USER, 'octo', 'hello', 'src/a.ts', 'content', 'msg', 'token', tmp)).rejects.toThrow(
        'Failed to push to GitHub: conflict',
      );
    });
  });
});
