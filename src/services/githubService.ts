import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../auth/db.js';

const GITHUB_API_BASE = 'https://api.github.com';

function getHeaders(token: string): Record<string, string> {
  return {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'OpenHub-Autonomous-Platform/2.0',
  };
}

export interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string;
  email: string | null;
  bio: string | null;
  public_repos: number;
  total_private_repos?: number;
  html_url: string;
}

export interface GitHubRepoSummary {
  id: number;
  name: string;
  full_name: string;
  owner: {
    login: string;
    avatar_url: string;
  };
  private: boolean;
  html_url: string;
  description: string | null;
  fork: boolean;
  default_branch: string;
  language: string | null;
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  updated_at: string;
  pushed_at: string;
  is_imported?: boolean;
  local_repo_id?: string;
}

export function getGitHubIntegration(userId: string): {
  accessToken: string;
  githubUsername: string | null;
  githubAvatar: string | null;
  githubEmail: string | null;
  scope: string | null;
  updatedAt: string;
} | null {
  const db = getDb();
  const row: any = db.prepare(`
    SELECT access_token, github_username, github_avatar, github_email, scope, updated_at
    FROM github_integrations
    WHERE user_id = ?
  `).get(userId);

  if (!row) return null;
  return {
    accessToken: row.access_token,
    githubUsername: row.github_username,
    githubAvatar: row.github_avatar,
    githubEmail: row.github_email,
    scope: row.scope,
    updatedAt: row.updated_at,
  };
}

export function saveGitHubIntegration(
  userId: string,
  token: string,
  profile: Partial<GitHubUser>,
  scope: string = 'repo,read:user,workflow'
) {
  const db = getDb();
  const id = uuidv4();
  db.prepare(`
    INSERT INTO github_integrations (
      id, user_id, access_token, scope, github_username, github_id, github_avatar, github_email, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET
      access_token = excluded.access_token,
      scope = excluded.scope,
      github_username = excluded.github_username,
      github_id = excluded.github_id,
      github_avatar = excluded.github_avatar,
      github_email = excluded.github_email,
      updated_at = datetime('now')
  `).run(
    id,
    userId,
    token,
    scope,
    profile.login || null,
    profile.id ? String(profile.id) : null,
    profile.avatar_url || null,
    profile.email || null
  );
}

export function removeGitHubIntegration(userId: string) {
  const db = getDb();
  db.prepare('DELETE FROM github_integrations WHERE user_id = ?').run(userId);
}

export async function verifyAndFetchGitHubProfile(token: string): Promise<GitHubUser> {
  const res = await fetch(`${GITHUB_API_BASE}/user`, {
    headers: getHeaders(token),
  });

  if (!res.ok) {
    const errorText = await res.text().catch(() => '');
    throw new Error(`GitHub token verification failed (${res.status}): ${errorText || res.statusText}`);
  }

  return await res.json();
}

