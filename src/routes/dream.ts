import { Router, type RequestHandler } from 'express';
import { dreamState, dreamTick } from '../services/dreamState.js';
import { getAgentReadouts, buildWorkOrder } from '../services/agentReadouts.js';

/**
 * Dream state — the node's background monitor. Mounted at /api.
 *   GET  /api/dream        — current per-repo status/purpose/development/grade
 *   POST /api/dream/tick   — run an analysis pass now
 *   GET  /api/repos/scores — per-repo audit verdict + score (for repo cards)
 */
export function createDreamRouter(deps: { authMiddleware: RequestHandler }): Router {
  const router = Router();
  router.use(deps.authMiddleware);

  router.get('/dream', (_req, res) => {
    try {
      const entries = dreamState();
      const graded = entries.filter((e) => e.grade !== null).length;
      res.json({
        ok: true,
        entries,
        summary: {
          total: entries.length,
          graded,
          healthy: entries.filter((e) => e.status === 'healthy').length,
          attention: entries.filter((e) => e.status === 'attention').length,
          critical: entries.filter((e) => e.status === 'critical').length,
        },
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/dream/tick', (_req, res) => {
    try {
      const count = dreamTick();
      res.json({ ok: true, analyzed: count });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/repos/scores', (_req, res) => {
    try {
      const entries = dreamState();
      res.json({
        ok: true,
        scores: entries.map((e) => ({ repoId: e.repoId, name: e.name, grade: e.grade, score: e.score, status: e.status, findings: e.findings })),
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
