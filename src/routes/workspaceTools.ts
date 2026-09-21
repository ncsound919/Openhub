import path from 'node:path';
import { Router, type Request, type RequestHandler } from 'express';
import { isSubpath } from '../lib/pathGuard.js';
import { getActiveProject } from '../services/projectContext.js';
import {
  diffFile,
  listBranches,
  createBranch,
  switchBranch,
  deleteBranch,
  searchWorkspace,
  listWorkspaceFiles,
  readProjectGitState,
} from '../services/projectGit.js';
import { runLlm } from '../services/llmRouter.js';
import { runTypecheck } from '../services/typecheck.js';

/**
 * Workspace tooling routes (auth-gated, mounted at /api):
 *   GET  /api/project/active/git/diff?path=&cached=   — HEAD vs working tree for one file
 *   GET  /api/project/active/git/branches             — current + all local branches
 *   POST /api/project/active/git/branch               — { action: create|switch|delete, name }
 *   GET  /api/project/active/search?q=                — bounded full-text search
 *   POST /api/project/active/git/explain              — { diff } -> LLM summary
 */
export function createWorkspaceToolsRouter(deps: { authMiddleware: RequestHandler }): Router {
  const router = Router();
  router.use(deps.authMiddleware);

  function projectFor(req: Request): { ok: true; path: string; userId: string } | { ok: false; status: number; error: string } {
    const userId = (req.user as { sub?: unknown } | undefined)?.sub;
    if (typeof userId !== 'string' || !userId.trim()) {
      return { ok: false, status: 401, error: 'Authentication required' };
    }
    const project = getActiveProject(userId);
    if (!project) return { ok: false, status: 409, error: 'Load a project first' };
    return { ok: true, path: project.path, userId };
  }

  function safeRel(root: string, requested: unknown): string | null {
    if (typeof requested !== 'string' || !requested.trim()) return null;
    const rel = requested.replace(/\\/g, '/').replace(/^[/\\]+/, '');
    const abs = path.resolve(root, rel);
    if (!isSubpath(root, abs)) return null;
    return rel;
  }

  router.get('/project/active/git/diff', async (req, res) => {
    const project = projectFor(req);
    if (!project.ok) return res.status(project.status).json({ ok: false, error: project.error });
    const rel = safeRel(project.path, req.query.path);
    if (!rel) return res.status(400).json({ ok: false, error: 'Invalid or unsafe path' });
    try {
      const cached = req.query.cached === '1' || req.query.cached === 'true';
      const diff = await diffFile(project.path, rel, cached);
      res.json({ ok: true, ...diff });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/project/active/git/branches', async (req, res) => {
    const project = projectFor(req);
    if (!project.ok) return res.status(project.status).json({ ok: false, error: project.error });
    try {
      res.json({ ok: true, branches: await listBranches(project.path) });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/project/active/git/branch', async (req, res) => {
    const project = projectFor(req);
    if (!project.ok) return res.status(project.status).json({ ok: false, error: project.error });
    const { action, name } = (req.body ?? {}) as { action?: string; name?: string };
    try {
      let branches;
      if (action === 'create') branches = await createBranch(project.path, String(name ?? ''));
      else if (action === 'switch') branches = await switchBranch(project.path, String(name ?? ''));
      else if (action === 'delete') branches = await deleteBranch(project.path, String(name ?? ''));
      else return res.status(400).json({ ok: false, error: 'action must be create|switch|delete' });
      const git = await readProjectGitState(project.path);
      res.json({ ok: true, branches, git });
    } catch (err) {
      res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/project/active/search', async (req, res) => {
    const project = projectFor(req);
    if (!project.ok) return res.status(project.status).json({ ok: false, error: project.error });
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    if (!q.trim()) return res.json({ ok: true, query: '', hits: [] });
    const ctrl = new AbortController();
    res.on('close', () => { if (!res.writableEnded) ctrl.abort(); });
    try {
      const hits = await searchWorkspace(project.path, q, { signal: ctrl.signal });
      res.json({ ok: true, query: q, hits });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Flat, bounded file index for the editor's Quick Open (Ctrl+P).
  router.get('/project/active/files', async (req, res) => {
    const project = projectFor(req);
    if (!project.ok) return res.status(project.status).json({ ok: false, error: project.error });
    const ctrl = new AbortController();
    res.on('close', () => { if (!res.writableEnded) ctrl.abort(); });
    try {
      const files = await listWorkspaceFiles(project.path);
      if (ctrl.signal.aborted) return;
      res.json({ ok: true, files });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/project/active/git/explain', async (req, res) => {
    const project = projectFor(req);
    if (!project.ok) return res.status(project.status).json({ ok: false, error: project.error });
    const diff = (req.body as { diff?: unknown } | undefined)?.diff;
    if (typeof diff !== 'string' || !diff.trim()) {
      return res.status(400).json({ ok: false, error: 'diff is required' });
    }
    try {
      const capped = diff.slice(0, 8000);
      const result = await runLlm([
        { role: 'system', content: 'You are a senior engineer. Summarize code changes in plain, concrete language. Keep it under 120 words, 3-5 bullets.' },
        { role: 'user', content: `Explain this diff from the active project:\n\n${capped}` },
      ]);
      res.json({ ok: result.ok, text: result.text, ...(result.error !== undefined ? { error: result.error } : {}) });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/project/active/typecheck', async (req, res) => {
    const project = projectFor(req);
    if (!project.ok) return res.status(project.status).json({ ok: false, error: project.error });
    try {
      const result = await runTypecheck(project.path);
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}