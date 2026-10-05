import fs from 'node:fs';
import { getDb } from '../auth/db.js';

export interface ActiveProjectContext {
  repoId: string;
  path: string;
  selectedAt: string;
  repositoryName: string;
  githubFullName: string | null;
  defaultBranch: string | null;
}

export type ProjectContextErrorCode =
  | 'INVALID_REPOSITORY'
  | 'REPOSITORY_NOT_FOUND'
  | 'REPOSITORY_PATH_INVALID'
  | 'ACTIVE_PROJECT_EXISTS'
  | 'NO_ACTIVE_PROJECT';

type ProjectContextFailureCode = Exclude<ProjectContextErrorCode, 'ACTIVE_PROJECT_EXISTS'>;

export interface ProjectContextError {
  ok: false;
  code: ProjectContextFailureCode;
  error: string;
}

export interface SelectActiveProjectSuccess {
  ok: true;
  project: ActiveProjectContext;
}

export interface ActiveProjectExistsError {
  ok: false;
  code: 'ACTIVE_PROJECT_EXISTS';
  error: string;
  active: ActiveProjectContext;
}

export type SelectActiveProjectResult =
  | SelectActiveProjectSuccess
  | ProjectContextError
  | ActiveProjectExistsError;

export interface UnloadActiveProjectSuccess {
  ok: true;
  project: ActiveProjectContext;
}

export type UnloadActiveProjectResult = UnloadActiveProjectSuccess | ProjectContextError;

interface ActiveProjectRow {
  repo_id: string;
  path: string;
  selected_at: string;
  repository_name: string;
  github_full_name: string | null;
  default_branch: string | null;
}

interface RepositoryRow {
  id: string;
  full_path: string;
}

function ensureProjectContextTable(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS active_project_context (
      user_id TEXT PRIMARY KEY,
      repo_id TEXT NOT NULL,
      path TEXT NOT NULL,
      selected_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (repo_id) REFERENCES repositories(id) ON DELETE CASCADE
    );
  `);
}

function isNonEmptyString(value: string): boolean {
  return value.trim().length > 0;
}

function toActiveProject(row: ActiveProjectRow): ActiveProjectContext {
  return {
    repoId: row.repo_id,
    path: row.path,
    selectedAt: row.selected_at,
    repositoryName: row.repository_name,
    githubFullName: row.github_full_name,
    defaultBranch: row.default_branch,
  };
}

function findActiveProject(userId: string): ActiveProjectContext | null {
  const row = getDb().prepare(`
    SELECT
      context.repo_id,
      context.path,
      context.selected_at,
      repository.name AS repository_name,
      (
        SELECT synced.github_full_name
        FROM github_synced_repos AS synced
        WHERE synced.user_id = context.user_id
          AND synced.local_repo_id = context.repo_id
        ORDER BY synced.last_synced_at DESC, synced.created_at DESC
        LIMIT 1
      ) AS github_full_name,
      COALESCE(
        (
          SELECT synced.default_branch
          FROM github_synced_repos AS synced
          WHERE synced.user_id = context.user_id
            AND synced.local_repo_id = context.repo_id
          ORDER BY synced.last_synced_at DESC, synced.created_at DESC
          LIMIT 1
        ),
        repository.default_branch
      ) AS default_branch
    FROM active_project_context AS context
    JOIN repositories AS repository ON repository.id = context.repo_id
    WHERE context.user_id = ?
  `).get(userId) as ActiveProjectRow | undefined;

  return row ? toActiveProject(row) : null;
}

/** Return the authenticated user's persisted active project, if one is selected. */
export function getActiveProject(userId: string): ActiveProjectContext | null {
  ensureProjectContextTable();
  if (!isNonEmptyString(userId)) return null;
  return findActiveProject(userId);
}

/**
 * Persist an owned, on-disk repository as the user's active project.
 * An existing selection is intentionally never replaced; callers must unload it first.
 */
export function selectActiveProject(userId: string, repoId: string): SelectActiveProjectResult {
  if (!isNonEmptyString(userId) || !isNonEmptyString(repoId)) {
    return {
      ok: false,
      code: 'INVALID_REPOSITORY',
      error: 'repoId must be a non-empty string',
    };
  }

  ensureProjectContextTable();
  const db = getDb();

  const select = db.transaction((): SelectActiveProjectResult => {
    const active = findActiveProject(userId);
    if (active) {
      if (active.repoId === repoId) return { ok: true, project: active };
      return {
        ok: false,
        code: 'ACTIVE_PROJECT_EXISTS',
        error: 'Unload the current active project before selecting another repository',
        active,
      };
    }

    const repository = db.prepare(`
      SELECT id, full_path
      FROM repositories
      WHERE id = ? AND owner_id = ?
    `).get(repoId, userId) as RepositoryRow | undefined;

    // Treat a repository owned by someone else exactly like a missing one so its
    // existence is not disclosed to the requesting user.
    if (!repository) {
      return {
        ok: false,
        code: 'REPOSITORY_NOT_FOUND',
        error: 'Repository not found for the authenticated user',
      };
    }

    let isDirectory = false;
    try {
      isDirectory = fs.statSync(repository.full_path).isDirectory();
    } catch {
      isDirectory = false;
    }
    if (!isDirectory) {
      return {
        ok: false,
        code: 'REPOSITORY_PATH_INVALID',
        error: 'Repository path must exist and be a directory',
      };
    }

    const selectedAt = new Date().toISOString();
    db.prepare(`
      INSERT INTO active_project_context (user_id, repo_id, path, selected_at)
      VALUES (?, ?, ?, ?)
    `).run(userId, repository.id, repository.full_path, selectedAt);

    const project = findActiveProject(userId);
    if (!project) throw new Error('Active project could not be read after selection');
    return { ok: true, project };
  });

  return select();
}

/** Remove the authenticated user's active project selection. */
export function unloadActiveProject(userId: string): UnloadActiveProjectResult {
  if (!isNonEmptyString(userId)) {
    return {
      ok: false,
      code: 'NO_ACTIVE_PROJECT',
      error: 'No active project selected',
    };
  }

  ensureProjectContextTable();
  const db = getDb();

  const unload = db.transaction((): UnloadActiveProjectResult => {
    const project = findActiveProject(userId);
    if (!project) {
      return {
        ok: false,
        code: 'NO_ACTIVE_PROJECT',
        error: 'No active project selected',
      };
    }

    db.prepare('DELETE FROM active_project_context WHERE user_id = ?').run(userId);
    return { ok: true, project };
  });

  return unload();
}
