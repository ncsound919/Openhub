import { Router, type RequestHandler } from 'express';
import { configuredOperatorRoles, isOperator, operatorGateFor, requestRole } from '../lib/operator.js';
import { getActiveProject } from '../services/projectContext.js';
import { getAutoConfig, setAutoConfig, runAutoTick, getWatchState } from '../services/pipelineAuto.js';
import { getDispatchPrefs } from '../services/incidentBus.js';
import {
  startPipeline,
  getPipeline,
  listPipelines,
  cancelPipeline,
  approvePipeline,
  rejectPipeline,
  overallProgress,
  type PipelineDeps,
  type PipelineMode,
  type PipelineStageId,
} from '../services/pipeline.js';

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
 * Project pipeline surface: start a chained run (typecheck → audit → repair →
 * agent loop → verify) against the active project and poll its progress.
 * Auth-gated, mounted at /api.
 *
 *   POST /api/pipeline/run          { mode?, goal?, stages? }
 *   GET  /api/pipeline              recent jobs
 *   GET  /api/pipeline/:id          one job (with overall progress)
 *   POST /api/pipeline/:id/cancel
 */
export function createPipelineRouter(deps: { authMiddleware: RequestHandler; pipelineDeps?: Partial<PipelineDeps> }): Router {
  const router = Router();
  router.use(deps.authMiddleware);
  // Operator gate (OPENHUB_ADMIN_ROLES): these start agents, apply code or
  // dispatch repairs, so an ordinary authenticated account must not reach them.
  router.use(operatorGateFor([/^\/pipeline(\/|$)/]));

  function userId(req: Parameters<RequestHandler>[0]): string | null {
    const u = (req as unknown as { user?: { sub?: unknown } }).user;
    return typeof u?.sub === 'string' && u.sub.trim() !== '' ? u.sub : null;
  }

  const withProgress = (job: ReturnType<typeof getPipeline>) =>
    job ? { ...job, progress: overallProgress(job) } : null;

  router.post('/pipeline/run', (req, res) => {
    const id = userId(req);
    if (!id) return res.status(401).json({ ok: false, error: 'Authentication required' });
    const project = getActiveProject(id);
    if (!project) {
      return res.status(409).json({ ok: false, code: 'NO_ACTIVE_PROJECT', error: 'Load a project before running a pipeline' });
    }
    const body = (req.body ?? {}) as { mode?: unknown; goal?: unknown; stages?: unknown; planGate?: unknown };
    const mode: PipelineMode = body.mode === 'audit' || body.mode === 'custom' ? body.mode : 'autopilot';
    const goal = typeof body.goal === 'string' ? body.goal : '';
    const stages = Array.isArray(body.stages) ? (body.stages.map(String) as PipelineStageId[]) : undefined;
    const job = startPipeline({
      projectPath: project.path,
      projectName: project.repositoryName || project.repoId,
      goal,
      mode,
      stages,
      planGate: body.planGate === true,
      userId: id,
    }, deps.pipelineDeps);
    res.json({ ok: true, job: withProgress(job) });
  });

  router.get('/pipeline', (req, res) => {
    const canSee = ownerVisibleTo(req);
    res.json({ ok: true, jobs: listPipelines(25, (j) => canSee(j.userId)).map((j) => ({ ...j, progress: overallProgress(j) })) });
  });

  /** True when the job exists and the caller may see/act on it. */
  function jobVisible(req: Parameters<RequestHandler>[0], id: string): boolean {
    const job = getPipeline(id);
    return !!job && ownerVisibleTo(req)(job.userId);
  }

  // Unattended Autopilot (Auto autonomy mode). Declared BEFORE `/pipeline/:id`
  // so "auto" is not captured as a job id. Respects the fleet kill switch.
  router.get('/pipeline/auto', (_req, res) => {
    res.json({ ok: true, auto: getAutoConfig(), watch: getWatchState(), killSwitch: getDispatchPrefs().killSwitch });
  });

  router.put('/pipeline/auto', (req, res) => {
    const body = (req.body ?? {}) as { enabled?: unknown; intervalMs?: unknown; mode?: unknown; trigger?: unknown };
    const auto = setAutoConfig({
      ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
      ...(Number.isFinite(Number(body.intervalMs)) ? { intervalMs: Number(body.intervalMs) } : {}),
      ...(body.mode === 'audit' || body.mode === 'autopilot' ? { mode: body.mode } : {}),
      ...(typeof body.trigger === 'string' && ['interval', 'drift', 'change', 'reactive', 'both'].includes(body.trigger)
        ? { trigger: body.trigger as 'interval' | 'drift' | 'change' | 'reactive' | 'both' }
        : {}),
    });
    res.json({ ok: true, auto });
  });

  router.post('/pipeline/auto/tick', async (_req, res) => {
    res.json({ ok: true, result: await runAutoTick() });
  });

  router.get('/pipeline/:id', (req, res) => {
    const job = jobVisible(req, req.params.id) ? withProgress(getPipeline(req.params.id)) : null;
    if (!job) return res.status(404).json({ ok: false, error: 'Pipeline not found' });
    res.json({ ok: true, job });
  });

  router.post('/pipeline/:id/cancel', (req, res) => {
    if (!jobVisible(req, req.params.id)) return res.status(404).json({ ok: false, error: 'Pipeline not found' });
    res.json({ ok: cancelPipeline(req.params.id) });
  });

  // Plan gate: approve (optionally with an edited plan) or reject a parked run.
  router.post('/pipeline/:id/approve', (req, res) => {
    if (!jobVisible(req, req.params.id)) return res.status(404).json({ ok: false, error: 'Pipeline not found' });
    const raw = Array.isArray(req.body?.plan) ? (req.body.plan as Array<Record<string, unknown>>) : undefined;
    const plan = raw
      ?.filter((p) => p && typeof p.id === 'string')
      .map((p) => ({ id: String(p.id) as PipelineStageId, enabled: p.enabled !== false }));
    const goal = typeof req.body?.goal === 'string' ? req.body.goal : undefined;
    const job = approvePipeline(req.params.id, plan, goal, deps.pipelineDeps);
    if (!job) return res.status(409).json({ ok: false, error: 'pipeline is not awaiting approval' });
    res.json({ ok: true, job: withProgress(job) });
  });

  router.post('/pipeline/:id/reject', (req, res) => {
    if (!jobVisible(req, req.params.id)) return res.status(404).json({ ok: false, error: 'Pipeline not found' });
    res.json({ ok: rejectPipeline(req.params.id) });
  });

  return router;
}
