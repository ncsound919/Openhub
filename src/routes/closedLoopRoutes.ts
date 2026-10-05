import express from 'express';
import {
  approveLoopRun,
  getLoopMetrics,
  getLoopRun,
  intakeSignal,
  isKillSwitchActive,
  listLoopRuns,
  setKillSwitch,
  triggerClosedLoop,
} from '../services/closedLoop.js';
import { callerId, resolveReviewTarget } from '../lib/reviewTarget.js';
import { requireOperator } from '../lib/operator.js';

export function createClosedLoopRouter(deps: {
  authMiddleware: express.RequestHandler;
}): express.Router {
  const router = express.Router();
  router.use(deps.authMiddleware);

  /**
   * GET /api/loop/runs
   */
  router.get('/loop/runs', (req, res) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 50, 500);
      res.json({ ok: true, runs: listLoopRuns(limit) });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  /**
   * GET /api/loop/runs/:id
   */
  router.get('/loop/runs/:id', (req, res) => {
    try {
      const run = getLoopRun(req.params.id);
      if (!run) return res.status(404).json({ ok: false, error: 'Loop run not found' });
      res.json({ ok: true, run });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  /**
   * POST /api/loop/signal
   */
  router.post('/loop/signal', express.json(), requireOperator, (req, res) => {
    try {
      const body = req.body || {};
      if (!body.key || !body.targetDir) {
        return res.status(400).json({ ok: false, error: 'key and targetDir are required' });
      }
      const target = resolveReviewTarget(callerId(req), body.targetDir);
      if (!target.ok) return res.status(target.status).json({ ok: false, error: target.error });
      const result = intakeSignal({
        source: body.source || 'audit',
        key: body.key,
        severity: body.severity || 'medium',
        targetDir: target.dir,
        message: body.message || 'Automated signal intake',
      });
      res.json({ ok: true, ...result });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  /**
   * POST /api/loop/trigger
   */
  router.post('/loop/trigger', express.json(), requireOperator, (req, res) => {
    try {
      const body = req.body || {};
      if (!body.targetDir) {
        return res.status(400).json({ ok: false, error: 'targetDir is required' });
      }
      const target = resolveReviewTarget(callerId(req), body.targetDir);
      if (!target.ok) return res.status(target.status).json({ ok: false, error: target.error });
      const signals = [
        {
          id: `manual_${Date.now()}`,
          source: 'audit' as const,
          key: body.key || 'manual_trigger',
          severity: body.severity || 'high',
          targetDir: target.dir,
          message: body.message || 'Operator triggered closed loop',
          timestamp: Date.now(),
        },
      ];
      const run = triggerClosedLoop(target.dir, signals);
      res.json({ ok: true, run });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  /**
   * POST /api/loop/runs/:id/approve
   */
  router.post('/loop/runs/:id/approve', express.json(), async (req, res) => {
    try {
      const operator = (req as any).user?.email;
      if (!operator || typeof operator !== 'string' || !operator.trim()) {
        return res.status(403).json({
          ok: false,
          error: 'Operator identity required for approval — authenticated email must be present',
        });
      }
      const run = await approveLoopRun(req.params.id, operator);
      if (!run) {
        return res.status(404).json({ ok: false, error: 'Run not found or not waiting for approval' });
      }
      res.json({ ok: true, run });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  /**
   * GET /api/loop/metrics
   */
  router.get('/loop/metrics', (_req, res) => {
    try {
      res.json({ ok: true, metrics: getLoopMetrics() });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  /**
   * POST /api/loop/kill-switch
   */
  router.post('/loop/kill-switch', express.json(), (req, res) => {
    try {
      const { active } = req.body || {};
      setKillSwitch(Boolean(active));
      res.json({ ok: true, killSwitchActive: isKillSwitchActive() });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  return router;
}
