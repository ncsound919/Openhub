import fs from 'node:fs';
import path from 'node:path';
import { Router, type Request, type RequestHandler } from 'express';
import { isSubpath } from '../lib/pathGuard.js';
import { commitProject, pushProject, readProjectDrift, readProjectGitState } from '../services/projectGit.js';
import { saveProjectStatus, readProjectStatus, buildProjectStatusSnapshot, STATUS_FILE_PATH } from '../services/projectStatus.js';
import {
  getActiveProject,
  selectActiveProject,
  unloadActiveProject,
} from '../services/projectContext.js';

function getAuthenticatedUserId(req: Request): string | null {
  const user = req.user as unknown as { sub?: unknown } | undefined;
  return typeof user?.sub === 'string' && user.sub.trim() !== '' ? user.sub : null;
}

function activeProjectForRequest(req: Request): { ok: true; path: string } | { ok: false; status: number; error: string } {
  const userId = getAuthenticatedUserId(req);
  if (!userId) return { ok: false, status: 401, error: 'Authentication required' };
  const project = getActiveProject(userId);
  if (!project) return { ok: false, status: 409, error: 'Load a project before accessing workspace files' };
  try {
    if (!fs.statSync(project.path).isDirectory()) return { ok: false, status: 409, error: 'The active project path is no longer a directory' };
  } catch {
    return { ok: false, status: 409, error: 'The active project path no longer exists' };
  }
  return { ok: true, path: project.path };
}

/** Path segments a project write must never touch: git internals (hooks are
 *  code), dependency/build output, and test artifacts. Reads stay permissive so
 *  the explorer can still show them; writes do not. */
const PROTECTED_WRITE_SEGMENTS = new Set(['.git', 'node_modules', 'dist', 'coverage', '.e2e', 'test-results']);

function realpathOfNearestExisting(target: string): string | null {
  let probe = target;
  for (;;) {
    try {
      return fs.realpathSync.native(probe);
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) return null;
      probe = parent;
    }
  }
}

function resolveProjectFile(
  root: string,
  requestedPath: unknown,
  opts: { write?: boolean } = {},
): { ok: true; path: string; relativePath: string } | { ok: false; error: string } {
  if (typeof requestedPath !== 'string') return { ok: false, error: 'path must be a string' };
  const relativePath = requestedPath.replace(/\\/g, '/').replace(/^\/+/, '');
  const segments = relativePath.split('/');
  if (opts.write && segments.some((s) => PROTECTED_WRITE_SEGMENTS.has(s))) {
    return { ok: false, error: 'Refusing to write to a protected path' };
  }
  const fullPath = path.resolve(root, relativePath);
  if (!isSubpath(root, fullPath)) return { ok: false, error: 'Path traversal denied' };
  // `path.resolve` is lexical: a symlink inside the project can point outside
  // it. Re-check against the real path of the nearest existing ancestor.
  const rootReal = realpathOfNearestExisting(root) ?? path.resolve(root);
  const targetReal = realpathOfNearestExisting(fullPath);
  if (targetReal && targetReal !== rootReal && !targetReal.startsWith(rootReal + path.sep)) {
    return { ok: false, error: 'Path traversal denied' };
  }
  return { ok: true, path: fullPath, relativePath };
}

/**
 * Active project context routes. Mount at `/api` to expose:
 * GET, POST, and DELETE `/api/project/active`.
 */
