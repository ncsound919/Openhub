import express from 'express';
import { computeState, lessons, recordEpisode, skillStats } from '../services/selfLearning.js';
import {
  normalizeRegistryTools,
  recourseCapabilities,
  recourseForgeRun,
  recourseProvenance,
  recourseRegistry,
  recourseSelfHosted,
  recourseSelfHostedExecute,
  recourseUpgradeReport,
} from '../services/recourseClient.js';

/**
 * Self-learning + self-development surface.
 * =========================================
 * OpenHub's own learner (episodes → skills → lessons → calibration), plus the
 * Recourse-powered self-development loop (registry, self-hosted tools, forge,
 * upgrade report). All reads degrade honestly; every write is guarded and
 * operator-initiated — OpenHub never rewrites itself without an explicit call.
 *
 *   GET  /api/selflearn/state              learner state (skills, lessons, calibration)
 *   GET  /api/selflearn/lessons            deterministic lessons
 *   GET  /api/selflearn/skills             skill effectiveness (Laplace-smoothed)
 *   POST /api/selflearn/outcome            record an external episode
 *   GET  /api/selflearn/registry           Recourse tools + self-hosted adoption
 *   GET  /api/selflearn/upgrade            how the system has changed (upgrade + provenance)
 *   POST /api/selflearn/forge              run one Recourse capability-forge iteration
 *   POST /api/selflearn/tools/:name/execute  execute a self-hosted Recourse tool
 */
export function createSelfLearnRouter(deps: { authMiddleware: express.RequestHandler }): express.Router {
  const router = express.Router();
  router.use(deps.authMiddleware);

  router.get('/selflearn/state', (_req, res) => {
    try {
      res.json({ ok: true, state: computeState() });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.get('/selflearn/lessons', (req, res) => {
    const limit = Number(req.query.limit);
    res.json({ ok: true, lessons: lessons(Number.isFinite(limit) && limit > 0 ? limit : 10) });
  });

  router.get('/selflearn/skills', (_req, res) => {
    res.json({ ok: true, skills: skillStats() });
  });

  router.post('/selflearn/outcome', express.json(), (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (typeof body.kind !== 'string' || !body.kind) {
      return res.status(400).json({ ok: false, error: 'kind is required' });
    }
    if (typeof body.outcome !== 'string' || !body.outcome) {
      return res.status(400).json({ ok: false, error: 'outcome is required' });
    }
    const result = recordEpisode({
      kind: body.kind,
      outcome: body.outcome,
      goal: typeof body.goal === 'string' ? body.goal : undefined,
      targetDir: typeof body.targetDir === 'string' ? body.targetDir : undefined,
      action: typeof body.action === 'string' ? body.action : undefined,
      skills: Array.isArray(body.skills) ? body.skills.map(String) : undefined,
      signals: body.signals && typeof body.signals === 'object' ? body.signals : undefined,
      systems: Array.isArray(body.systems) ? body.systems.map(String) : undefined,
    });
    res.status(result.wrote ? 200 : 400).json(result);
  });

  router.get('/selflearn/registry', async (_req, res) => {
    const [registry, selfHosted, capabilities] = await Promise.all([
      recourseRegistry(),
      recourseSelfHosted(),
      recourseCapabilities(),
    ]);
    const available = registry.available || selfHosted.available || capabilities.available;
    if (!available) return res.status(503).json({ available: false, error: registry.error || selfHosted.error || capabilities.error || 'Recourse offline' });
    const tools = normalizeRegistryTools(registry.data);
    res.json({
      available: true,
      tools,
      toolCount: tools.length,
      domains: [...new Set(tools.map((t) => t.domain))].sort(),
      selfHostedCount: tools.filter((t) => t.selfHosted).length,
      capabilities: capabilities.data ?? null,
      selfHosted: selfHosted.data ?? null,
    });
  });

  router.get('/selflearn/upgrade', async (req, res) => {
    const limit = Number(req.query.limit);
    const [upgrade, provenance] = await Promise.all([
      recourseUpgradeReport(),
      recourseProvenance(Number.isFinite(limit) && limit > 0 ? limit : 20),
    ]);
    const available = upgrade.available || provenance.available;
    if (!available) return res.status(503).json({ available: false, error: upgrade.error || provenance.error || 'Recourse offline' });
    res.json({ available: true, upgrade: upgrade.data ?? null, provenance: provenance.data ?? null });
  });

  router.post('/selflearn/forge', express.json(), async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const r = await recourseForgeRun(body);
    res.status(r.available ? 200 : 503).json(r);
  });

  router.post('/selflearn/tools/:name/execute', express.json(), async (req, res) => {
    const name = req.params.name;
    if (!name || !/^[A-Za-z0-9_-]+$/.test(name)) {
      return res.status(400).json({ available: false, error: 'invalid tool name' });
    }
    const args = req.body && typeof req.body === 'object' && req.body.args && typeof req.body.args === 'object'
      ? (req.body.args as Record<string, unknown>)
      : {};
    const r = await recourseSelfHostedExecute(name, args);
    res.status(r.available ? 200 : 503).json(r);
  });

  return router;
}
