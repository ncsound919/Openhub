import { Router, type RequestHandler } from 'express';
import { getActiveProject } from '../services/projectContext.js';
import {
  startSupervision,
  listRuns,
  getRun,
  resumeSupervision,
  stopSupervision,
} from '../services/supervisor.js';

/**
 * Supervised runs: loop → audit → fix. Auth-gated, mounted at /api.
 *   POST /api/supervise/start      { goal, maxIterations?, modelRoute? }
 *   GET  /api/supervise/runs
 *   GET  /api/supervise/runs/:id
 *   POST /api/supervise/runs/:id/resume
 *   POST /api/supervise/runs/:id/stop
 */
export function createSupervisorRouter(deps: { authMiddleware: RequestHandler }): Router {
  const router = Router();
  router.use(deps.authMiddleware);

  function userId(req: Parameters<RequestHandler>[0]): string | null {
    const u = (req as any).user as { sub?: unknown } | undefined;
    return typeof u?.sub === 'string' && u.sub.trim() !== '' ? u.sub : null;
  }

  router.post('/supervise/start', async (req, res) => {
    const id = userId(req);
    if (!id) return res.status(401).json({ ok: false, error: 'Authentication required' });
    const project = getActiveProject(id);
    if (!project) return res.status(409).json({ ok: false, code: 'NO_ACTIVE_PROJECT', error: 'Load a project before supervising a run' });
    const { goal, maxIterations, modelRoute } = (req.body ?? {}) as { goal?: unknown; maxIterations?: unknown; modelRoute?: unknown };
    if (typeof goal !== 'string' || goal.trim() === '') {
      return res.status(400).json({ ok: false, error: 'goal is required' });
    }
    const run = await startSupervision({
      goal: goal.trim(),
      targetDir: project.path,
      maxIterations: typeof maxIterations === 'number' ? maxIterations : undefined,
      modelRoute: typeof modelRoute === 'string' ? modelRoute : undefined,
      userId: id,
    });
    res.json({ ok: true, run });
  });

  router.get('/supervise/runs', (_req, res) => {
    res.json({ ok: true, runs: listRuns(100) });
  });

  router.get('/supervise/runs/:id', (req, res) => {
    const run = getRun(req.params.id);
    if (!run) return res.status(404).json({ ok: false, error: 'Run not found' });
    res.json({ ok: true, run });
  });

  router.post('/supervise/runs/:id/resume', (req, res) => {
    const run = resumeSupervision(req.params.id);
    if (!run) return res.status(404).json({ ok: false, error: 'Run not found or not resumable' });
    res.json({ ok: true, run });
  });

  router.post('/supervise/runs/:id/stop', (req, res) => {
    stopSupervision(req.params.id);
    res.json({ ok: true });
  });

  return router;
}
