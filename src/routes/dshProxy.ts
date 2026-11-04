import express from 'express';
import { operatorGateFor, requireOperator } from '../lib/operator.js';
import { recordReceipt } from '../services/receipts.js';
import {
  dshEngineHealth,
  startDshEngine,
  stopDshEngine,
  pendingDshApprovals,
  respondDshApproval,
  readDshEngineConfig,
  listDshSessions,
  createDshSession,
  getDshSessionInfo,
  runDshPrompt,
  dshSessionMessages,
  dshNotifications,
  type DshApprovalOutcome,
} from '../services/dshEngine.js';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * dshProxy.ts — phase 1 surface of the DeepSeek Harness engine
 * (`DEEPSEEK-HARNESS-SWAP.md`): status, engine lifecycle and the operator
 * approval bridge. Session/prompt/event routes land in phase 2, consumed by
 * Mission Control behind `OPENHUB_AGENT_ENGINE=dsh`.
 *
 * Gate + receipt conventions match opencodeProxy exactly: every state-changing
 * call is operator-gated (GET status stays open — the header chip polls it)
 * and leaves a hash-chained receipt; bodies are never logged.
 */
export function createDshProxyRouter(deps: {
  authMiddleware: express.RequestHandler;
}): express.Router {
  const router = express.Router();
  router.use(deps.authMiddleware);
  router.use((req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    res.on('finish', () => {
      try {
        const sub = (req as unknown as { user?: { sub?: unknown } }).user?.sub;
        const verdict = /\/approvals\//.test(req.path) ? req.body?.outcome : undefined;
        recordReceipt({
          kind: 'decision',
          tool: 'dsh',
          command: `${req.method} ${req.baseUrl}${req.path}`,
          status: res.statusCode < 400 ? 'passed' : 'failed',
          startedAt,
          durationMs: Date.now() - t0,
          ...(typeof sub === 'string' ? { userId: sub } : {}),
          meta: { httpStatus: res.statusCode, ...(typeof verdict === 'string' ? { verdict } : {}) },
        });
      } catch { /* audit is best-effort */ }
    });
    next();
  });
  router.use((req, res, next) => {
    if (req.method !== 'GET' || /^\/dsh\/status\/?$/i.test(req.path)) return next();
    requireOperator(req, res, next);
  });
  router.use(operatorGateFor([
    /^\/dsh\/engine\/(start|stop)\/?$/,
    // answering an approval grants shell/edit/file rights for one call.
    /^\/dsh\/approvals\/[^/]+\/?$/,
    /^\/dsh\/approvals\/?$/,
    // creating a session scopes an agent to a directory; prompting spends provider budget.
    /^\/dsh\/sessions\/?$/,
    /^\/dsh\/sessions\/[^/]+\/prompt\/?$/,
  ]));

  router.get('/dsh/status', async (_req, res) => {
    try {
      const health = await dshEngineHealth();
      const config = readDshEngineConfig();
      res.json({
        ok: true,
        data: {
          ...health,
          available: health.available,
          engine: 'dsh',
          config: {
            profile: config.profile,
            dshHome: config.home,
            provider: config.provider || '(engine default)',
            model: config.model || '(engine default)',
            effort: config.effort || '(engine default)',
            maxTokens: config.maxTokens > 0 ? config.maxTokens : null,
            approvals: config.approvals,
          },
        },
      });
    } catch (err) {
      res.json({ ok: true, data: { available: false, error: errorMessage(err) } });
    }
  });

  router.post('/dsh/engine/start', async (_req, res) => {
    try { res.json({ ok: true, data: await startDshEngine() }); }
    catch (err) { res.status(502).json({ ok: false, error: errorMessage(err) }); }
  });

  router.post('/dsh/engine/stop', async (_req, res) => {
    try { res.json({ ok: true, data: await stopDshEngine() }); }
    catch (err) { res.status(502).json({ ok: false, error: errorMessage(err) }); }
  });

  router.get('/dsh/approvals', async (_req, res) => {
    res.json({ ok: true, data: pendingDshApprovals() });
  });

  // Session + prompt surface (phase 2 of the swap). Reads mirror the
  // opencode proxy: with admin roles configured they are operator-only (the
  // GET middleware above); status stays open for the header chip.
  router.get('/dsh/sessions', async (_req, res) => {
    try { res.json({ ok: true, data: listDshSessions() }); }
    catch (err) { res.status(502).json({ ok: false, error: errorMessage(err) }); }
  });

  router.post('/dsh/sessions', async (req, res) => {
    try {
      const body = (req.body ?? {}) as { workingDirectory?: unknown; resumeId?: unknown };
      if (body.workingDirectory !== undefined && typeof body.workingDirectory !== 'string') {
        res.status(400).json({ ok: false, error: 'workingDirectory must be a string' });
        return;
      }
      if (body.resumeId !== undefined && typeof body.resumeId !== 'string') {
        res.status(400).json({ ok: false, error: 'resumeId must be a string' });
        return;
      }
      res.json({ ok: true, data: await createDshSession({ workingDirectory: body.workingDirectory, resumeId: body.resumeId }) });
    } catch (err) {
      const message = errorMessage(err);
      const status = /not started/.test(message) ? 502
        : /absolute|does not exist|not a directory|resume/.test(message) ? 400
        : 502;
      res.status(status).json({ ok: false, error: message });
    }
  });

  router.get('/dsh/sessions/:id', async (req, res) => {
    try {
      const info = await getDshSessionInfo(String(req.params.id));
      if (!info) { res.status(404).json({ ok: false, error: 'no such dsh session (engine restarted?)' }); return; }
      res.json({ ok: true, data: info });
    } catch (err) { res.status(502).json({ ok: false, error: errorMessage(err) }); }
  });

  router.get('/dsh/sessions/:id/messages', async (req, res) => {
    try {
      const info = await getDshSessionInfo(String(req.params.id));
      if (!info) { res.status(404).json({ ok: false, error: 'no such dsh session (engine restarted?)' }); return; }
      const since = Number(req.query.since ?? '0');
      res.json({ ok: true, data: dshSessionMessages(info.id, Number.isFinite(since) && since >= 0 ? since : 0) });
    } catch (err) { res.status(502).json({ ok: false, error: errorMessage(err) }); }
  });

  router.post('/dsh/sessions/:id/prompt', async (req, res) => {
    try {
      const input = (req.body ?? {}).input;
      if (typeof input !== 'string' || !input.trim()) {
        res.status(400).json({ ok: false, error: 'input must be a non-empty string' });
        return;
      }
      res.json({ ok: true, data: await runDshPrompt(String(req.params.id), input) });
    } catch (err) {
      const message = errorMessage(err);
      const status = /no such dsh session/.test(message) ? 404
        : /non-empty|exceeds/.test(message) ? 400
        : 502;
      res.status(status).json({ ok: false, error: message });
    }
  });

  // The 0.2.2-alpha.3 SDK exposes no abort/revert/todo/diff surface, so these
  // answer 501 instead of silently misbehaving — Mission Control must not
  // treat them as working. They flip to real routes when the SDK grows them.
  for (const unsupported of ['abort', 'revert', 'unrevert', 'todos', 'diff'] as const) {
    router.post(`/dsh/sessions/:id/${unsupported}`, (_req, res) => {
      res.status(501).json({ ok: false, error: `dsh SDK 0.2.2-alpha.3 exposes no session ${unsupported}; opencode remains the engine for that action` });
    });
  }

  // Phase-3 preview: cursor-pollable notification stream off the engine ring.
  router.get('/dsh/events', async (req, res) => {
    try {
      const since = Number(req.query.since ?? '0');
      res.json({ ok: true, data: dshNotifications(Number.isFinite(since) && since >= 0 ? since : 0) });
    } catch (err) { res.status(502).json({ ok: false, error: errorMessage(err) }); }
  });

  router.post('/dsh/approvals/:id', async (req, res) => {
    const outcome = req.body?.outcome;
    if (!outcome || !['allowed-once', 'rejected', 'cancelled'].includes(outcome)) {
      res.status(400).json({ ok: false, error: 'outcome must be one of allowed-once, rejected, cancelled' });
      return;
    }
    const ok = respondDshApproval(String(req.params.id), outcome as DshApprovalOutcome);
    if (!ok) { res.status(404).json({ ok: false, error: 'no such pending approval (already answered?)' }); return; }
    res.json({ ok: true, data: { answered: String(req.params.id), outcome } });
  });

  return router;
}
