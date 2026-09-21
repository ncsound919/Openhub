import { Router, type RequestHandler } from 'express';

const DEFAULT_LLM_BASE_URL = 'http://127.0.0.1:4100';
const DEFAULT_LLM_MODEL = 'fleet-free';

interface ModelSummary {
  id: string;
  ownedBy: string | null;
}

/**
 * Read the configured LiteLLM gateway directly. This route is deliberately
 * observational: it never synthesizes metrics and does not send a completion.
 */
export function createIntelligenceRouter(deps: { authMiddleware: RequestHandler }): Router {
  const router = Router();
  router.use(deps.authMiddleware);

  router.get('/intelligence/llm', async (_req, res) => {
    const baseUrl = (process.env.OPENHUB_LLM_BASE_URL || process.env.LITELLM_URL || DEFAULT_LLM_BASE_URL).replace(/\/+$/, '');
    const configuredModel = process.env.OPENHUB_LLM_MODEL || DEFAULT_LLM_MODEL;
    const apiKey = process.env.OPENHUB_LLM_KEY || process.env.LITELLM_MASTER_KEY;
    const apiKeyConfigured = Boolean(apiKey);
    const checkedAt = new Date().toISOString();

    try {
      const modelsResponse = await fetch(`${baseUrl}/v1/models`, {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
        signal: AbortSignal.timeout(5_000),
      });
      if (!modelsResponse.ok) {
        return res.status(503).json({
          ok: false,
          checkedAt,
          baseUrl,
          configuredModel,
          apiKeyConfigured,
          models: [],
          error: `LiteLLM model catalog returned HTTP ${modelsResponse.status} ${modelsResponse.statusText}`,
        });
      }
      const payload = await modelsResponse.json() as { data?: Array<{ id?: unknown; owned_by?: unknown }> };
      const models: ModelSummary[] = Array.isArray(payload.data)
        ? payload.data
          .filter((model) => typeof model?.id === 'string' && model.id.trim() !== '')
          .map((model) => ({ id: String(model.id), ownedBy: typeof model.owned_by === 'string' ? model.owned_by : null }))
        : [];
      return res.json({ ok: true, checkedAt, baseUrl, configuredModel, apiKeyConfigured, models });
    } catch (err) {
      return res.status(503).json({
        ok: false,
        checkedAt,
        baseUrl,
        configuredModel,
        apiKeyConfigured,
        models: [],
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return router;
}
