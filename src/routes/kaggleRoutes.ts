import express from 'express';
import { kaggleAuthOk, kernelStatus, kernelOutput, listKernels } from '../services/kaggleJobs.js';

export function createKaggleRouter(deps: { authMiddleware: express.RequestHandler }): express.Router {
  const router = express.Router();
  router.use(deps.authMiddleware);

  router.get('/kaggle/auth', async (_req, res) => {
    // `configured` distinguishes "no token on this device" from "token rejected",
    // so a setup card can point at the right fix. No token value is ever returned.
    const configured = Boolean(process.env.KAGGLE_API_TOKEN);
    const authenticated = configured ? await kaggleAuthOk() : false;
    res.json({ ok: true, data: { authenticated, configured } });
  });

  router.get('/kaggle/kernels', async (req, res) => {
    try {
      const owner = typeof req.query.owner === 'string' ? req.query.owner : undefined;
      const data = await listKernels(owner);
      res.json({ ok: true, data });
    } catch (err) {
      res.status(502).json({ ok: false, error: err instanceof Error ? err.message : 'kaggle error' });
    }
  });

  router.get('/kaggle/kernels/:owner/:slug/status', async (req, res) => {
    try {
      const data = await kernelStatus(req.params.owner, req.params.slug);
      res.json({ ok: true, data });
    } catch (err) {
      res.status(502).json({ ok: false, error: err instanceof Error ? err.message : 'kaggle error' });
    }
  });

  router.get('/kaggle/kernels/:owner/:slug/output', async (req, res) => {
    try {
      const data = await kernelOutput(req.params.owner, req.params.slug);
      res.json({ ok: true, data });
    } catch (err) {
      res.status(502).json({ ok: false, error: err instanceof Error ? err.message : 'kaggle error' });
    }
  });

  return router;
}