import { Router, type RequestHandler } from 'express';
import { getAgentRoster } from '../services/agentRegistry.js';

/**
 * Auth-gated agent roster: which on-disk agents back the audit system and the
 * research pipeline. Read-only; reflects the node's configured paths.
 */
export function createAgentRosterRouter(deps: { authMiddleware: RequestHandler }): Router {
  const router = Router();
  router.use(deps.authMiddleware);

  router.get('/agents/roster', (_req, res) => {
    try {
      res.json({ ok: true, ...getAgentRoster() });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
