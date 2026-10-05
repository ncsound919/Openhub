import express from 'express';
import {
  getAllServicesStatus,
  getServiceStatus,
  startServiceSafe,
  stopServiceSafe,
  startCategory,
  stopCategory,
  startAllServices,
  stopAllServices,
  SERVICE_CATEGORIES,
  type ServiceCategory,
} from '../services/serviceManager.js';

export function createServicesLifecycleRouter(deps: { authMiddleware: express.RequestHandler }): express.Router {
  const router = express.Router();
  router.use(deps.authMiddleware);

  const isCategory = (v: string): v is ServiceCategory => (SERVICE_CATEGORIES as string[]).includes(v);

  router.get('/lifecycle/services', async (_req, res) => {
    try {
      const services = await getAllServicesStatus();
      res.json({ ok: true, services, categories: SERVICE_CATEGORIES });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Fleet-level operations: a whole category ("audit team", "repair team") or
  // everything. Idempotent — already-up services are a no-op success, so
  // "the fleet is down, bring it up" is one call.
  router.post('/lifecycle/groups/:category/start', async (req, res) => {
    const { category } = req.params;
    if (!isCategory(category)) return res.status(400).json({ ok: false, error: `unknown category: ${category}` });
    try {
      const results = await startCategory(category);
      res.json({ ok: results.every((r) => r.ok), category, results });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.post('/lifecycle/groups/:category/stop', async (req, res) => {
    const { category } = req.params;
    if (!isCategory(category)) return res.status(400).json({ ok: false, error: `unknown category: ${category}` });
    try {
      const results = await stopCategory(category);
      res.json({ ok: results.every((r) => r.ok), category, results });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.post('/lifecycle/all/start', async (_req, res) => {
    try {
      const results = await startAllServices();
      res.json({ ok: results.every((r) => r.ok), results });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.post('/lifecycle/all/stop', async (_req, res) => {
    try {
      const results = await stopAllServices();
      res.json({ ok: results.every((r) => r.ok), results });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.get('/lifecycle/services/:slug', async (req, res) => {
    try {
      const status = await getServiceStatus(req.params.slug);
      if (!status) {
        return res.status(404).json({ ok: false, error: 'Service not found' });
      }
      res.json({ ok: true, service: status });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.post('/lifecycle/services/:slug/start', async (req, res) => {
    try {
      const result = await startServiceSafe(req.params.slug);
      res.status(result.ok ? 200 : 500).json(result);
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.post('/lifecycle/services/:slug/stop', async (req, res) => {
    try {
      const result = await stopServiceSafe(req.params.slug);
      res.status(result.ok ? 200 : 500).json(result);
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  return router;
}
