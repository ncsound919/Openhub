import { getDb } from '../auth/db.js';
import { resolveSecret } from './keywire.js';

/**
 * Fleet GitHub repo awareness (ncsound919 + tap919), staying current.
 *
 * Pulls the operator's full repo listing for both accounts, persists a local
 * index (so the UI/agents read a snapshot that stays current between syncs),
 * and supports on-demand re-sync. Real GitHub API only; no fabricated repo data.
 *
 * Token resolution (per the fleet credential gate): `resolveSecret('GITHUB_TOKEN')`
 * = env `GITHUB_TOKEN`/`OPENHUB_SECRET_GITHUB_TOKEN` → Keywire → file fallback.
 * Without a token, only PUBLIC repos are visible (and unauthenticated rate
 * limits apply); private `ncsound919` repos need a token, and `tap919` private
 * repos are only visible with a `tap919` token (not available to this account).
 */

export const FLEET_ACCOUNTS = ['ncsound919', 'tap919'] as const;

export interface FleetRepo {
  fullName: string;
  owner: string;
  name: string;
  visibility: 'public' | 'private' | 'internal';
  archived: boolean;
  fork: boolean;
  pushedAt: string | null;
  updatedAt: string | null;
  description: string | null;
  language: string | null;
  defaultBranch: string | null;
  openIssues: number;
  stargazers: number;
}

interface GitHubRepoPayload {
  full_name?: string;
  owner?: { login?: string };
  name?: string;
  private?: boolean;
  visibility?: string;
  archived?: boolean;
  fork?: boolean;
  pushed_at?: string | null;
  updated_at?: string | null;
  description?: string | null;
  language?: string | null;
  default_branch?: string | null;
  open_issues_count?: number;
  stargazers_count?: number;
}

const GITHUB_API = 'https://api.github.com';
const PER_PAGE = 100;
const USER_AGENT = 'OpenHub-fleet';

/** Resolve the authenticated login for a token (so private repos of the token owner are included). */
async function authenticatedLogin(token: string, env: NodeJS.ProcessEnv): Promise<string> {
  const base = env.OPENHUB_GITHUB_API_BASE || GITHUB_API;
  const res = await fetch(`${base}/user`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': USER_AGENT,
      Authorization: `Bearer ${token}`,
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub /user ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as { login?: string };
  if (!json.login) throw new Error('GitHub /user response missing login');
  return json.login;
}

function normalizeVisibility(raw: string | undefined, isPrivate: boolean): FleetRepo['visibility'] {
  if (raw === 'private' || raw === 'internal') return raw;
  return isPrivate ? 'private' : 'public';
}

/**
 * Fetch one account's repos (all pages). Uses a bearer token when provided so
 * private repos of the authenticated account are included.
 */
export async function fetchAccountRepos(
  login: string,
  token?: string | null,
  env: NodeJS.ProcessEnv = process.env,
): Promise<FleetRepo[]> {
  const base = env.OPENHUB_GITHUB_API_BASE || GITHUB_API;
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': USER_AGENT,
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  // Self (the authenticated account) → /user/repos includes private repos;
  // any other account → /users/{login}/repos (public only, unless a token for
  // that account is supplied).
  let listPath: string;
  if (token) {
    const authed = await authenticatedLogin(token, env);
    listPath = authed === login
      ? '/user/repos'
      : `/users/${encodeURIComponent(login)}/repos`;
  } else {
    listPath = `/users/${encodeURIComponent(login)}/repos`;
  }

  const out: FleetRepo[] = [];
  let page = 1;
  for (;;) {
    const url = `${base}${listPath}?per_page=${PER_PAGE}&sort=pushed&direction=desc&page=${page}`;
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`GitHub API ${res.status} for ${login} page ${page}: ${body.slice(0, 200)}`);
    }
    const json = (await res.json()) as GitHubRepoPayload[];
    for (const r of json) {
      if (!r.full_name || !r.name) continue;
      out.push({
        fullName: r.full_name,
        owner: r.owner?.login ?? login,
        name: r.name,
        visibility: normalizeVisibility(r.visibility, !!r.private),
        archived: !!r.archived,
        fork: !!r.fork,
        pushedAt: r.pushed_at ?? null,
        updatedAt: r.updated_at ?? null,
        description: r.description ?? null,
        language: r.language ?? null,
        defaultBranch: r.default_branch ?? null,
        openIssues: r.open_issues_count ?? 0,
        stargazers: r.stargazers_count ?? 0,
      });
    }
    if (json.length < PER_PAGE) break; // last page
    page += 1;
  }
  return out;
}

