import { Router, type RequestHandler } from 'express';
import { listFleetRepos, syncFleetRepos, repoIndexSummary } from '../services/githubRepos.js';

/**
 * Fleet GitHub repo awareness routes (ncsound919 + tap919).
 *
 * Mounted under `/api` → `GET /api/github/fleet/repos` (snapshot) and
 * `POST /api/github/fleet/repos/sync` (re-fetch + re-index). Both auth-gated.
 */
export function createGithubFleetRouter(deps: { authMiddleware: RequestHandler }): Router {
  const router = Router();
  router.use(deps.authMiddleware);

  router.get('/github/fleet/repos', (req, res) => {
    try {
      const account = typeof req.query.account === 'string' ? req.query.account : undefined;
      const search = typeof req.query.search === 'string' ? req.query.search : undefined;
      const visibility = typeof req.query.visibility === 'string' ? req.query.visibility : undefined;
      const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : undefined;
      const repos = listFleetRepos({
        account,
        search,
        visibility: visibility as 'public' | 'private' | 'internal' | undefined,
        limit,
      });
      res.json({ ...repoIndexSummary(), repos, count: repos.length });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to read fleet repo index' });
    }
  });

  router.post('/github/fleet/repos/sync', async (_req, res) => {
    try {
      const result = await syncFleetRepos();
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Fleet repo sync failed' });
    }
  });

  return router;
}
