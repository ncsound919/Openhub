import express from 'express';
import { operatorGateFor } from '../lib/operator.js';
import {
  getEngineStatus,
  listProjects,
  listSessions,
  getSession,
  sessionMessages,
  createSession,
  promptSessionAsync,
  abortSession,
  sessionTodos,
  sessionDiff,
  eventsRaw,
} from '../services/opencodeClient.js';
import { startOpencodeEngine, stopOpencodeEngine } from '../services/opencodeEngine.js';

/** Message from an unknown thrown value without assuming it is an Error. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createOpencodeProxyRouter(deps: { authMiddleware: express.RequestHandler }): express.Router {
  const router = express.Router();
  router.use(deps.authMiddleware);
  // Operator gate (OPENHUB_ADMIN_ROLES): these start/stop the engine and start
  // or abort agent sessions, so an ordinary authenticated account must not reach
  // them. GET routes (status, sessions reads, events) are unaffected.
  router.use(operatorGateFor([
    /^\/opencode\/engine\/(start|stop)\/?$/,
    /^\/opencode\/sessions\/?$/,
    /^\/opencode\/sessions\/[^/]+\/(prompt|abort)\/?$/,
  ]));

  router.get('/opencode/status', async (_req, res) => {
    try {
      const health = await getEngineStatus();
      // Availability is the question this route answers, so an unreachable
      // engine is data (`available: false` + the reason), not a 502.
      res.json({
        ok: true,
        data: { ...(health ?? {}), available: health?.healthy === true || health?.available === true },
      });
    } catch (err) {
      res.json({ ok: true, data: { available: false, error: errorMessage(err) } });
    }
  });

  router.post('/opencode/engine/start', async (_req, res) => {
    try { res.json({ ok: true, data: await startOpencodeEngine() }); }
    catch (err) { res.status(502).json({ ok: false, error: errorMessage(err) }); }
  });

  router.post('/opencode/engine/stop', async (_req, res) => {
    try { res.json({ ok: true, data: await stopOpencodeEngine() }); }
    catch (err) { res.status(502).json({ ok: false, error: errorMessage(err) }); }
  });

  router.get('/opencode/projects', async (_req, res) => {
    try { res.json({ ok: true, data: await listProjects() }); }
    catch (err) { res.status(502).json({ ok: false, error: errorMessage(err) }); }
  });

  router.get('/opencode/sessions', async (_req, res) => {
    try { res.json({ ok: true, data: await listSessions() }); }
    catch (err) { res.status(502).json({ ok: false, error: errorMessage(err) }); }
  });

  router.post('/opencode/sessions', async (req, res) => {
    try {
      const title = typeof req.body?.title === 'string' ? req.body.title : undefined;
      res.json({ ok: true, data: await createSession(title) });
    } catch (err) { res.status(502).json({ ok: false, error: errorMessage(err) }); }
  });

  router.get('/opencode/sessions/:id', async (req, res) => {
    try { res.json({ ok: true, data: await getSession(req.params.id) }); }
    catch (err) { res.status(502).json({ ok: false, error: errorMessage(err) }); }
  });

  router.get('/opencode/sessions/:id/messages', async (req, res) => {
    try {
      const raw = req.query.limit;
      const n = raw == null || String(raw).trim() === '' ? undefined : Number(raw);
      const limit = n != null && Number.isFinite(n) ? n : undefined;
      res.json({ ok: true, data: await sessionMessages(req.params.id, limit) });
    } catch (err) { res.status(502).json({ ok: false, error: errorMessage(err) }); }
  });

  router.post('/opencode/sessions/:id/prompt', async (req, res) => {
    try {
      const parts = Array.isArray(req.body?.parts) ? req.body.parts : [];
      res.json({ ok: true, data: await promptSessionAsync(req.params.id, parts) });
    } catch (err) { res.status(502).json({ ok: false, error: errorMessage(err) }); }
  });

  router.post('/opencode/sessions/:id/abort', async (req, res) => {
    try { res.json({ ok: true, data: await abortSession(req.params.id) }); }
    catch (err) { res.status(502).json({ ok: false, error: errorMessage(err) }); }
  });

  router.get('/opencode/sessions/:id/todos', async (req, res) => {
    try { res.json({ ok: true, data: await sessionTodos(req.params.id) }); }
    catch (err) { res.status(502).json({ ok: false, error: errorMessage(err) }); }
  });

  router.get('/opencode/sessions/:id/diff', async (req, res) => {
    try { res.json({ ok: true, data: await sessionDiff(req.params.id) }); }
    catch (err) { res.status(502).json({ ok: false, error: errorMessage(err) }); }
  });

  // Live event stream: pipe opencode's SSE frames straight through, no buffering.
  router.get('/opencode/events', async (_req, res) => {
    try {
      const upstream = await eventsRaw();
      if (!upstream.ok || !upstream.body) {
        res.status(502).json({ ok: false, error: `upstream HTTP ${upstream.status}` });
        return;
      }
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders?.();
      const reader = (upstream.body as ReadableStream<Uint8Array>).getReader();
      res.on('close', () => { if (!res.writableEnded) { try { void reader.cancel(); } catch { /* already closed */ } } });
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
      res.end();
    } catch (err) { res.status(502).json({ ok: false, error: errorMessage(err) }); }
  });

  return router;
}
