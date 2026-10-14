import express from 'express';
import { operatorGateFor, requireOperator } from '../lib/operator.js';
import {
  getEngineStatus,
  providerCount,
  listProjects,
  listSessions,
  getSession,
  sessionMessages,
  createSession,
  promptSessionAsync,
  type PromptOptions,
  abortSession,
  revertSession,
  unrevertSession,
  sessionTodos,
  sessionDiff,
  respondPermission,
  eventsRaw,
} from '../services/opencodeClient.js';
import { startOpencodeEngine, stopOpencodeEngine } from '../services/opencodeEngine.js';
import { recordReceipt } from '../services/receipts.js';

/** Message from an unknown thrown value without assuming it is an Error. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}


/**
 * One upstream `/event` connection shared by every browser client. Without this
 * each open tab held its own engine connection. If the upstream drops, all
 * clients are ended so their reconnect logic re-subscribes; a client that falls
 * more than 1 MiB behind is dropped rather than buffered without bound.
 */
function createEventHub() {
  const clients = new Set<express.Response>();
  let connecting: Promise<void> | null = null;
  let abort: AbortController | null = null;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  // Pings are only injected on an SSE frame boundary; a ping spliced into a
  // half-written `data:` line corrupts the event.
  let atBoundary = true;
  const MAX_BACKLOG = 1 << 20;

  function stop(): void {
    if (heartbeat) { clearInterval(heartbeat); heartbeat = undefined; }
    const ac = abort;
    abort = null;
    ac?.abort();
    for (const c of clients) { try { c.end(); } catch { /* closed */ } }
    clients.clear();
  }

  function broadcast(buf: Buffer): void {
    for (const c of clients) {
      if (c.writableEnded) { clients.delete(c); continue; }
      if (c.writableLength > MAX_BACKLOG) { try { c.end(); } catch { /* closed */ } clients.delete(c); continue; }
      try { c.write(buf); } catch { clients.delete(c); }
    }
  }

  async function pump(body: ReadableStream<Uint8Array>, ac: AbortController): Promise<void> {
    const reader = body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const buf = Buffer.from(value);
        atBoundary = buf.length >= 2 && buf[buf.length - 1] === 0x0a && buf[buf.length - 2] === 0x0a;
        broadcast(buf);
      }
    } catch { /* upstream dropped or aborted */ }
    if (abort === ac) stop();
  }

  return {
    async ensure(): Promise<void> {
      if (abort) return;
      if (!connecting) {
        connecting = (async () => {
          const ac = new AbortController();
          const up = await eventsRaw(ac.signal);
          if (!up.ok || !up.body) throw new Error(`upstream HTTP ${up.status}`);
          abort = ac;
          atBoundary = true;
          heartbeat = setInterval(() => { if (atBoundary) broadcast(Buffer.from(': ping\n\n')); }, 15_000);
          void pump(up.body as ReadableStream<Uint8Array>, ac);
        })().finally(() => { connecting = null; });
      }
      return connecting;
    },
    add(res: express.Response): void { clients.add(res); },
    remove(res: express.Response): void {
      clients.delete(res);
      if (clients.size === 0 && abort) stop();
    },
  };
}

