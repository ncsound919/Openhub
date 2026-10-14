import { Router, type RequestHandler } from 'express';
import { getActiveProject } from '../services/projectContext.js';
import {
  startSupervision,
  listRuns,
  getRun,
  resumeSupervision,
  stopSupervision,
} from '../services/supervisor.js';
import { configuredOperatorRoles, isOperator, requestRole } from '../lib/operator.js';

/**
 * Owner scoping (audit 2026-09-23), consistent with lib/operator.ts: operators
 * are only distinguishable when OPENHUB_ADMIN_ROLES is configured (not `*`).
 *   - owned record: its owner, or an operator under a configured gate;
 *   - legacy record (no owner): everyone when the gate is unset, otherwise
 *     operators only.
 */
function ownerVisibleTo(req: Parameters<RequestHandler>[0]): (ownerId: string | null | undefined) => boolean {
  const roles = configuredOperatorRoles();
  const gated = roles.length > 0 && !roles.includes('*');
  const admin = gated && isOperator(requestRole(req), roles);
  const sub = (req as unknown as { user?: { sub?: unknown } }).user?.sub;
  const me = typeof sub === 'string' ? sub : '';
  return (ownerId) => {
    if (admin) return true;
    if (!ownerId) return !gated;
    return ownerId === me;
  };
}

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

  router.get('/supervise/runs', (req, res) => {
    const canSee = ownerVisibleTo(req);
    res.json({ ok: true, runs: listRuns(100, (r) => canSee(r.userId)) });
  });

  /** The run, or null when it does not exist or belongs to someone else. */
  function visibleRun(req: Parameters<RequestHandler>[0], id: string) {
    const run = getRun(id);
    return run && ownerVisibleTo(req)(run.userId) ? run : null;
  }

  router.get('/supervise/runs/:id', (req, res) => {
    const run = visibleRun(req, req.params.id);
    if (!run) return res.status(404).json({ ok: false, error: 'Run not found' });
    res.json({ ok: true, run });
  });

  router.post('/supervise/runs/:id/resume', (req, res) => {
    if (!visibleRun(req, req.params.id)) return res.status(404).json({ ok: false, error: 'Run not found or not resumable' });
    const run = resumeSupervision(req.params.id);
    if (!run) return res.status(404).json({ ok: false, error: 'Run not found or not resumable' });
    res.json({ ok: true, run });
  });

  router.post('/supervise/runs/:id/stop', (req, res) => {
    if (!visibleRun(req, req.params.id)) return res.status(404).json({ ok: false, error: 'Run not found' });
    stopSupervision(req.params.id);
    res.json({ ok: true });
  });

  return router;
}
