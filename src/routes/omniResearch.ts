import { Router, type RequestHandler } from 'express';
import {
  OMNI_CAPABILITIES,
  omniAutonomousLoop,
  omniAxiomExemplars,
  omniBaselineSources,
  omniCapabilities,
  omniDeepResearch,
  omniEcosystemStatus,
  omniHealth,
  omniInvoke,
  omniJevDecision,
  omniLlmResearch,
  omniMcpCall,
  omniMcpToolsList,
  omniMarketing,
  omniMultiHarvest,
} from '../services/omniResearchClient.js';

/**
 * OmniResearch proxy — exposes Omni's full capability surface under
 * /api/omniresearch/*. Mounted at /api (so paths below are prefixed).
 * Fail-soft: 503 when Omni is offline — never fabricated research output.
 */
export function createOmniResearchRouter(deps: { authMiddleware: RequestHandler }): Router {
  const router = Router();
  router.use(deps.authMiddleware);

  const send = (res: any, r: { available: boolean; status?: number; data?: unknown; error?: string }) => {
    res.status(r.available ? 200 : r.status === 400 ? 400 : 503).json(r);
  };

  router.get('/omniresearch/health', async (_req, res) => send(res, await omniHealth()));
  router.get('/omniresearch/capabilities', async (_req, res) => send(res, await omniCapabilities()));
  router.get('/omniresearch/mcp/tools', async (_req, res) => send(res, await omniMcpToolsList()));

  router.post('/omniresearch/llm', async (req, res) => {
    const body = req.body as { prompt?: unknown; temperature?: unknown } | undefined;
    const prompt = typeof body?.prompt === 'string' ? body.prompt : '';
    const temperature = typeof body?.temperature === 'number' ? body.temperature : undefined;
    send(res, await omniLlmResearch(prompt, temperature));
  });

  router.post('/omniresearch/deep-research', async (req, res) => {
    const body = (req.body ?? {}) as { query?: unknown; domain?: unknown; skill?: unknown; targetUrls?: unknown };
    send(
      res,
      await omniDeepResearch({
        query: String(body.query ?? ''),
        domain: String(body.domain ?? ''),
        ...(typeof body.skill === 'string' ? { skill: body.skill } : {}),
        ...(Array.isArray(body.targetUrls) ? { targetUrls: body.targetUrls as string[] } : {}),
      }),
    );
  });

  router.post('/omniresearch/harvest', async (req, res) => {
    const body = (req.body ?? {}) as { query?: unknown; maxPerSource?: unknown };
    const max = Number(body.maxPerSource);
    send(res, await omniMultiHarvest(String(body.query ?? ''), Number.isFinite(max) ? max : 5));
  });

  router.post('/omniresearch/ask', async (req, res) => {
    const body = (req.body ?? {}) as { query?: unknown; domain?: unknown; mode?: unknown };
    const query = String(body.query ?? '').trim();
    if (!query) return res.status(400).json({ available: false, error: 'query is required' });
    const mode = typeof body.mode === 'string' ? body.mode : 'auto';
    if (mode === 'harvest') return send(res, await omniMultiHarvest(query));
    if (mode === 'deep') {
      return send(
        res,
        await omniDeepResearch({ query, domain: String(body.domain ?? 'general') }),
      );
    }
    if (mode === 'loop') return send(res, await omniAutonomousLoop(query, { maxIterations: 1 }));
    // auto: light LLM synthesis first (fast); deep research is explicit.
    send(res, await omniLlmResearch(query));
  });

  router.post('/omniresearch/autonomous-loop', async (req, res) => {
    const body = (req.body ?? {}) as { topic?: unknown; sector?: unknown; maxIterations?: unknown };
    const max = Number(body.maxIterations);
    send(
      res,
      await omniAutonomousLoop(String(body.topic ?? ''), {
        ...(typeof body.sector === 'string' ? { sector: body.sector } : {}),
        ...(Number.isFinite(max) ? { maxIterations: max } : {}),
      }),
    );
  });

  router.get('/omniresearch/baseline-sources', async (req, res) => {
    const q = req.query as Record<string, string | undefined>;
    send(
      res,
      await omniBaselineSources({
        category: q.category,
        sector: q.sector,
        query: q.query,
        ...(q.minAuthority !== undefined ? { minAuthority: Number(q.minAuthority) } : {}),
      }),
    );
  });

  router.post('/omniresearch/jev', async (req, res) => {
    const body = (req.body ?? {}) as { domain?: unknown; riskPenaltyLambda?: unknown };
    send(
      res,
      await omniJevDecision({
        ...(typeof body.domain === 'string' ? { domain: body.domain } : {}),
        ...(typeof body.riskPenaltyLambda === 'number' ? { riskPenaltyLambda: body.riskPenaltyLambda } : {}),
      }),
    );
  });

  router.post('/omniresearch/marketing/:kind', async (req, res) => {
    const kind = req.params.kind as
      | 'competitive-brief'
      | 'campaign-plan'
      | 'brand-review'
      | 'outreach-sequence'
      | 'content-multiplier'
      | 'lead-magnet';
    const allowed = new Set([
      'competitive-brief',
      'campaign-plan',
      'brand-review',
      'outreach-sequence',
      'content-multiplier',
      'lead-magnet',
    ]);
    if (!allowed.has(kind)) return res.status(400).json({ available: false, error: `unknown marketing kind: ${kind}` });
    send(res, await omniMarketing(kind, (req.body ?? {}) as Record<string, unknown>));
  });

  router.post('/omniresearch/mcp/call', async (req, res) => {
    const body = (req.body ?? {}) as { name?: unknown; arguments?: unknown };
    const name = String(body.name ?? '');
    if (!name) return res.status(400).json({ available: false, error: 'name is required' });
    const args = (body.arguments && typeof body.arguments === 'object' ? body.arguments : {}) as Record<string, unknown>;
    send(res, await omniMcpCall(name, args));
  });

  router.get('/omniresearch/ecosystem/status', async (_req, res) => send(res, await omniEcosystemStatus()));
  router.get('/omniresearch/axiom-exemplars', async (req, res) => {
    const goal = typeof req.query.goal === 'string' ? req.query.goal : '';
    const max = Number(req.query.max) || 5;
    send(res, await omniAxiomExemplars(goal, max));
  });

  /**
   * Generic escape hatch: POST /omniresearch/invoke
   * body: { capabilityId } | { method, path, body }
   * Resolves against the static OMNI_CAPABILITIES catalog so callers can
   * reach any wired Omni route without OpenHub shipping a new handler.
   */
  router.post('/omniresearch/invoke', async (req, res) => {
    const body = (req.body ?? {}) as {
      capabilityId?: unknown;
      method?: unknown;
      path?: unknown;
      body?: unknown;
    };
    if (typeof body.capabilityId === 'string' && body.capabilityId) {
      const cap = OMNI_CAPABILITIES.find((c) => c.id === body.capabilityId);
      if (!cap) return res.status(400).json({ available: false, error: `unknown capabilityId: ${body.capabilityId}` });
      const payload = (body.body ?? {}) as Record<string, unknown>;
      send(res, await omniInvoke(cap.method, cap.path, cap.kind === 'query' ? undefined : payload));
      return;
    }
    const method = typeof body.method === 'string' ? body.method : 'POST';
    const path = typeof body.path === 'string' ? body.path : '';
    if (!path.startsWith('/api/')) {
      return res.status(400).json({ available: false, error: 'path must start with /api/' });
    }
    send(res, await omniInvoke(method, path, body.body));
  });

  return router;
}
