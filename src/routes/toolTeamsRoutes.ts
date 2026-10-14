import express from 'express';
import {
  teamCatalog,
  runTeam,
  runJobType,
  draymondRoutines,
  synergyOverview,
  teamBusy,
  type TeamId,
  type JobType,
} from '../services/toolTeams';

const JOB_TYPES: JobType[] = [
  'repair', 'code', 'audit', 'review', 'workspace',
  'daily', 'cron', 'report', 'learning', 'brain',
  'growth', 'strategy', 'reasoning', 'matrix', 'service', 'insights',
];

/**
 * Tool-team control surface — OpenHub as the primary console.
 * Mounted at /api (auth-gated):
 *   GET  /teams             — team catalog + job-type → team mapping
 *   POST /teams/:id/run     — run ONE team's tools (busy guard per team)
 *   POST /jobs/:type/run    — run a job type through its MINIMAL team set
 *   GET  /jobs/draymond     — Draymond daily flow + crons with team assignment
 * Only the teams a job type needs are ever called; per-team in-flight guard
 * prevents stacking. See src/services/toolTeams.ts.
 */
export function createToolTeamsRouter(deps: { authMiddleware: express.RequestHandler }): express.Router {
  const router = express.Router();
  router.use(deps.authMiddleware);

  router.get('/teams', (_req, res) => {
    try {
      res.json({ ok: true, ...teamCatalog() });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/teams/status', (_req, res) => {
    try {
      const catalog = teamCatalog();
      const status = catalog.teams.map((t) => ({ id: t.id, label: t.label, enabled: t.enabled, busy: teamBusy(t.id as TeamId) }));
      res.json({ ok: true, status });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/teams/:id/run', async (req, res) => {
    try {
      const id = req.params.id as TeamId;
      const payload = (req.body ?? {}).payload ?? req.body ?? {};
      const result = await runTeam(id, payload, process.env);
      res.status(result.busy ? 409 : 200).json({ ok: !result.busy, ...result });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/jobs/:type/run', async (req, res) => {
    try {
      const type = req.params.type as JobType;
      if (!JOB_TYPES.includes(type)) {
        return res.status(400).json({ ok: false, error: `job type must be one of: ${JOB_TYPES.join(', ')}` });
      }
      const payload = (req.body ?? {}).payload ?? req.body ?? {};
      const result = await runJobType(type, payload, process.env);
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/jobs/draymond', async (_req, res) => {
    try {
      res.json({ ok: true, ...(await draymondRoutines()) });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Recourse synergy map/candidates/learning + Draymond lessons — the input
  // that makes tool-team routing improve as the fleet runs.
  router.get('/teams/synergy', async (_req, res) => {
    try {
      res.json({ ok: true, ...(await synergyOverview()) });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}