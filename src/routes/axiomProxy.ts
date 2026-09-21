import express from 'express';
import {
  axiomFetch,
  getAxiomStatus,
  getAxiomCapabilities,
  startAxiomProjectLoop,
  getAxiomProjectStatus,
  stopAxiomProjectLoop,
  rewindAxiomProject,
  diffAxiomProject,
  shareAxiomProject,
  shareAxiomMission,
  runAxiomMission,
  getAxiomMissionStatus,
  listAxiomMissions,
  approveAxiomMission,
  rejectAxiomMission,
  listAxiomWorktrees,
  axiomWorktreeDiff,
  mergeAxiomWorktree,
  discardAxiomWorktree,
  listAxiomSkills,
  exportAxiomTelemetry,
  retrieveAxiom,
  listAxiomSessions,
  createAxiomSession,
  getAxiomSession,
  appendAxiomSessionMessages,
  axiomEditorApply,
  axiomEditorIndex,
  axiomEditorMentions,
  axiomEditorComplete,
  axiomEditorInlineEdit,
  axiomEditorLatencyProbe,
  axiomEditorNextEdit,
  axiomEditorModels,
  axiomLspDiagnostics,
  axiomEditorWarmStatus,
  axiomEditorWarmStart,
  axiomEditorWarmStop,
  axiomEditorChatRaw,
  axiomEditorCompleteStreamRaw,
  axiomEditorTelemetry,
  axiomEditorWatchStart,
  axiomEditorWatchList,
  axiomEditorWatchStop,
  axiomPrReviewDiff,
  listAxiomReviews,
  getAxiomReview,
  decideAxiomReview,
  applyAxiomReviewHunks,
  scanAxiomProspector,
  runAxiomAdversary,
  getAxiomAdversaryLatest,
  runAxiomProspectorCampaign,
} from '../services/axiomClient.js';
import { getActiveProject } from '../services/projectContext.js';
import { warmFimComplete } from '../services/localCompletion.js';

