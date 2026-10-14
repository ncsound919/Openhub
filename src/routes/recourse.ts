import { Router, type RequestHandler } from 'express';
import {
  recourseStatus,
  recourseSynergyMap,
  recourseMemoryRecall,
  recourseScanHeal,
  recourseAgenda,
  recourseAgendaNext,
  recourseRegistry,
  recourseCapabilities,
  recourseUpgradeReport,
  recourseProvenance,
  recourseLearnStatus,
  recourseDreamStatus,
  recourseSelfHosted,
  recourseSkills,
  recourseForgeRun,
  recourseSelfHostedExecute,
  recourseReporterLatest,
  recourseReporterArticles,
  recourseReporterStatus,
  recourseReporterArticle,
  recourseReporterVoices,
  recourseReporterPreview,
  recourseReporterGenerate,
  recourseReporterNarrate,
} from '../services/recourseClient.js';
import { recordEvent } from '../services/telemetry.js';

/**
 * Recourse proxy — exposes Recourse's self-learning / synergy / repair /
 * registry / forge / learner / provenance endpoints to OpenHub under
 * /api/recourse. Read-only passthrough with a short timeout; writes
 * (scan-heal, forge, self-hosted execute) require RECOURSE_API_SECRET and fail
 * closed otherwise. Mounted at /api.
 *
 * Every route returns `{ available: boolean, status?, data?, error? }` and
 * answers 503 when Recourse is offline/unconfigured — never fabricated state.
 */
export function createRecourseRouter(deps: { authMiddleware: RequestHandler }): Router {
  const router = Router();
  router.use(deps.authMiddleware);

  const passthrough = (fn: () => Promise<{ available: boolean; status?: number; data?: unknown; error?: string }>) =>
    async (_req: any, res: any) => {
      const r = await fn();
      res.status(r.available ? 200 : 503).json(r);
    };

  router.get('/recourse/status', passthrough(() => recourseStatus()));

  router.get('/recourse/synergy/map', passthrough(() => recourseSynergyMap()));

  router.get('/recourse/memory/recall', async (req, res) => {
    const query = typeof req.query.query === 'string' ? req.query.query
      : typeof req.query.q === 'string' ? req.query.q : '';
    if (!query.trim()) return res.status(400).json({ available: false, error: 'query is required' });
    const kind = typeof req.query.kind === 'string' ? req.query.kind : undefined;
    const topK = Number(req.query.topK);
    const r = await recourseMemoryRecall(query.trim(), {
      ...(kind ? { kind } : {}),
      ...(Number.isFinite(topK) && topK > 0 ? { topK } : {}),
    });
    res.status(r.available ? 200 : 503).json(r);
  });

  router.post('/recourse/repair/scan-heal', async (req, res) => {
    const targetDir = (req.body as { targetDir?: unknown } | undefined)?.targetDir;
    if (typeof targetDir !== 'string' || targetDir.trim() === '') {
      return res.status(400).json({ available: false, error: 'targetDir is required' });
    }
    const r = await recourseScanHeal(targetDir.trim());
    res.status(r.available ? 200 : 503).json(r);
  });

  router.get('/recourse/agenda', passthrough(() => recourseAgenda()));
  router.get('/recourse/agenda/next', passthrough(() => recourseAgendaNext()));

  // --- registry / dogfood / upgrade surface ---
  router.get('/recourse/registry', passthrough(() => recourseRegistry()));
  router.get('/recourse/capabilities', passthrough(() => recourseCapabilities()));
  router.get('/recourse/upgrade-report', passthrough(() => recourseUpgradeReport()));
  router.get('/recourse/provenance', async (req, res) => {
    const limit = Number(req.query.limit);
    const r = await recourseProvenance(Number.isFinite(limit) && limit > 0 ? limit : undefined);
    res.status(r.available ? 200 : 503).json(r);
  });

  // --- learner / dream / self-hosted / skills surface ---
  router.get('/recourse/learn/status', passthrough(() => recourseLearnStatus()));
  router.get('/recourse/dream/status', passthrough(() => recourseDreamStatus()));
  router.get('/recourse/selfhosted', passthrough(() => recourseSelfHosted()));
  router.get('/recourse/skills', passthrough(() => recourseSkills()));

  // --- self reporter: Recourse's own first-person dispatches ---
  router.get('/recourse/reporter/status', passthrough(() => recourseReporterStatus()));
  router.get('/recourse/reporter/voices', passthrough(() => recourseReporterVoices()));
  router.get('/recourse/reporter/latest', passthrough(() => recourseReporterLatest()));
  router.get('/recourse/reporter/preview', async (req, res) => {
    const voice = typeof req.query.voice === 'string' ? req.query.voice : undefined;
    const format = typeof req.query.format === 'string' ? req.query.format : undefined;
    const r = await recourseReporterPreview(voice, format);
    res.status(r.available ? 200 : 503).json(r);
  });
  router.get('/recourse/reporter/articles', async (req, res) => {
    const limit = Number(req.query.limit);
    const r = await recourseReporterArticles(Number.isFinite(limit) && limit > 0 ? limit : undefined);
    res.status(r.available ? 200 : 503).json(r);
  });
  router.get('/recourse/reporter/article/:fingerprint', async (req, res) => {
    const fingerprint = req.params.fingerprint;
    if (!/^[0-9a-f]{64}$/.test(fingerprint)) {
      return res.status(400).json({ available: false, error: 'invalid fingerprint' });
    }
    const r = await recourseReporterArticle(fingerprint);
    res.status(r.available ? 200 : 503).json(r);
  });

  // --- guarded writes ---
  router.post('/recourse/forge/run', async (req, res) => {
    const body = (req.body && typeof req.body === 'object') ? (req.body as Record<string, unknown>) : {};
    const r = await recourseForgeRun(body);
    res.status(r.available ? 200 : 503).json(r);
  });

  router.post('/recourse/selfhosted/:name/execute', async (req, res) => {
    const name = req.params.name;
    if (!name || !/^[A-Za-z0-9_-]+$/.test(name)) {
      return res.status(400).json({ available: false, error: 'invalid tool name' });
    }
    const args = (req.body && typeof req.body === 'object' && (req.body as { args?: unknown }).args && typeof (req.body as { args: unknown }).args === 'object')
      ? (req.body as { args: Record<string, unknown> }).args
      : {};
    const r = await recourseSelfHostedExecute(name, args);
    res.status(r.available ? 200 : 503).json(r);
  });

  router.post('/recourse/reporter/generate', async (req, res) => {
    const body = (req.body && typeof req.body === 'object') ? (req.body as Record<string, unknown>) : {};
    const r = await recourseReporterGenerate(body);
    const data = (r.data ?? {}) as { article?: { headline?: string; fingerprint?: string }; written?: boolean };
    if (r.available) {
      recordEvent({
        system: 'recourse',
        kind: 'self-report',
        severity: 'info',
        outcome: data.written ? 'accepted' : 'skipped',
        goal: data.article?.headline,
        data: { fingerprint: data.article?.fingerprint, written: data.written === true },
      });
    }
    res.status(r.available ? 200 : 503).json(r);
  });

  router.post('/recourse/reporter/narrate', async (req, res) => {
    const body = (req.body && typeof req.body === 'object') ? (req.body as Record<string, unknown>) : {};
    const fingerprint = typeof body.fingerprint === 'string' ? body.fingerprint : undefined;
    const r = await recourseReporterNarrate(fingerprint);
    res.status(r.available ? 200 : 503).json(r);
  });

  return router;
}
