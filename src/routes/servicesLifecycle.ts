import express from 'express';
import {
  getAllServicesStatus,
  getServiceStatus,
  startServiceSafe,
  stopServiceSafe,
} from '../services/serviceManager.js';

export function createServicesLifecycleRouter(deps: { authMiddleware: express.RequestHandler }): express.Router {
  const router = express.Router();
  router.use(deps.authMiddleware);

  router.get('/lifecycle/services', async (_req, res) => {
    try {
      const services = await getAllServicesStatus();
      res.json({ ok: true, services });
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