function upsertRepos(repos: FleetRepo[], syncedAt: string): void {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO github_repo_index
      (full_name, owner, name, visibility, archived, fork, pushed_at, updated_at,
       description, language, default_branch, open_issues, stargazers, synced_at)
    VALUES
      (@fullName, @owner, @name, @visibility, @archived, @fork, @pushedAt, @updatedAt,
       @description, @language, @defaultBranch, @openIssues, @stargazers, @syncedAt)
    ON CONFLICT(full_name) DO UPDATE SET
      visibility = excluded.visibility,
      archived = excluded.archived,
      fork = excluded.fork,
      pushed_at = excluded.pushed_at,
      updated_at = excluded.updated_at,
      description = excluded.description,
      language = excluded.language,
      default_branch = excluded.default_branch,
      open_issues = excluded.open_issues,
      stargazers = excluded.stargazers,
      synced_at = excluded.synced_at
  `);
  const tx = db.transaction((items: FleetRepo[]) => {
    for (const r of items) {
      stmt.run({ ...r, archived: r.archived ? 1 : 0, fork: r.fork ? 1 : 0, syncedAt });
    }
  });
  tx(repos);
}

export interface FleetSyncResult {
  syncedAt: string;
  accounts: Array<{ owner: string; count: number; error?: string }>;
  total: number;
}

/** Fetch + index both fleet accounts. Never throws — per-account failures are recorded. */
export async function syncFleetRepos(env: NodeJS.ProcessEnv = process.env): Promise<FleetSyncResult> {
  const { value: token } = await resolveSecret('GITHUB_TOKEN', env);
  const syncedAt = new Date().toISOString();
  const accounts: FleetSyncResult['accounts'] = [];

  for (const login of FLEET_ACCOUNTS) {
    try {
      const repos = await fetchAccountRepos(login, token, env);
      upsertRepos(repos, syncedAt);
      accounts.push({ owner: login, count: repos.length });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      accounts.push({ owner: login, count: 0, error: message });
    }
  }

  return {
    syncedAt,
    accounts,
    total: accounts.reduce((n, a) => n + a.count, 0),
  };
}

export interface FleetRepoQuery {
  account?: string;
  search?: string;
  visibility?: 'public' | 'private' | 'internal';
  limit?: number;
}

/** Read the persisted index (snapshot) — no network. */
export function listFleetRepos(query: FleetRepoQuery = {}): FleetRepo[] {
  const db = getDb();
  const clauses: string[] = [];
  const params: Record<string, string | number> = {};

  if (query.account) {
    clauses.push('owner = @account');
    params.account = query.account;
  }
  if (query.visibility) {
    clauses.push('visibility = @visibility');
    params.visibility = query.visibility;
  }
  if (query.search) {
    clauses.push('(name LIKE @search OR description LIKE @search)');
    params.search = `%${query.search}%`;
  }

  const limit = Math.min(500, Math.max(1, query.limit ?? 500));
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db
    .prepare(
      `SELECT * FROM github_repo_index ${where} ORDER BY pushed_at DESC LIMIT ${limit}`,
    )
    .all(params as Record<string, unknown>) as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    fullName: String(r.full_name),
    owner: String(r.owner),
    name: String(r.name),
    visibility: r.visibility as FleetRepo['visibility'],
    archived: !!r.archived,
    fork: !!r.fork,
    pushedAt: (r.pushed_at as string | null) ?? null,
    updatedAt: (r.updated_at as string | null) ?? null,
    description: (r.description as string | null) ?? null,
    language: (r.language as string | null) ?? null,
    defaultBranch: (r.default_branch as string | null) ?? null,
    openIssues: Number(r.open_issues ?? 0),
    stargazers: Number(r.stargazers ?? 0),
  }));
}

/** Count of indexed repos per account (for dashboards). */
export function repoIndexSummary(): { byAccount: Record<string, number>; total: number; lastSync: string | null } {
  const db = getDb();
  const rows = db.prepare('SELECT owner, COUNT(*) AS n FROM github_repo_index GROUP BY owner').all() as Array<{ owner: string; n: number }>;
  const last = db.prepare('SELECT MAX(synced_at) AS s FROM github_repo_index').get() as { s: string | null };
  const byAccount: Record<string, number> = {};
  let total = 0;
  for (const r of rows) {
    byAccount[r.owner] = r.n;
    total += r.n;
  }
  return { byAccount, total, lastSync: last?.s ?? null };
}
