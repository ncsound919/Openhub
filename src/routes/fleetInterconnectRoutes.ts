import express from 'express';
import { fleetState, routeDecision, learnFromFleet, fleetInsights, type DecisionDomain } from '../services/fleetInterconnect';
import { decideSystemOne, reviewAdvisory, buildReviewAdvisory } from '../services/jevClient';

const DOMAINS: DecisionDomain[] = [
  'repair', 'code', 'audit', 'review', 'workspace',
  'daily', 'cron', 'report', 'learning', 'brain',
  'growth', 'strategy', 'reasoning', 'matrix', 'service',
];

/**
 * Fleet interconnect — OpenHub as the primary console.
 * Mounted at /api/fleet (auth-gated like the other routers):
 *   GET  /fleet/state     — live health + Jev tier status of every peer
 *   POST /fleet/decide    — route a decision to the right engine by domain
 *   POST /fleet/learn     — feed an outcome into Recourse's learning (memory +
 *                           learner episode)
 *   GET  /fleet/insights  — aggregate Recourse learning/synergy/trend/decision
 *                           + peer Jev state
 * Every peer is probed independently; down/unauthorized peers report honestly.
 */
export function createFleetInterconnectRouter(deps: { authMiddleware: express.RequestHandler }): express.Router {
  const router = express.Router();
  router.use(deps.authMiddleware);

  router.get('/fleet/state', async (_req, res) => {
    try {
      res.json(await fleetState());
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/fleet/decide', async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const domain = body.domain as DecisionDomain;
      if (!DOMAINS.includes(domain)) {
        return res.status(400).json({ ok: false, error: `domain must be one of: ${DOMAINS.join(', ')}` });
      }
      const payload = { ...body };
      delete payload.domain;

      // Local domains (review) run through OpenHub's own Jev client.
      if (domain === 'review') {
        const input = {
          fileCount: Number(payload.fileCount) || 0,
          addedLines: Number(payload.addedLines) || 0,
          removedLines: Number(payload.removedLines) || 0,
          diffSummary: typeof payload.diffSummary === 'string' ? payload.diffSummary : undefined,
        };
        const { state, questions } = reviewAdvisory(input);
        const jev = buildReviewAdvisory(await decideSystemOne({ state, questions }));
        return res.json({ ok: true, domain, routedTo: 'local', engine: 'OpenHub', jev });
      }

      const routed = await routeDecision(domain, payload);
      res.status(routed.available ? 200 : 502).json({ ok: routed.available, ...routed });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/fleet/learn', async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const kind = body.kind as 'gene' | 'lesson' | 'hypothesis' | 'signal' | 'snapshot' | undefined;
      const id = typeof body.id === 'string' ? body.id : '';
      const text = typeof body.text === 'string' ? body.text : '';
      if (!kind || !['gene', 'lesson', 'hypothesis', 'signal', 'snapshot'].includes(kind)) {
        return res.status(400).json({ ok: false, error: 'kind must be one of: gene, lesson, hypothesis, signal, snapshot' });
      }
      if (!id || !text) return res.status(400).json({ ok: false, error: 'id and text are required' });
      const result = await learnFromFleet({
        kind,
        id,
        text,
        topic: typeof body.topic === 'string' ? body.topic : undefined,
        data: body.data,
        externalScore: typeof body.externalScore === 'number' ? body.externalScore : undefined,
        runEpisode: body.runEpisode !== false,
      });
      const ok = result.memory.ok && (result.episode === null || result.episode.ok);
      res.status(ok ? 200 : 502).json({ ok, memory: result.memory, episode: result.episode });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/fleet/insights', async (_req, res) => {
    try {
      res.json(await fleetInsights());
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}