export function createOpencodeProxyRouter(deps: { authMiddleware: express.RequestHandler }): express.Router {
  const router = express.Router();
  const hub = createEventHub();
  router.use(deps.authMiddleware);
  // Audit trail: every state-changing opencode call (including ones the operator
  // gate below rejects) leaves a hash-chained receipt. Bodies are never logged,
  // only who/what/outcome; the permission verdict is recorded because it is the
  // decision. Best-effort: auditing can never fail a request.
  router.use((req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    res.on('finish', () => {
      try {
        const sub = (req as unknown as { user?: { sub?: unknown } }).user?.sub;
        const verdict = /\/permissions\//.test(req.path) ? req.body?.response : undefined;
        recordReceipt({
          kind: 'decision',
          tool: 'opencode',
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
  // Operator gate (OPENHUB_ADMIN_ROLES): these start/stop the engine and start
  // or abort agent sessions, so an ordinary authenticated account must not reach
  // them. GET routes (status, sessions reads, events) are unaffected.
  // Reads expose agent prompts, file contents and diffs, so with a configured
  // OPENHUB_ADMIN_ROLES gate they are operator-only too (status stays open: the
  // header chip polls it for every signed-in user). Gate unset = unchanged.
  router.use((req, res, next) => {
    if (req.method !== 'GET' || /^\/opencode\/status\/?$/i.test(req.path)) return next();
    requireOperator(req, res, next);
  });
  router.use(operatorGateFor([
    /^\/opencode\/engine\/(start|stop)\/?$/,
    /^\/opencode\/sessions\/?$/,
    // prompt_async is the mid-run "steer" endpoint; revert/unrevert rewind history.
    /^\/opencode\/sessions\/[^/]+\/(prompt|prompt_async|abort|revert|unrevert)\/?$/,
    // answering a permission prompt approves a shell/edit action by the agent.
    /^\/opencode\/sessions\/[^/]+\/permissions\/[^/]+\/?$/,
  ]));

  router.get('/opencode/status', async (_req, res) => {
    try {
      const health = await getEngineStatus();
      // Availability is the question this route answers, so an unreachable
      // engine is data (`available: false` + the reason), not a 502.
      const available = health?.healthy === true || health?.available === true;
      res.json({
        ok: true,
        data: { ...(health ?? {}), available, ...(available ? { providerCount: await providerCount() } : {}) },
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
      const limit = n != null && Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), 1), 1000) : undefined;
      res.json({ ok: true, data: await sessionMessages(req.params.id, limit) });
    } catch (err) { res.status(502).json({ ok: false, error: errorMessage(err) }); }
  });

  // `/prompt` and `/prompt_async` (mid-run "steer", opencode's own name) are the
  // same operation. An empty prompt is a client error, not something to forward.
  const promptHandler: express.RequestHandler = async (req, res) => {
    const parts = Array.isArray(req.body?.parts) ? req.body.parts : [];
    if (parts.length === 0 || parts.length > 20
      || !parts.every((p: unknown) => !!p && typeof p === 'object' && typeof (p as { type?: unknown }).type === 'string')) {
      res.status(400).json({ ok: false, error: 'parts must be 1-20 objects with a string `type`' });
      return;
    }
    const opts: PromptOptions = {};
    const m = req.body?.model;
    if (m != null) {
      if (typeof m !== 'object' || typeof m.providerID !== 'string' || typeof m.modelID !== 'string' || !m.providerID || !m.modelID) {
        res.status(400).json({ ok: false, error: 'model must be { providerID, modelID }' });
        return;
      }
      opts.model = { providerID: m.providerID, modelID: m.modelID };
    }
    const agent = req.body?.agent;
    if (agent != null) {
      if (typeof agent !== 'string' || !/^[\w.-]{1,64}$/.test(agent)) {
        res.status(400).json({ ok: false, error: 'agent must be a short identifier' });
        return;
      }
      opts.agent = agent;
    }
    try { res.json({ ok: true, data: await promptSessionAsync(req.params.id, parts, opts) }); }
    catch (err) { res.status(502).json({ ok: false, error: errorMessage(err) }); }
  };
  router.post('/opencode/sessions/:id/prompt', promptHandler);
  router.post('/opencode/sessions/:id/prompt_async', promptHandler);

  // Answer an agent permission request (the agent blocks until this arrives).
  router.post('/opencode/sessions/:id/permissions/:permissionID', async (req, res) => {
    const response = req.body?.response;
    if (response !== 'once' && response !== 'always' && response !== 'reject') {
      res.status(400).json({ ok: false, error: "response must be 'once', 'always' or 'reject'" });
      return;
    }
    try { res.json({ ok: true, data: await respondPermission(req.params.id, req.params.permissionID, response) }); }
    catch (err) { res.status(502).json({ ok: false, error: errorMessage(err) }); }
  });

  router.post('/opencode/sessions/:id/abort', async (req, res) => {
    try { res.json({ ok: true, data: await abortSession(req.params.id) }); }
    catch (err) { res.status(502).json({ ok: false, error: errorMessage(err) }); }
  });

  // Rewind the session to just before a message. `messageID` is required, so a
  // missing one is a client error (400), not a forward attempt to the engine.
  router.post('/opencode/sessions/:id/revert', async (req, res) => {
    const messageID = typeof req.body?.messageID === 'string' ? req.body.messageID.trim() : '';
    if (!messageID) {
      res.status(400).json({ ok: false, error: 'messageID is required' });
      return;
    }
    try { res.json({ ok: true, data: await revertSession(req.params.id, messageID) }); }
    catch (err) { res.status(502).json({ ok: false, error: errorMessage(err) }); }
  });

  router.post('/opencode/sessions/:id/unrevert', async (req, res) => {
    try { res.json({ ok: true, data: await unrevertSession(req.params.id) }); }
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
    try { await hub.ensure(); }
    catch (err) { res.status(502).json({ ok: false, error: errorMessage(err) }); return; }
    if (res.destroyed) return;
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    hub.add(res);
    res.on('close', () => hub.remove(res));
  });

  return router;
}
