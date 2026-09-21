import express from 'express';
import { listEvents, summarizeEvents } from '../services/telemetry.js';
import { buildInsights } from '../services/insights.js';
import { normalizeSynergyMap, recourseSynergyMap } from '../services/recourseClient.js';
import { dispatchRecourseRepair, recourseContextForGoal, recordRecourseOutcome } from '../services/recourseBridge.js';

/**
 * Telemetry, insights, and the Recourse bridge.
 * ============================================
 *   GET  /api/telemetry/events      append-only cross-system event stream
 *   GET  /api/telemetry/summary     deterministic roll-up over a window
 *   GET  /api/insights              trends + insights + synergy + autonomy
 *   GET  /api/insights/synergy      normalized cross-domain synergy map
 *   GET  /api/recourse/bridge/context?goal=   recall + synergy context
 *   POST /api/recourse/bridge/outcome         write an outcome to Recourse
 *   POST /api/recourse/bridge/dispatch        operator-gated supervised loop
 *
 * Auth-gated; every read degrades to explicit `available:false`/empty rather
 * than fabricating state.
 */
export function createInsightsRouter(deps: { authMiddleware: express.RequestHandler }): express.Router {
  const router = express.Router();
  router.use(deps.authMiddleware);

  const asNumber = (value: unknown): number | undefined => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };

  router.get('/telemetry/events', async (req, res) => {
    try {
      const events = listEvents({
        system: typeof req.query.system === 'string' ? req.query.system : undefined,
        kind: typeof req.query.kind === 'string' ? req.query.kind : undefined,
        severity: typeof req.query.severity === 'string' ? req.query.severity : undefined,
        correlationId: typeof req.query.correlationId === 'string' ? req.query.correlationId : undefined,
        limit: asNumber(req.query.limit) ?? 200,
        sinceMs: asNumber(req.query.sinceMs),
      });
      res.json({ ok: true, events, count: events.length });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.get('/telemetry/summary', async (req, res) => {
    try {
      res.json({ ok: true, summary: summarizeEvents({ sinceMs: asNumber(req.query.sinceMs) }) });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.get('/insights', async (req, res) => {
    try {
      res.json({ ok: true, report: await buildInsights({ windowMs: asNumber(req.query.windowMs) }) });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.get('/insights/synergy', async (_req, res) => {
    try {
      const r = await recourseSynergyMap();
      res.status(r.available ? 200 : 503).json({
        ok: r.available,
        available: r.available,
        ...normalizeSynergyMap(r.data),
        ...(r.error ? { error: r.error } : {}),
      });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.get('/recourse/bridge/context', async (req, res) => {
    const goal = typeof req.query.goal === 'string' ? req.query.goal : '';
    if (!goal.trim()) return res.status(400).json({ ok: false, available: false, error: 'goal is required' });
    try {
      res.json({ ok: true, ...(await recourseContextForGoal(goal, { topK: asNumber(req.query.topK) ?? 5 })) });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.post('/recourse/bridge/outcome', express.json(), async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    try {
      const r = await recordRecourseOutcome(body);
      res.status(r.available ? 200 : 503).json(r);
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.post('/recourse/bridge/dispatch', express.json(), async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (typeof body.targetDir !== 'string' || !body.targetDir.trim()) {
      return res.status(400).json({ ok: false, error: 'targetDir is required' });
    }
    try {
      const userId = (req as unknown as { user?: { sub?: unknown } }).user?.sub;
      const run = await dispatchRecourseRepair({
        targetDir: body.targetDir,
        findings: Array.isArray(body.findings) ? body.findings : undefined,
        goal: typeof body.goal === 'string' ? body.goal : undefined,
        maxIterations: Number.isFinite(Number(body.maxIterations)) ? Number(body.maxIterations) : undefined,
        userId: typeof userId === 'string' ? userId : undefined,
        correlationId: typeof body.correlationId === 'string' ? body.correlationId : undefined,
      });
      res.status(run.status === 'failed' ? 502 : 200).json({ ok: run.status !== 'failed', run });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  return router;
}
