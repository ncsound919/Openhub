/**
 * Workbench routes — the settings surface plus the tool proxy.
 *
 *   GET  /api/workbench/config       effective config (token never returned)
 *   PUT  /api/workbench/config       validated partial update
 *   GET  /api/workbench/health       liveness probe (?start=1 also auto-starts)
 *   POST /api/workbench/start        start it now, report why if it cannot
 *   GET  /api/workbench/tools        tool manifest
 *   POST /api/workbench/call         { tool, arguments }
 *   POST /api/workbench/context      { query } -> injectable context block
 *   GET  /api/workbench/mcp-config   MCP entries for an agent's config
 *
 * All routes sit behind the normal OpenHub session auth. The token field is
 * write-only: `hasToken` tells the UI whether one is stored, nothing returns it.
 */

import express from 'express';
import {
  ensureWorkbench,
  loadWorkbenchConfig,
  mcpConfigSnippet,
  publicConfig,
  saveWorkbenchConfig,
  workbenchCall,
  workbenchContext,
  workbenchHealth,
  workbenchTools,
  type ConfigPatch
} from '../services/workbenchClient.js';

const PATCH_KEYS = new Set([
  'enabled',
  'url',
  'token',
  'clearToken',
  'autoStart',
  'autoContext',
  'contextTimeoutMs',
  'projectId',
  'contextBudgetTokens',
  'workbenchRoot',
  'allowRemote'
]);

export function createWorkbenchRouter(deps: { authMiddleware: express.RequestHandler }): express.Router {
  const router = express.Router();
  router.use(deps.authMiddleware);

  router.get('/workbench/config', (_req, res) => {
    try {
      res.json({ ok: true, config: publicConfig(loadWorkbenchConfig()) });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'config read failed' });
    }
  });

  router.put('/workbench/config', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const unknown = Object.keys(body).filter((key) => !PATCH_KEYS.has(key));
    if (unknown.length > 0) {
      res.status(400).json({ ok: false, error: `unknown setting(s): ${unknown.join(', ')}` });
      return;
    }
    if (body.url !== undefined && (typeof body.url !== 'string' || !body.url.trim())) {
      res.status(400).json({ ok: false, error: 'url must be a non-empty string' });
      return;
    }
    if (body.workbenchRoot !== undefined && (typeof body.workbenchRoot !== 'string' || !body.workbenchRoot.trim())) {
      res.status(400).json({ ok: false, error: 'workbenchRoot must be a non-empty string' });
      return;
    }
    if (body.token !== undefined && typeof body.token !== 'string') {
      res.status(400).json({ ok: false, error: 'token must be a string' });
      return;
    }
    if (body.contextTimeoutMs !== undefined) {
      if (typeof body.contextTimeoutMs !== 'number' || !Number.isFinite(body.contextTimeoutMs)) {
        res.status(400).json({ ok: false, error: 'contextTimeoutMs must be a number' });
        return;
      }
    }
    if (body.projectId !== undefined) {
      if (typeof body.projectId !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(body.projectId.trim())) {
        res.status(400).json({ ok: false, error: 'projectId must be 1-40 chars of letters, digits, _ or -' });
        return;
      }
    }
    if (body.contextBudgetTokens !== undefined) {
      if (typeof body.contextBudgetTokens !== 'number' || !Number.isFinite(body.contextBudgetTokens)) {
        res.status(400).json({ ok: false, error: 'contextBudgetTokens must be a number' });
        return;
      }
    }

    try {
      const patch: ConfigPatch = {
        ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
        ...(typeof body.autoStart === 'boolean' ? { autoStart: body.autoStart } : {}),
        ...(typeof body.autoContext === 'boolean' ? { autoContext: body.autoContext } : {}),
        ...(typeof body.allowRemote === 'boolean' ? { allowRemote: body.allowRemote } : {}),
        ...(typeof body.url === 'string' ? { url: body.url.trim() } : {}),
        ...(typeof body.workbenchRoot === 'string' ? { workbenchRoot: body.workbenchRoot.trim() } : {}),
        ...(typeof body.token === 'string' && body.token.trim() ? { token: body.token.trim() } : {}),
        ...(body.clearToken === true ? { clearToken: true } : {}),
        ...(typeof body.contextTimeoutMs === 'number' ? { contextTimeoutMs: body.contextTimeoutMs } : {}),
        ...(typeof body.projectId === 'string' ? { projectId: body.projectId.trim() } : {}),
        ...(typeof body.contextBudgetTokens === 'number' ? { contextBudgetTokens: body.contextBudgetTokens } : {})
      };
      const config = saveWorkbenchConfig(patch);
      res.json({ ok: true, config });
    } catch (err) {
      res.status(400).json({ ok: false, error: err instanceof Error ? err.message : 'config write failed' });
    }
  });

  router.get('/workbench/health', async (req, res) => {
    const config = loadWorkbenchConfig();
    if (req.query.start === '1') {
      const started = await ensureWorkbench(config);
      const health = await workbenchHealth(config);
      res.json({ ok: started.ok && health.ok, started, health });
      return;
    }
    res.json({ ok: true, health: await workbenchHealth(config) });
  });

  router.post('/workbench/start', async (_req, res) => {
    const config = loadWorkbenchConfig();
    const started = await ensureWorkbench(config);
    res.status(started.ok ? 200 : 503).json({
      ok: started.ok,
      started,
      health: await workbenchHealth(config)
    });
  });

  router.get('/workbench/tools', async (_req, res) => {
    try {
      const tools = await workbenchTools();
      res.json({ ok: true, tools });
    } catch (err) {
      res.status(502).json({
        ok: false,
        error: err instanceof Error ? err.message : 'workbench unreachable',
        tools: []
      });
    }
  });

  router.post('/workbench/call', async (req, res) => {
    const tool = typeof req.body?.tool === 'string' ? req.body.tool.trim() : '';
    if (!tool) {
      res.status(400).json({ ok: false, error: 'tool is required' });
      return;
    }
    const args = req.body?.arguments;
    if (args !== undefined && (args === null || typeof args !== 'object' || Array.isArray(args))) {
      res.status(400).json({ ok: false, error: 'arguments must be an object' });
      return;
    }
    const result = await workbenchCall(tool, (args ?? {}) as Record<string, unknown>);
    // A transport failure is a gateway problem; a rejected call is a 200 with
    // ok:false, because the workbench did answer and the model can read why.
    res.status(result.unreachable ? 502 : 200).json({ ok: result.ok, result });
  });

  router.post('/workbench/context', async (req, res) => {
    const query = typeof req.body?.query === 'string' ? req.body.query.trim() : '';
    if (!query) {
      res.status(400).json({ ok: false, error: 'query is required' });
      return;
    }
    const maxLessons = typeof req.body?.maxLessons === 'number' ? req.body.maxLessons : undefined;
    const context = await workbenchContext(query, { maxLessons });
    if (!context) {
      res.status(502).json({ ok: false, error: 'workbench unreachable or returned no context' });
      return;
    }
    res.json({ ok: true, ...context });
  });

  router.get('/workbench/mcp-config', (_req, res) => {
    try {
      res.json({ ok: true, ...mcpConfigSnippet(loadWorkbenchConfig()) });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'could not build MCP config' });
    }
  });

  return router;
}
