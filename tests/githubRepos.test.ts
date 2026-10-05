import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  fetchAccountRepos,
  syncFleetRepos,
  listFleetRepos,
  repoIndexSummary,
  FLEET_ACCOUNTS,
} from '../src/services/githubRepos';
import { getDb, closeDb, initializeDatabase } from '../src/auth/db';

function startMockGitHub(handler: (req: http.IncomingMessage) => { status: number; body: unknown }) {
  return new Promise<{ server: http.Server; base: string; close: () => Promise<void> }>((resolve) => {
    const server = http.createServer((req, res) => {
      const { status, body } = handler(req);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        server,
        base: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

const repo = (full_name: string, over: Record<string, unknown> = {}) => ({
  full_name,
  owner: { login: full_name.split('/')[0] },
  name: full_name.split('/')[1],
  private: false,
  visibility: 'public',
  archived: false,
  fork: false,
  pushed_at: '2026-09-13T00:00:00Z',
  updated_at: '2026-09-13T00:00:00Z',
  description: 'desc',
  language: 'TypeScript',
  default_branch: 'main',
  open_issues_count: 2,
  stargazers_count: 7,
  ...over,
});

describe('githubRepos (fleet repo awareness)', () => {
  describe('fetchAccountRepos', () => {
    it('parses a repo payload and includes private repos for the authenticated account', async () => {
      const { base, close } = await startMockGitHub((req) => {
        if (req.url === '/user') return { status: 200, body: { login: 'ncsound919' } };
        expect(req.url).toContain('/user/repos'); // self → private-inclusive endpoint
        return { status: 200, body: [repo('ncsound919/axiom-agent', { private: true, visibility: 'private' })] };
      });
      try {
        const repos = await fetchAccountRepos('ncsound919', 'tok', { OPENHUB_GITHUB_API_BASE: base });
        expect(repos).toHaveLength(1);
        expect(repos[0]).toMatchObject({
          fullName: 'ncsound919/axiom-agent',
          owner: 'ncsound919',
          visibility: 'private',
          language: 'TypeScript',
          openIssues: 2,
          stargazers: 7,
        });
      } finally {
        await close();
      }
    });

    it('uses /users/{login}/repos (public only) for a non-authenticated account', async () => {
      const seen: string[] = [];
      const { base, close } = await startMockGitHub((req) => {
        seen.push(req.url ?? '');
        if (req.url === '/user') return { status: 200, body: { login: 'ncsound919' } };
        return { status: 200, body: [repo('tap919/gamma')] };
      });
      try {
        const repos = await fetchAccountRepos('tap919', 'tok', { OPENHUB_GITHUB_API_BASE: base });
        expect(repos).toHaveLength(1);
        expect(seen.some((u) => u.includes('/users/tap919/repos'))).toBe(true);
        expect(seen.some((u) => u.includes('/user/repos'))).toBe(false);
      } finally {
        await close();
      }
    });

    it('sends a bearer token when provided', async () => {
      let auth: string | undefined;
      const { base, close } = await startMockGitHub((req) => {
        auth = req.headers.authorization;
        if (req.url === '/user') return { status: 200, body: { login: 'tap919' } };
        return { status: 200, body: [] };
      });
      try {
        await fetchAccountRepos('tap919', 'secret-token', { OPENHUB_GITHUB_API_BASE: base });
        expect(auth).toBe('Bearer secret-token');
      } finally {
        await close();
      }
    });

    it('paginates until a short final page', async () => {
      let calls = 0;
      const { base, close } = await startMockGitHub((req) => {
        calls += 1;
        // page 1 returns 100 (full page), page 2 returns 3 (last page)
        const n = calls === 1 ? 100 : 3;
        return { status: 200, body: Array.from({ length: n }, (_, i) => repo(`acct/repo-${calls}-${i}`)) };
      });
      try {
        const repos = await fetchAccountRepos('acct', null, { OPENHUB_GITHUB_API_BASE: base });
        expect(repos).toHaveLength(103);
        expect(calls).toBe(2);
      } finally {
        await close();
      }
    });

    it('throws an explicit error on a non-2xx response', async () => {
      const { base, close } = await startMockGitHub(() => ({ status: 403, body: { message: 'rate limited' } }));
      try {
        await expect(fetchAccountRepos('acct', null, { OPENHUB_GITHUB_API_BASE: base })).rejects.toThrow(/403/);
      } finally {
        await close();
      }
    });
  });

  describe('syncFleetRepos + listFleetRepos (hermetic DB)', () => {
    let tmp: string;
    let mock: { base: string; close: () => Promise<void> };
    // Hermetic vault: these tests exercise the *unauthenticated* public path, so
    // point Keywire at an unreachable port rather than the live vault.
    const noVault = { OPENHUB_KEYWIRE_URL: 'http://127.0.0.1:1' };

    beforeEach(async () => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'github-repos-'));
      process.env.OPENHUB_DB_PATH = path.join(tmp, 'test.db');
      mock = await startMockGitHub((req) => {
        const url = req.url ?? '';
        if (url.includes('/users/ncsound919/repos')) {
          return { status: 200, body: [repo('ncsound919/alpha'), repo('ncsound919/beta', { archived: true })] };
        }
        if (url.includes('/users/tap919/repos')) {
          return { status: 200, body: [repo('tap919/gamma')] };
        }
        return { status: 404, body: { message: 'not found' } };
      });
      // fresh DB for this test
      closeDb();
      initializeDatabase();
    });

    afterEach(async () => {
      await mock.close();
      closeDb();
      delete process.env.OPENHUB_DB_PATH;
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    it('syncs both accounts and reads back the snapshot', async () => {
      const result = await syncFleetRepos({ OPENHUB_GITHUB_API_BASE: mock.base, ...noVault });
      expect(result.total).toBe(3);
      expect(result.accounts.find((a) => a.owner === 'ncsound919')?.count).toBe(2);
      expect(result.accounts.find((a) => a.owner === 'tap919')?.count).toBe(1);

      const all = listFleetRepos({});
      expect(all).toHaveLength(3);
      expect(repoIndexSummary().byAccount).toEqual({ ncsound919: 2, tap919: 1 });
      expect(repoIndexSummary().total).toBe(3);
    });

    it('filters by account, visibility, and search', async () => {
      await syncFleetRepos({ OPENHUB_GITHUB_API_BASE: mock.base, ...noVault });
      expect(listFleetRepos({ account: 'tap919' })).toHaveLength(1);
      expect(listFleetRepos({ search: 'gam' })).toHaveLength(1);
      expect(listFleetRepos({ search: 'gam' })[0].name).toBe('gamma');
      // archived repo is still listed (state awareness)
      expect(listFleetRepos({ account: 'ncsound919' }).filter((r) => r.archived)).toHaveLength(1);
    });

    it('records per-account errors without throwing', async () => {
      const failing = await startMockGitHub(() => ({ status: 500, body: { message: 'boom' } }));
      try {
        const result = await syncFleetRepos({ OPENHUB_GITHUB_API_BASE: failing.base, ...noVault });
        expect(FLEET_ACCOUNTS.every((a) => result.accounts.find((x) => x.owner === a)?.error)).toBe(true);
        expect(result.total).toBe(0);
      } finally {
        await failing.close();
      }
    });

    it('getDb honors OPENHUB_DB_PATH (hermetic)', () => {
      const db = getDb();
      expect(db.name).toContain('test.db');
    });
  });
});