/** Message from an unknown thrown value without assuming it is an Error. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createAxiomProxyRouter(deps: { authMiddleware: express.RequestHandler }): express.Router {
  const router = express.Router();
  router.use(deps.authMiddleware);

  router.get('/axiom/status', async (_req, res) => {
    try {
      const status = await getAxiomStatus();
      res.json({ ok: true, data: status });
    } catch (err) {
      res.status(502).json({ ok: false, error: errorMessage(err) });
    }
  });

  router.get('/axiom/capabilities', async (_req, res) => {
    try {
      const caps = await getAxiomCapabilities();
      res.json({ ok: true, data: caps });
    } catch (err) {
      res.status(502).json({ ok: false, error: errorMessage(err) });
    }
  });

  router.post('/axiom/project/run', async (req, res) => {
    try {
      const { goal, maxIterations, modelRoute } = req.body ?? {};
      if (typeof goal !== 'string' || goal.trim() === '') {
        return res.status(400).json({ ok: false, error: 'goal is required' });
      }
      const userId = (req.user as unknown as { sub?: unknown } | undefined)?.sub;
      if (typeof userId !== 'string' || userId.trim() === '') {
        return res.status(401).json({ ok: false, error: 'Authentication required' });
      }
      const project = getActiveProject(userId);
      if (!project) {
        return res.status(409).json({ ok: false, code: 'NO_ACTIVE_PROJECT', error: 'Load a project before starting Axiom' });
      }
      const run = await startAxiomProjectLoop({ goal: goal.trim(), targetDir: project.path, maxIterations, modelRoute });
      res.json({ ok: true, project, data: run });
    } catch (err) {
      res.status(502).json({ ok: false, error: errorMessage(err) });
    }
  });

  router.get('/axiom/project/status/:id', async (req, res) => {
    try {
      const status = await getAxiomProjectStatus(req.params.id);
      res.json({ ok: true, data: status });
    } catch (err) {
      res.status(502).json({ ok: false, error: errorMessage(err) });
    }
  });

  router.post('/axiom/project/stop/:id', async (req, res) => {
    try {
      const result = await stopAxiomProjectLoop(req.params.id);
      res.json({ ok: true, data: result });
    } catch (err) {
      res.status(502).json({ ok: false, error: errorMessage(err) });
    }
  });

  router.post('/axiom/project/rewind/:id', async (req, res) => {
    try {
      const result = await rewindAxiomProject(req.params.id);
      res.json({ ok: true, data: result });
    } catch (err) {
      res.status(502).json({ ok: false, error: errorMessage(err) });
    }
  });

  router.get('/axiom/project/diff/:id', async (req, res) => {
    try {
      const result = await diffAxiomProject(req.params.id);
      res.json({ ok: true, data: result });
    } catch (err) {
      res.status(502).json({ ok: false, error: errorMessage(err) });
    }
  });

  router.get('/axiom/project/share/:id', async (req, res) => {
    try {
      const result = await shareAxiomProject(req.params.id);
      res.json({ ok: true, data: result });
    } catch (err) {
      res.status(502).json({ ok: false, error: errorMessage(err) });
    }
  });

  router.get('/axiom/mission/share/:id', async (req, res) => {
    try {
      const result = await shareAxiomMission(req.params.id);
      res.json({ ok: true, data: result });
    } catch (err) {
      res.status(502).json({ ok: false, error: errorMessage(err) });
    }
  });

  router.post('/axiom/mission/run', async (req, res) => {
    try {
      const { goal, maxTasks, planGate, skills, concurrency } = req.body ?? {};
      if (typeof goal !== 'string' || goal.trim() === '') {
        return res.status(400).json({ ok: false, error: 'goal is required' });
      }
      const userId = (req.user as unknown as { sub?: unknown } | undefined)?.sub;
      if (typeof userId !== 'string' || userId.trim() === '') {
        return res.status(401).json({ ok: false, error: 'Authentication required' });
      }
      const project = getActiveProject(userId);
      if (!project) {
        return res.status(409).json({ ok: false, code: 'NO_ACTIVE_PROJECT', error: 'Load a project before starting Axiom' });
      }
      const run = await runAxiomMission({
        goal: goal.trim(),
        targetDir: project.path,
        maxTasks: maxTasks ? Number(maxTasks) : undefined,
        planGate: planGate === true,
        skills: Array.isArray(skills) ? skills.map(String) : undefined,
        concurrency: Number.isFinite(Number(concurrency)) ? Number(concurrency) : undefined,
      });
      res.json({ ok: true, project, data: run });
    } catch (err) {
      res.status(502).json({ ok: false, error: errorMessage(err) });
    }
  });

  router.get('/axiom/mission/status/:id', async (req, res) => {
    try {
      const status = await getAxiomMissionStatus(req.params.id);
      res.json({ ok: true, data: status });
    } catch (err) {
      res.status(502).json({ ok: false, error: errorMessage(err) });
    }
  });

  router.get('/axiom/mission/list', async (_req, res) => {
    try {
      const missions = await listAxiomMissions();
      res.json({ ok: true, data: missions });
    } catch (err) {
      res.status(502).json({ ok: false, error: errorMessage(err) });
    }
  });

  router.post('/axiom/mission/approve/:id', async (req, res) => {
    try {
      const by = typeof req.body?.by === 'string' ? req.body.by : undefined;
      const result = await approveAxiomMission(req.params.id, by);
      res.json({ ok: true, data: result });
    } catch (err) {
      res.status(502).json({ ok: false, error: errorMessage(err) });
    }
  });

  router.post('/axiom/mission/reject/:id', async (req, res) => {
    try {
      const reason = typeof req.body?.reason === 'string' ? req.body.reason : undefined;
      const result = await rejectAxiomMission(req.params.id, reason);
      res.json({ ok: true, data: result });
    } catch (err) {
      res.status(502).json({ ok: false, error: errorMessage(err) });
    }
  });

  // Worktree review: held worktrees per mission + diff / merge / discard.
  router.get('/axiom/mission/:id/worktrees', async (req, res) => {
    try { res.json({ ok: true, data: await listAxiomWorktrees(req.params.id) }); }
    catch (err) { res.status(502).json({ ok: false, error: errorMessage(err) }); }
  });

  router.get('/axiom/mission/:id/worktree/:taskId/diff', async (req, res) => {
    try { res.json({ ok: true, data: await axiomWorktreeDiff(req.params.id, req.params.taskId) }); }
    catch (err) { res.status(502).json({ ok: false, error: errorMessage(err) }); }
  });

  router.post('/axiom/mission/:id/worktree/:taskId/merge', async (req, res) => {
    try {
      const message = typeof req.body?.message === 'string' ? req.body.message : undefined;
      res.json({ ok: true, data: await mergeAxiomWorktree(req.params.id, req.params.taskId, message) });
    } catch (err) { res.status(502).json({ ok: false, error: errorMessage(err) }); }
  });

  router.post('/axiom/mission/:id/worktree/:taskId/discard', async (req, res) => {
    try { res.json({ ok: true, data: await discardAxiomWorktree(req.params.id, req.params.taskId) }); }
    catch (err) { res.status(502).json({ ok: false, error: errorMessage(err) }); }
  });

  router.get('/axiom/skills', async (_req, res) => {
    try {
      const skills = await listAxiomSkills();
      res.json({ ok: true, data: skills });
    } catch (err) {
      res.status(502).json({ ok: false, error: errorMessage(err) });
    }
  });

  router.get('/axiom/telemetry/export', async (_req, res) => {
    try {
      const telemetry = await exportAxiomTelemetry();
      res.json({ ok: true, data: telemetry });
    } catch (err) {
      res.status(502).json({ ok: false, error: errorMessage(err) });
    }
  });

  router.post('/axiom/retrieve', async (req, res) => {
    try {
      const { goal } = req.body ?? {};
      if (typeof goal !== 'string' || goal.trim() === '') {
        return res.status(400).json({ ok: false, error: 'goal is required' });
      }
      const userId = (req.user as unknown as { sub?: unknown } | undefined)?.sub;
      if (typeof userId !== 'string' || userId.trim() === '') {
        return res.status(401).json({ ok: false, error: 'Authentication required' });
      }
      const project = getActiveProject(userId);
      if (!project) {
        return res.status(409).json({ ok: false, code: 'NO_ACTIVE_PROJECT', error: 'Load a project before retrieving' });
      }
      const result = await retrieveAxiom(goal.trim(), project.path);
      res.json({ ok: true, project, data: result });
    } catch (err) {
      res.status(502).json({ ok: false, error: errorMessage(err) });
    }
  });

  router.get('/axiom/sessions', async (_req, res) => {
    try {
      const sessions = await listAxiomSessions();
      res.json({ ok: true, data: sessions });
    } catch (err) {
      res.status(502).json({ ok: false, error: errorMessage(err) });
    }
  });

  router.post('/axiom/sessions', async (req, res) => {
    try {
      const title = typeof req.body?.title === 'string' ? req.body.title : undefined;
      const session = await createAxiomSession(title);
      res.json({ ok: true, data: session });
    } catch (err) {
      res.status(502).json({ ok: false, error: errorMessage(err) });
    }
  });

  router.get('/axiom/sessions/:id', async (req, res) => {
    try {
      const session = await getAxiomSession(req.params.id);
      res.json({ ok: true, data: session });
    } catch (err) {
      res.status(502).json({ ok: false, error: errorMessage(err) });
    }
  });

  router.post('/axiom/sessions/:id/messages', async (req, res) => {
    try {
      const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
      const session = await appendAxiomSessionMessages(req.params.id, messages);
      res.json({ ok: true, data: session });
    } catch (err) {
      res.status(502).json({ ok: false, error: errorMessage(err) });
    }
  });

  // Editor bridge â€” thin pass-throughs to Axiom's /api/editor/* and Bugbot.
  // Each Axiom response is wrapped as { ok, data } to match the other proxies.
  const proxyGet = (fn: () => Promise<unknown>) => async (_req: express.Request, res: express.Response) => {
    try { res.json({ ok: true, data: await fn() }); }
    catch (err) { res.status(502).json({ ok: false, error: errorMessage(err) }); }
  };
  const proxyPost = <T = unknown>(fn: (body: T) => Promise<unknown>) => async (req: express.Request, res: express.Response) => {
    try { res.json({ ok: true, data: await fn(req.body as T) }); }
    catch (err) { res.status(502).json({ ok: false, error: errorMessage(err) }); }
  };

  // Streaming composer: pipe SSE frames from Axiom straight through, no buffering.
  router.post('/axiom/editor/chat', async (req, res) => {
    try {
      const upstream = await axiomEditorChatRaw({
        messages: Array.isArray(req.body?.messages) ? req.body.messages : [],
        tier: typeof req.body?.tier === 'string' ? req.body.tier : undefined,
        model: typeof req.body?.model === 'string' ? req.body.model : undefined,
      });
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

  // Editor telemetry: pass the event through (fire-and-forget from the client).
  router.post('/axiom/editor/telemetry', proxyPost((body) => axiomEditorTelemetry((body as { event?: unknown })?.event ?? body)));

  router.post('/axiom/editor/apply', proxyPost((body: Parameters<typeof axiomEditorApply>[0]) => axiomEditorApply(body)));
  router.post('/axiom/editor/index', proxyPost((body: Parameters<typeof axiomEditorIndex>[0]) => axiomEditorIndex(body)));
  router.post('/axiom/editor/mentions', proxyPost((body: Parameters<typeof axiomEditorMentions>[0]) => axiomEditorMentions(body)));
  // Timed editor-lane proxies (R6 item 1): `proxyMs` is OpenHub's own overhead
  // (auth + forward), separate from Axiom's `latencyMs`. Both are real measured
  // numbers so the Tab budget can be regressed instead of claimed.
  const timedPost = <T = unknown>(fn: (body: T) => Promise<unknown>) => async (req: express.Request, res: express.Response) => {
    const t0 = Date.now();
    try { res.json({ ok: true, proxyMs: Date.now() - t0, data: await fn(req.body as T) }); }
    catch (err) { res.status(502).json({ ok: false, proxyMs: Date.now() - t0, error: errorMessage(err) }); }
  };
  // Streaming completion lane: pipe Axiom's SSE frames straight through so the
  // editor can paint ghost text at first-token latency. Mirrors the chat pipe.
  router.post('/axiom/editor/complete-stream', async (req, res) => {
    try {
      const upstream = await axiomEditorCompleteStreamRaw(req.body ?? {});
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

  router.post('/axiom/editor/complete', async (req, res) => {    // Warm-first completion (R6 #2): call the local model directly through
    // OpenHub (one hop, no Axiom HMAC mint) and fall back to the Axiom proxy â€”
    // which adds retrieval + the chat lane + its own FIM â€” on any miss. The
    // warm path can only replace a completion Axiom's FIM lane would have
    // produced, so this never degrades the answer. `proxyMs` is OpenHub
    // overhead only and `data.latencyMs` is model-only, so the client's
    // `proxyMs + latencyMs` is the true total on both paths.
    const body = req.body ?? {};
    const t0 = Date.now();
    // Propagate a client disconnect to the model call. Must listen on `res`,
    // not `req`: Express emits `req`'s `close` as soon as the request body
    // stream ends, which aborts every call before the model is reached.
    const ctrl = new AbortController();
    res.on('close', () => { if (!res.writableEnded) ctrl.abort(); });
    try {
      const warm = await warmFimComplete(body, ctrl.signal);
      if (warm) {
        res.json({
          ok: true,
          warm: true,
          proxyMs: Math.max(0, Date.now() - t0 - warm.modelMs),
          data: { text: warm.text, source: 'local-model', lane: warm.lane, latencyMs: warm.modelMs, cached: warm.cached },
        });
        return;
      }
    } catch { /* any warm failure falls back to the proxy */ }
    const t1 = Date.now();
    try {
      res.json({ ok: true, warm: false, proxyMs: Date.now() - t1, data: await axiomEditorComplete(body) });
    } catch (err) {
      res.status(502).json({ ok: false, proxyMs: Date.now() - t0, error: errorMessage(err) });
    }
  });
  router.post('/axiom/editor/inline-edit', timedPost((body: Parameters<typeof axiomEditorInlineEdit>[0]) => axiomEditorInlineEdit(body)));
  router.post('/axiom/editor/latency-probe', timedPost((body: Parameters<typeof axiomEditorLatencyProbe>[0]) => axiomEditorLatencyProbe(body)));
  router.post('/axiom/editor/next-edit', proxyPost((body: Parameters<typeof axiomEditorNextEdit>[0]) => axiomEditorNextEdit(body)));
  // Real language-server diagnostics (Axiom runs typescript-language-server /
  // pyright). 503 is passed through honestly when no server is configured for
  // the file's language â€” the client then shows no markers, never fakes them.
  router.post('/axiom/editor/diagnostics', async (req, res) => {
    const file = typeof req.body?.file === 'string' ? req.body.file.trim() : '';
    if (!file) return res.status(400).json({ ok: false, error: 'file is required' });
    const rootDir = typeof req.body?.rootDir === 'string' && req.body.rootDir.trim() ? req.body.rootDir.trim() : undefined;
    try {
      const r = await axiomLspDiagnostics({ file, ...(rootDir ? { rootDir } : {}) });
      res.status(r.available ? 200 : 503).json({ ok: r.available, ...r });
    } catch (err) {
      res.status(502).json({ ok: false, error: errorMessage(err) });
    }
  });
  router.get('/axiom/editor/models', proxyGet(() => axiomEditorModels()));
  // Warm transport: keep the local model connection hot so the first Tab after
  // opening a project is instant. Fire-and-forget from the client.
  router.get('/axiom/editor/warm', proxyGet(() => axiomEditorWarmStatus()));
  router.post('/axiom/editor/warm/start', async (_req, res) => {
    try { res.json({ ok: true, data: await axiomEditorWarmStart() }); }
    catch (err) { res.status(502).json({ ok: false, error: errorMessage(err) }); }
  });
  router.post('/axiom/editor/warm/stop', async (_req, res) => {
    try { res.json({ ok: true, data: await axiomEditorWarmStop() }); }
    catch (err) { res.status(502).json({ ok: false, error: errorMessage(err) }); }
  });
  // Editor model picker (R6 gap): the cross-provider catalog for the grouped
  // dropdown, and the default-model setter. The setter merges into Axiom's
  // persisted settings store (`normalizeAxiomSettings` keeps only known keys).
  router.get('/axiom/editor/catalog', proxyGet(() => axiomFetch('/api/pipeline/models')));
  router.post('/axiom/editor/model', async (req, res) => {
    try {
      const model = typeof req.body?.model === 'string' ? req.body.model.trim() : '';
      if (!model) return res.status(400).json({ ok: false, error: 'model is required' });
      const settings = await axiomFetch('/api/settings', { method: 'POST', body: JSON.stringify({ model }) });
      res.json({ ok: true, data: settings });
    } catch (err) { res.status(502).json({ ok: false, error: errorMessage(err) }); }
  });
  router.post('/axiom/editor/index/watch', proxyPost((body: Parameters<typeof axiomEditorWatchStart>[0]) => axiomEditorWatchStart(body)));
  router.get('/axiom/editor/index/watch', proxyGet(() => axiomEditorWatchList()));
  router.post('/axiom/editor/index/watch/:id/stop', async (req, res) => {
    try { res.json({ ok: true, data: await axiomEditorWatchStop(req.params.id) }); }
    catch (err) { res.status(502).json({ ok: false, error: errorMessage(err) }); }
  });
  router.post('/axiom/pr/review-diff', proxyPost((body: Parameters<typeof axiomPrReviewDiff>[0]) => axiomPrReviewDiff(body)));

  // Diff-review queue: `queue` must be declared before `:id` so it matches first.
  router.get('/axiom/review/queue', proxyGet(() => listAxiomReviews()));
  router.get('/axiom/review/:id', async (req, res) => {
    try { res.json({ ok: true, data: await getAxiomReview(req.params.id) }); }
    catch (err) { res.status(502).json({ ok: false, error: errorMessage(err) }); }
  });
  router.post('/axiom/review/:id/decision', async (req, res) => {
    try {
      const decision = req.body?.decision === 'reject' ? 'reject' : 'approve';
      const note = typeof req.body?.note === 'string' ? req.body.note : undefined;
      res.json({ ok: true, data: await decideAxiomReview(req.params.id, decision, note) });
    } catch (err) { res.status(502).json({ ok: false, error: errorMessage(err) }); }
  });
  router.post('/axiom/review/:id/apply-hunks', async (req, res) => {
    try {
      const hunks = Array.isArray(req.body?.hunks) ? req.body.hunks : [];
      const note = typeof req.body?.note === 'string' ? req.body.note : undefined;
      res.json({ ok: true, data: await applyAxiomReviewHunks(req.params.id, hunks, note) });
    } catch (err) { res.status(502).json({ ok: false, error: errorMessage(err) }); }
  });

  // Antagonist: self-directed opportunities (Prospector) + verification strength
  // (Adversary). Read-only scan is a GET; the adversary temporarily rewrites and
  // restores files in the target, so it is a POST.
  router.get('/axiom/prospector/scan', async (req, res) => {
    try {
      const dir = typeof req.query.dir === 'string' ? req.query.dir : '';
      const top = Number(req.query.top) || 15;
      res.json({ ok: true, data: await scanAxiomProspector(dir, top) });
    } catch (err) { res.status(502).json({ ok: false, error: errorMessage(err) }); }
  });
  router.post('/axiom/prospector/run', proxyPost((body) => {
    const b = body as { dir?: unknown; count?: unknown; dryRun?: unknown };
    return runAxiomProspectorCampaign(String(b?.dir ?? ''), {
      count: Number(b?.count) || 2,
      dryRun: b?.dryRun === true,
    });
  }));
  router.post('/axiom/adversary/run', proxyPost((body) => {
    const b = body as { dir?: unknown; maxMutants?: unknown };
    return runAxiomAdversary(String(b?.dir ?? ''), Number(b?.maxMutants) || 12);
  }));
  router.get('/axiom/adversary/latest', async (req, res) => {
    try {
      const dir = typeof req.query.dir === 'string' ? req.query.dir : undefined;
      res.json({ ok: true, data: await getAxiomAdversaryLatest(dir) });
    } catch (err) { res.status(502).json({ ok: false, error: errorMessage(err) }); }
  });

  return router;
}
