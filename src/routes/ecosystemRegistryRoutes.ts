import express from 'express';
import {
  listRegistry,
  getRegistryEntry,
  refreshRegistry,
  auditRegistry,
  summarizeRegistry,
  type EntityKind,
  type HealthStatus,
  type RegistryQuery,
} from '../services/ecosystemRegistry.js';

const KNOWN_KINDS = new Set<EntityKind>(['service', 'tool', 'project', 'pack']);
const KNOWN_HEALTH = new Set<HealthStatus>(['online', 'degraded', 'offline', 'unknown']);
const SORTS = new Set(['deployability', 'audit', 'name']);

function parseQuery(query: express.Request['query']): RegistryQuery {
  const kind = typeof query.kind === 'string' ? query.kind.trim().toLowerCase() : '';
  const health = typeof query.health === 'string' ? query.health.trim().toLowerCase() : '';
  const sort = typeof query.sort === 'string' ? query.sort.trim().toLowerCase() : '';
  const min = Number(query.min_deployability);
  const max = Number(query.max_deployability);
  const limit = Number(query.limit);
  return {
    kind: kind && KNOWN_KINDS.has(kind as EntityKind) ? (kind as EntityKind) : undefined,
    pillar: typeof query.pillar === 'string' ? query.pillar.trim() : undefined,
    search: typeof query.search === 'string' ? query.search : undefined,
    health: health && KNOWN_HEALTH.has(health as HealthStatus) ? (health as HealthStatus) : undefined,
    ...(Number.isFinite(min) ? { minDeployability: min } : {}),
    ...(Number.isFinite(max) ? { maxDeployability: max } : {}),
    ...(SORTS.has(sort) ? { sort: sort as RegistryQuery['sort'] } : {}),
    ...(Number.isFinite(limit) ? { limit } : {}),
  };
}

export function createEcosystemRegistryRouter(deps: { authMiddleware: express.RequestHandler }): express.Router {
  const router = express.Router();
  router.use(deps.authMiddleware);

  /**
   * GET /api/ecosystem/registry?kind=&pillar=&search=&health=&min_deployability=&max_deployability=&sort=&limit=
   * The full catalog (stack, purpose, audit rank, deployability) from the
   * persisted overlay + seed — no network probing.
   */
  router.get('/ecosystem/registry', (req, res) => {
    const snapshot = listRegistry(parseQuery(req.query));
    res.json({ ok: true, summary: summarizeRegistry(snapshot), ...snapshot });
  });

  /** GET /api/ecosystem/registry/summary — totals without the full entry list. */
  router.get('/ecosystem/registry/summary', (_req, res) => {
    const snapshot = listRegistry({ limit: 1 });
    res.json({ ok: true, summary: summarizeRegistry(snapshot), totals: snapshot.totals, ranking: snapshot.ranking });
  });

  /**
   * POST /api/ecosystem/registry/refresh?audit=1 — re-probe fleet health
   * (capability registry), recompute deployability, and persist the overlay.
   * With `audit=1`, also runs live RepoRank/Grader/The Deep scoring on entities
   * that have an audit target (bounded; use the audit route for a subset).
   */
  router.post('/ecosystem/registry/refresh', async (req, res) => {
    const audit = req.query.audit === '1' || req.query.audit === 'true' || req.body?.audit === true;
    const ids = Array.isArray(req.body?.ids) ? (req.body.ids as string[]) : undefined;
    const limit = Number(req.body?.audit_limit ?? req.query.audit_limit);
    const snapshot = await refreshRegistry({
      ...(audit ? { audit: true } : {}),
      ...(ids ? { auditIds: ids } : {}),
      ...(Number.isFinite(limit) ? { auditLimit: limit } : {}),
    });
    res.json({ ok: true, summary: summarizeRegistry(snapshot), ...snapshot });
  });

  /**
   * POST /api/ecosystem/registry/audit — live-score a bounded subset with
   * RepoRank + Grader (GitHub) and The Deep (local dir). Body: { ids?, limit? }.
   */
  router.post('/ecosystem/registry/audit', async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? (req.body.ids as string[]).map(String) : undefined;
    const limit = Number(req.body?.limit);
    const result = await auditRegistry({
      ...(ids && ids.length ? { ids } : {}),
      ...(Number.isFinite(limit) ? { limit } : {}),
    });
    res.json({ ok: true, summary: summarizeRegistry(result.snapshot), ...result });
  });

  /** GET /api/ecosystem/registry/:id — a single entity. */
  router.get('/ecosystem/registry/:id', (req, res) => {
    const entry = getRegistryEntry(req.params.id);
    if (!entry) return res.status(404).json({ ok: false, error: `Unknown ecosystem entity "${req.params.id}"` });
    res.json({ ok: true, entry });
  });

  return router;
}
