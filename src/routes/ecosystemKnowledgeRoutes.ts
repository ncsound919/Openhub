import express from 'express';
import {
  searchKnowledge,
  refreshKnowledgeIndexes,
  ensureKnowledgeIndexed,
  ecosystemRoots,
  sourceCounts,
} from '../services/ecosystemKnowledge.js';

const KNOWN_KINDS = new Set(['agent', 'skill', 'workflow', 'reference', 'template', 'rule', 'command']);

export function createEcosystemKnowledgeRouter(deps: { authMiddleware: express.RequestHandler }): express.Router {
  const router = express.Router();
  router.use(deps.authMiddleware);

  /** GET /api/ecosystem/knowledge?kind=&search=&limit= — unified index across all roots. */
  router.get('/ecosystem/knowledge', (req, res) => {
    const kind = typeof req.query.kind === 'string' ? req.query.kind.trim().toLowerCase() : '';
    if (kind && !KNOWN_KINDS.has(kind)) {
      return res.status(400).json({ error: `Unknown knowledge kind "${kind}" (known: ${[...KNOWN_KINDS].join(', ')})` });
    }
    const roots = ecosystemRoots();
    ensureKnowledgeIndexed(roots);
    const limit = Number(req.query.limit);
    const snapshot = searchKnowledge({
      kind: kind || undefined,
      search: typeof req.query.search === 'string' ? req.query.search : undefined,
      limit: Number.isFinite(limit) ? limit : undefined,
    });
    const status = snapshot.error ? 200 : 200;
    res.status(status).json({
      ok: true,
      ...snapshot,
      roots,
      sources: sourceCounts(),
    });
  });

  /** POST /api/ecosystem/knowledge/refresh — rebuild the index from all roots. */
  router.post('/ecosystem/knowledge/refresh', (_req, res) => {
    const roots = ecosystemRoots();
    if (roots.length === 0) {
      return res.status(503).json({ ok: false, error: 'ecosystem roots not configured (OPENHUB_ECOSYSTEM_ROOTS or OPENHUB_ECOSYSTEM_ROOT)' });
    }
    const snapshot = refreshKnowledgeIndexes(roots);
    res.json({ ok: true, ...snapshot, roots, sources: sourceCounts() });
  });

  return router;
}
