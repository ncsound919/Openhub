import { Router, type RequestHandler } from 'express';
import {
  openSeoStatus,
  seoReadiness,
  siteAudit,
  auditFleetSites,
} from '../services/seo.js';

/**
 * SEO provider routes — mounted at `/api` (auth-gated), yielding
 * `/api/business/seo/*`. Wraps the fleet open-seo engine plus OpenHub's free
 * deterministic audit. Paid-key data (keyword/backlink/rank) degrades honestly.
 */
export function createSeoRouter(deps: { authMiddleware: RequestHandler }): Router {
  const router = Router();
  router.use(deps.authMiddleware);

  router.get('/business/seo/status', async (_req, res) => {
    const r = await openSeoStatus();
    res.status(r.available ? 200 : 503).json(r);
  });

  router.get('/business/seo/readiness', async (_req, res) => {
    res.json(await seoReadiness());
  });

  router.post('/business/seo/audit', async (req, res) => {
    const body = (req.body && typeof req.body === 'object') ? (req.body as Record<string, unknown>) : {};
    if (typeof body.url !== 'string' || !body.url.trim()) {
      return res.status(400).json({ error: 'url is required' });
    }
    res.json(await siteAudit(body.url.trim()));
  });

  router.get('/business/seo/audit-sites', async (_req, res) => {
    res.json(await auditFleetSites());
  });

  return router;
}
