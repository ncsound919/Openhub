import { Router, type Request, type Response, type NextFunction } from 'express';
import {
  discoverEndpoints,
  executeApiRequest,
  startMockServer,
  stopMockServer,
  getMockServerStatus,
} from '../services/apiStudio.js';
import { callerId, resolveScanTarget } from '../lib/reviewTarget.js';

export interface ApiStudioRouterOptions {
  authMiddleware?: (req: Request, res: Response, next: NextFunction) => void;
}

export function createApiStudioRouter(options: ApiStudioRouterOptions = {}): Router {
  const router = Router();
  const auth = options.authMiddleware ?? ((_req, _res, next) => next());

  /**
   * GET /api/studio/endpoints
   * List auto-discovered API endpoints and OpenAPI schemas in project.
   */
  router.get('/endpoints', auth, (req: Request, res: Response) => {
    // Constrain endpoint discovery to an allowed repo root (or the cwd default).
    const target = resolveScanTarget(callerId(req), req.query.targetDir);
    if (!target.ok) return res.status(target.status).json({ ok: false, error: target.error });
    const targetDir = target.dir;

    try {
      const endpoints = discoverEndpoints(targetDir);
      return res.json({ ok: true, endpoints, count: endpoints.length });
    } catch (err: any) {
      return res.status(500).json({ ok: false, error: err.message || 'Failed to discover endpoints' });
    }
  });

  /**
   * POST /api/studio/execute
   * Execute interactive HTTP request with contract schema validation and timing.
   */
  router.post('/execute', auth, async (req: Request, res: Response) => {
    const { url, method, headers, body, expectedSchema, envVars } = req.body;

    if (!url) {
      return res.status(400).json({ ok: false, error: 'url is required' });
    }

    try {
      const result = await executeApiRequest({
        url,
        method: method || 'GET',
        headers,
        body,
        expectedSchema,
        envVars,
      });
      return res.json({ ok: true, result });
    } catch (err: any) {
      return res.status(500).json({ ok: false, error: err.message || 'Request execution failed' });
    }
  });

  /**
   * POST /api/studio/mock/start
   * Start local autonomous mock server for discovered endpoints.
   */
  router.post('/mock/start', auth, async (req: Request, res: Response) => {
    const target = resolveScanTarget(callerId(req), req.body.targetDir);
    if (!target.ok) return res.status(target.status).json({ ok: false, error: target.error });
    const targetDir = target.dir;
    const port = req.body.port || 4050;
    const latencyMs = req.body.latencyMs !== undefined ? req.body.latencyMs : 30;
    const errorRate = req.body.errorRate || 0;

    try {
      const endpoints = discoverEndpoints(targetDir);
      const config = await startMockServer(endpoints, port, latencyMs, errorRate);
      return res.json({ ok: true, config });
    } catch (err: any) {
      return res.status(500).json({ ok: false, error: err.message || 'Failed to start mock server' });
    }
  });

  /**
   * POST /api/studio/mock/stop
   * Stop active mock server.
   */
  router.post('/mock/stop', auth, async (_req: Request, res: Response) => {
    try {
      await stopMockServer();
      return res.json({ ok: true, message: 'Mock server stopped' });
    } catch (err: any) {
      return res.status(500).json({ ok: false, error: err.message || 'Failed to stop mock server' });
    }
  });

  /**
   * GET /api/studio/mock/status
   * Get active mock server configuration.
   */
  router.get('/mock/status', auth, (_req: Request, res: Response) => {
    return res.json({ ok: true, config: getMockServerStatus() });
  });

  return router;
}