export async function fetchUserRepos(token: string, userId: string): Promise<GitHubRepoSummary[]> {
  const res = await fetch(`${GITHUB_API_BASE}/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator`, {
    headers: getHeaders(token),
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch GitHub repos: ${res.statusText}`);
  }

  const rawRepos: any[] = await res.json();
  const db = getDb();

  // Find repos already imported by this user
  const syncedList: any[] = db.prepare(`
    SELECT github_repo_id, local_repo_id, github_full_name
    FROM github_synced_repos
    WHERE user_id = ?
  `).all(userId);

  const syncedMap = new Map<number, string>();
  for (const item of syncedList) {
    syncedMap.set(item.github_repo_id, item.local_repo_id);
  }

  return rawRepos.map((r) => ({
    id: r.id,
    name: r.name,
    full_name: r.full_name,
    owner: {
      login: r.owner.login,
      avatar_url: r.owner.avatar_url,
    },
    private: r.private,
    html_url: r.html_url,
    description: r.description,
    fork: r.fork,
    default_branch: r.default_branch || 'main',
    language: r.language,
    stargazers_count: r.stargazers_count || 0,
    forks_count: r.forks_count || 0,
    open_issues_count: r.open_issues_count || 0,
    updated_at: r.updated_at,
    pushed_at: r.pushed_at,
    is_imported: syncedMap.has(r.id),
    local_repo_id: syncedMap.get(r.id),
  }));
}

export async function importGitHubRepo(
  userId: string,
  openhubUsername: string,
  owner: string,
  repo: string,
  token: string,
  reposRoot: string
) {
  const db = getDb();

  // 1. Fetch repo details from GitHub
  const repoRes = await fetch(`${GITHUB_API_BASE}/repos/${owner}/${repo}`, {
    headers: getHeaders(token),
  });
  if (!repoRes.ok) {
    throw new Error(`Failed to load GitHub repository ${owner}/${repo}: ${repoRes.statusText}`);
  }
  const ghRepo = await repoRes.json();
  const defaultBranch = ghRepo.default_branch || 'main';

  // 2. Prepare local directory
  const ownerDir = path.join(reposRoot, openhubUsername);
  const repoDir = path.join(ownerDir, repo);

  if (!fs.existsSync(ownerDir)) {
    fs.mkdirSync(ownerDir, { recursive: true });
  }

  // If local directory doesn't exist, create it
  if (!fs.existsSync(repoDir)) {
    fs.mkdirSync(repoDir, { recursive: true });
  }

  // 3. Fetch file tree from GitHub
  try {
    const treeRes = await fetch(`${GITHUB_API_BASE}/repos/${owner}/${repo}/git/trees/${defaultBranch}?recursive=1`, {
      headers: getHeaders(token),
    });

    if (treeRes.ok) {
      const treeData = await treeRes.json();
      const treeEntries: any[] = treeData.tree || [];

      // Download up to 50 key files initially for fast responsiveness
      const fileEntries = treeEntries.filter((e) => e.type === 'blob' && !e.path.startsWith('.git/'));
      const sampleFiles = fileEntries.slice(0, 40);

      for (const entry of sampleFiles) {
        const filePath = path.join(repoDir, entry.path);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });

        // If file is small, fetch content
        if (entry.size && entry.size < 500000) {
          try {
            const rawContentRes = await fetch(
              `https://raw.githubusercontent.com/${owner}/${repo}/${defaultBranch}/${entry.path}`,
              {
                headers: {
                  'Authorization': `Bearer ${token}`,
                  'User-Agent': 'OpenHub-Platform',
                },
              }
            );
            if (rawContentRes.ok) {
              const fileContent = await rawContentRes.text();
              fs.writeFileSync(filePath, fileContent, 'utf-8');
            }
          } catch {
            // fallback create placeholder
            if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, '', 'utf-8');
          }
        } else {
          if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, '', 'utf-8');
        }
      }
    }
  } catch (err: any) {
    console.warn(`[GitHub Import] Warning while pulling file tree: ${err.message}`);
  }

  // Ensure at least a README.md exists if tree fetch was restricted
  const readmePath = path.join(repoDir, 'README.md');
  if (!fs.existsSync(readmePath)) {
    fs.writeFileSync(
      readmePath,
      `# ${ghRepo.name}\n\n${ghRepo.description || 'Imported from GitHub into OpenHub.'}\n\n- Source: [${ghRepo.html_url}](${ghRepo.html_url})\n- Default Branch: \`${defaultBranch}\`\n`,
      'utf-8'
    );
  }

  // 4. Register in OpenHub repositories table
  let existingRepo: any = db.prepare(`
    SELECT id FROM repositories WHERE owner_id = ? AND name = ?
  `).get(userId, repo);

  let localRepoId = existingRepo?.id;

  if (!localRepoId) {
    localRepoId = uuidv4();
    db.prepare(`
      INSERT INTO repositories (id, owner_id, name, description, full_path, is_private, default_branch, language)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      localRepoId,
      userId,
      repo,
      ghRepo.description || '',
      repoDir,
      ghRepo.private ? 1 : 0,
      defaultBranch,
      ghRepo.language || 'TypeScript'
    );
  }

  // 5. Register in github_synced_repos
  const syncId = uuidv4();
  db.prepare(`
    INSERT INTO github_synced_repos (
      id, user_id, local_repo_id, github_repo_id, github_full_name, github_owner, github_name, default_branch, last_synced_at, sync_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), 'synced')
    ON CONFLICT(id) DO NOTHING
  `).run(
    syncId,
    userId,
    localRepoId,
    ghRepo.id,
    ghRepo.full_name,
    owner,
    repo,
    defaultBranch
  );

  return {
    id: localRepoId,
    name: repo,
    owner_id: userId,
    owner_name: openhubUsername,
    github_full_name: ghRepo.full_name,
    github_url: ghRepo.html_url,
    description: ghRepo.description,
    full_path: repoDir,
    default_branch: defaultBranch,
    is_private: ghRepo.private ? 1 : 0,
    language: ghRepo.language,
  };
}

export async function pushSyncToGitHub(
  userId: string,
  openhubUsername: string,
  repoName: string,
  filePath: string,
  content: string,
  message: string,
  token: string,
  reposRoot: string
) {
  const db = getDb();

  // Find linked GitHub repo
  const syncEntry: any = db.prepare(`
    SELECT g.*
    FROM github_synced_repos g
    JOIN repositories r ON g.local_repo_id = r.id
    WHERE g.user_id = ? AND r.name = ?
  `).get(userId, repoName);

  if (!syncEntry) {
    return { syncedToGitHub: false, reason: 'Repository is not linked to GitHub' };
  }

  // Check if file exists on GitHub to get SHA
  let fileSha: string | undefined;
  try {
    const getRes = await fetch(
      `${GITHUB_API_BASE}/repos/${syncEntry.github_owner}/${syncEntry.github_name}/contents/${filePath}`,
      { headers: getHeaders(token) }
    );
    if (getRes.ok) {
      const fileData = await getRes.json();
      fileSha = fileData.sha;
    }
  } catch {
    // New file
  }

  const putRes = await fetch(
    `${GITHUB_API_BASE}/repos/${syncEntry.github_owner}/${syncEntry.github_name}/contents/${filePath}`,
    {
      method: 'PUT',
      headers: getHeaders(token),
      body: JSON.stringify({
        message: message || `Update ${filePath} via OpenHub`,
        content: Buffer.from(content).toString('base64'),
        branch: syncEntry.default_branch || 'main',
        sha: fileSha,
      }),
    }
  );

  if (!putRes.ok) {
    const err = await putRes.text();
    throw new Error(`Failed to push to GitHub: ${err}`);
  }

  db.prepare(`
    UPDATE github_synced_repos
    SET last_synced_at = datetime('now'), sync_status = 'synced'
    WHERE id = ?
  `).run(syncEntry.id);

  return { syncedToGitHub: true, commit: await putRes.json() };
}

export async function fetchGitHubIssues(token: string, owner: string, repo: string) {
  const res = await fetch(`${GITHUB_API_BASE}/repos/${owner}/${repo}/issues?state=all&per_page=30`, {
    headers: getHeaders(token),
  });
  if (!res.ok) throw new Error(`Failed to fetch issues: ${res.statusText}`);
  return await res.json();
}

export async function createGitHubIssue(token: string, owner: string, repo: string, title: string, body: string) {
  const res = await fetch(`${GITHUB_API_BASE}/repos/${owner}/${repo}/issues`, {
    method: 'POST',
    headers: getHeaders(token),
    body: JSON.stringify({ title, body }),
  });
  if (!res.ok) throw new Error(`Failed to create issue: ${res.statusText}`);
  return await res.json();
}

export async function fetchGitHubPulls(token: string, owner: string, repo: string) {
  const res = await fetch(`${GITHUB_API_BASE}/repos/${owner}/${repo}/pulls?state=all&per_page=30`, {
    headers: getHeaders(token),
  });
  if (!res.ok) throw new Error(`Failed to fetch PRs: ${res.statusText}`);
  return await res.json();
}

export async function fetchGitHubWorkflows(token: string, owner: string, repo: string) {
  const res = await fetch(`${GITHUB_API_BASE}/repos/${owner}/${repo}/actions/workflows`, {
    headers: getHeaders(token),
  });
  if (!res.ok) throw new Error(`Failed to fetch workflows: ${res.statusText}`);
  return await res.json();
}

export async function fetchGitHubWorkflowRuns(token: string, owner: string, repo: string) {
  const res = await fetch(`${GITHUB_API_BASE}/repos/${owner}/${repo}/actions/runs?per_page=20`, {
    headers: getHeaders(token),
  });
  if (!res.ok) throw new Error(`Failed to fetch workflow runs: ${res.statusText}`);
  return await res.json();
}

export async function dispatchGitHubWorkflow(
  token: string,
  owner: string,
  repo: string,
  workflowId: string | number,
  ref: string = 'main',
  inputs: Record<string, any> = {}
) {
  const res = await fetch(`${GITHUB_API_BASE}/repos/${owner}/${repo}/actions/workflows/${workflowId}/dispatches`, {
    method: 'POST',
    headers: getHeaders(token),
    body: JSON.stringify({ ref, inputs }),
  });
  if (!res.ok && res.status !== 204) {
    const msg = await res.text();
    throw new Error(`Failed to dispatch workflow: ${msg || res.statusText}`);
  }
  return { success: true };
}

export function recordGitHubWebhookEvent(event: string, payload: any, signatureValid: boolean = true) {
  const db = getDb();
  const id = uuidv4();
  const repoFullName = payload?.repository?.full_name || 'unknown';
  const sender = payload?.sender?.login || 'unknown';
  const action = payload?.action || 'event';
  const summary = `${event}.${action} on ${repoFullName} by @${sender}`;

  db.prepare(`
    INSERT INTO github_webhook_events (id, event_type, repo_full_name, sender, action, summary, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    event,
    repoFullName,
    sender,
    action,
    summary,
    JSON.stringify(payload)
  );

  return { id, summary };
}

export function getGitHubWebhookEvents(limit: number = 30) {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM github_webhook_events
    ORDER BY created_at DESC
    LIMIT ?
  `).all(limit);
}