export function createProjectContextRouter(deps: { authMiddleware: RequestHandler }): Router {
  const router = Router();
  router.use(deps.authMiddleware);

  router.get('/project/active', (req, res) => {
    const userId = getAuthenticatedUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: 'Authentication required' });

    const project = getActiveProject(userId);
    if (!project) {
      return res.status(404).json({
        ok: false,
        code: 'NO_ACTIVE_PROJECT',
        error: 'No active project selected',
      });
    }

    return res.status(200).json({ ok: true, project });
  });

  router.post('/project/active', (req, res) => {
    const userId = getAuthenticatedUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: 'Authentication required' });

    const repoId = (req.body as { repoId?: unknown } | undefined)?.repoId;
    if (typeof repoId !== 'string' || repoId.trim() === '') {
      return res.status(400).json({
        ok: false,
        code: 'INVALID_REPOSITORY',
        error: 'repoId must be a non-empty string',
      });
    }

    const result = selectActiveProject(userId, repoId);
    if (!result.ok) {
      const status = result.code === 'ACTIVE_PROJECT_EXISTS' ? 409 : 400;
      return res.status(status).json(result);
    }

    return res.status(200).json(result);
  });

  router.get('/project/active/contents', (req, res) => {
    const active = activeProjectForRequest(req);
    if (!active.ok) return res.status(active.status).json({ ok: false, error: active.error });
    const resolved = resolveProjectFile(active.path, req.query.path ?? '');
    if (!resolved.ok) return res.status(400).json({ ok: false, error: resolved.error });
    if (!fs.existsSync(resolved.path)) return res.status(404).json({ ok: false, error: 'Path not found' });
    try {
      const stat = fs.statSync(resolved.path);
      if (stat.isFile()) {
        return res.json({ ok: true, type: 'file', name: path.basename(resolved.path), path: resolved.relativePath, content: fs.readFileSync(resolved.path, 'utf8'), size: stat.size, language: path.extname(resolved.path).slice(1) || 'text' });
      }
      const entries = fs.readdirSync(resolved.path, { withFileTypes: true })
        .filter((entry) => !['.git', 'node_modules', 'dist', 'coverage'].includes(entry.name))
        .map((entry) => ({
          name: entry.name,
          type: entry.isDirectory() ? 'dir' : 'file',
          path: resolved.relativePath ? `${resolved.relativePath}/${entry.name}` : entry.name,
          size: entry.isFile() ? fs.statSync(path.join(resolved.path, entry.name)).size : 0,
        }));
      return res.json({ ok: true, type: 'dir', path: resolved.relativePath, entries });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.put('/project/active/contents', (req, res) => {
    const active = activeProjectForRequest(req);
    if (!active.ok) return res.status(active.status).json({ ok: false, error: active.error });
    const resolved = resolveProjectFile(active.path, req.body?.path, { write: true });
    if (!resolved.ok) return res.status(400).json({ ok: false, error: resolved.error });
    if (typeof req.body?.content !== 'string') return res.status(400).json({ ok: false, error: 'content must be a string' });
    try {
      if (fs.existsSync(resolved.path) && fs.statSync(resolved.path).isDirectory()) {
        return res.status(409).json({ ok: false, error: 'Cannot overwrite a directory' });
      }
      fs.mkdirSync(path.dirname(resolved.path), { recursive: true });
      fs.writeFileSync(resolved.path, req.body.content, 'utf8');
      return res.json({ ok: true, path: resolved.relativePath, bytes: Buffer.byteLength(req.body.content, 'utf8') });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Create a new file (optionally with initial content). Protected paths
  // (git/node_modules/…) and traversal or symlink escapes are refused by the
  // same guard the write route uses.
  router.post('/project/active/file', (req, res) => {
    const active = activeProjectForRequest(req);
    if (!active.ok) return res.status(active.status).json({ ok: false, error: active.error });
    const resolved = resolveProjectFile(active.path, req.body?.path, { write: true });
    if (!resolved.ok) return res.status(400).json({ ok: false, error: resolved.error });
    const content = typeof req.body?.content === 'string' ? req.body.content : '';
    try {
      if (fs.existsSync(resolved.path)) return res.status(409).json({ ok: false, error: 'A file already exists at that path' });
      fs.mkdirSync(path.dirname(resolved.path), { recursive: true });
      fs.writeFileSync(resolved.path, content, 'utf8');
      return res.json({ ok: true, path: resolved.relativePath, bytes: Buffer.byteLength(content, 'utf8') });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Rename / move a file inside the project.
  router.post('/project/active/file/rename', (req, res) => {
    const active = activeProjectForRequest(req);
    if (!active.ok) return res.status(active.status).json({ ok: false, error: active.error });
    const from = resolveProjectFile(active.path, req.body?.from, { write: true });
    if (!from.ok) return res.status(400).json({ ok: false, error: from.error });
    const to = resolveProjectFile(active.path, req.body?.to, { write: true });
    if (!to.ok) return res.status(400).json({ ok: false, error: to.error });
    try {
      if (!fs.existsSync(from.path)) return res.status(404).json({ ok: false, error: 'Source path not found' });
      if (fs.statSync(from.path).isDirectory()) return res.status(409).json({ ok: false, error: 'Renaming directories is not supported here' });
      if (fs.existsSync(to.path)) return res.status(409).json({ ok: false, error: 'A file already exists at the destination' });
      fs.mkdirSync(path.dirname(to.path), { recursive: true });
      fs.renameSync(from.path, to.path);
      return res.json({ ok: true, from: from.relativePath, to: to.relativePath });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Delete a file. Files only — directory deletion is intentionally not exposed
  // from the editor surface.
  router.delete('/project/active/file', (req, res) => {
    const active = activeProjectForRequest(req);
    if (!active.ok) return res.status(active.status).json({ ok: false, error: active.error });
    const resolved = resolveProjectFile(active.path, req.query.path, { write: true });
    if (!resolved.ok) return res.status(400).json({ ok: false, error: resolved.error });
    try {
      if (!fs.existsSync(resolved.path)) return res.status(404).json({ ok: false, error: 'Path not found' });
      if (fs.statSync(resolved.path).isDirectory()) return res.status(409).json({ ok: false, error: 'Deleting directories is not supported here' });
      fs.rmSync(resolved.path, { force: true });
      return res.json({ ok: true, path: resolved.relativePath });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/project/active/git', async (req, res) => {    const active = activeProjectForRequest(req);
    if (!active.ok) return res.status(active.status).json({ ok: false, error: active.error });
    try {
      return res.json({ ok: true, git: await readProjectGitState(active.path) });
    } catch (err) {
      return res.status(409).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/project/active/git/commit', async (req, res) => {
    const active = activeProjectForRequest(req);
    if (!active.ok) return res.status(active.status).json({ ok: false, error: active.error });
    if (typeof req.body?.message !== 'string') return res.status(400).json({ ok: false, error: 'message must be a string' });
    try {
      return res.json({ ok: true, git: await commitProject(active.path, req.body.message) });
    } catch (err) {
      return res.status(409).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/project/active/git/push', async (req, res) => {
    const active = activeProjectForRequest(req);
    if (!active.ok) return res.status(active.status).json({ ok: false, error: active.error });
    try {
      return res.json({ ok: true, git: await pushProject(active.path) });
    } catch (err) {
      return res.status(409).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  /** Local working tree vs last pushed state (origin). Powers automatic drift scans on project load. */
  router.get('/project/active/drift', async (req, res) => {
    const active = activeProjectForRequest(req);
    if (!active.ok) return res.status(active.status).json({ ok: false, error: active.error });
    try {
      return res.json({ ok: true, drift: await readProjectDrift(active.path) });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.delete('/project/active', (req, res) => {
    const userId = getAuthenticatedUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: 'Authentication required' });

    const result = unloadActiveProject(userId);
    if (!result.ok) return res.status(404).json(result);

    return res.status(200).json(result);
  });

  /** Read the project's persisted status file + current snapshot (resume). */
  router.get('/project/active/status', (req, res) => {
    const userId = getAuthenticatedUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: 'Authentication required' });
    const project = getActiveProject(userId);
    if (!project) return res.status(409).json({ ok: false, code: 'NO_ACTIVE_PROJECT', error: 'Load a project first' });
    const persisted = readProjectStatus(project.path);
    const current = buildProjectStatusSnapshot(userId);
    return res.json({ ok: true, persisted, current });
  });

  /** Write the status snapshot to `.openhub/status.json` (no git). */
  router.post('/project/active/status', (req, res) => {
    const userId = getAuthenticatedUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: 'Authentication required' });
    const snapshot = saveProjectStatus(userId);
    if (!snapshot) return res.status(409).json({ ok: false, code: 'NO_ACTIVE_PROJECT', error: 'Load a project first' });
    return res.json({ ok: true, snapshot });
  });

  /** Persist the status file, commit it, and push to origin so it travels with the repo. */
  router.post('/project/active/status/sync', async (req, res) => {
    const active = activeProjectForRequest(req);
    if (!active.ok) return res.status(active.status).json({ ok: false, error: active.error });
    const userId = getAuthenticatedUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: 'Authentication required' });
    try {
      const snapshot = saveProjectStatus(userId);
      if (!snapshot) return res.status(409).json({ ok: false, code: 'NO_ACTIVE_PROJECT', error: 'Load a project first' });
      const git = await commitProject(active.path, `chore(openhub): update project status (${STATUS_FILE_PATH})`);
      return res.json({ ok: true, snapshot, git });
    } catch (err) {
      return res.status(409).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
