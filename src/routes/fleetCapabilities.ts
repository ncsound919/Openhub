import express from 'express';
import { probeFleetCapabilities } from '../services/capabilityProbe.js';
import { getBridgeStatement, listBridgeStatements } from '../services/capabilityRegistry.js';

export function createFleetCapabilitiesRouter(deps: {
  authMiddleware: express.RequestHandler;
}): express.Router {
  const router = express.Router();
  router.use(deps.authMiddleware);

  /**
   * GET /api/fleet/capabilities
   * Probe declared fleet bridges with TTL caching and evidence probe receipts.
   * Query param ?refresh=1 bypasses TTL cache.
   */
  router.get('/fleet/capabilities', async (req, res) => {
    try {
      const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
      const snapshot = await probeFleetCapabilities({ refresh });
      res.json({ ok: true, ...snapshot });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  /**
   * GET /api/fleet/capabilities/catalog
   * Read-only declared capability statements without triggering network probes.
   */
  router.get('/fleet/capabilities/catalog', (_req, res) => {
    try {
      res.json({ ok: true, bridges: listBridgeStatements() });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  /**
   * GET /api/fleet/capabilities/:slug
   * Read single declared bridge statement.
   */
  router.get('/fleet/capabilities/:slug', (req, res) => {
    try {
      const bridge = getBridgeStatement(req.params.slug);
      if (!bridge) {
        return res.status(404).json({ ok: false, error: `Bridge ${req.params.slug} not found in catalog` });
      }
      res.json({ ok: true, bridge });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  return router;
}
