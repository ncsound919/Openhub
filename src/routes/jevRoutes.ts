import express from 'express';
import {
  jevStatus,
  decideSystemOne,
  reviewAdvisory,
  buildReviewAdvisory,
  repairAdvisory,
  buildRepairAdvisory,
  auditAdvisory,
  buildAuditAdvisory,
  workspaceAdvisory,
  buildWorkspaceAdvisory,
} from '../services/jevClient';

/**
 * Jev (System One) coding-decision surface for OpenHub, mounted at /api/jev.
 * Each route is a read-only advisory: the deterministic harness logic stays
 * authoritative; Jev adds calibrated choice/noul/score alongside. Gateway tier
 * (Vercel AI Gateway TypeSafe lane) is primary when a key is configured;
 * LocalJev on :8080 is the fallback. Both down => advisory source 'offline'.
 */
export function createJevRouter(deps: { authMiddleware: express.RequestHandler }): express.Router {
  const router = express.Router();
  router.use(deps.authMiddleware);

  router.get('/jev/status', async (_req, res) => {
    try {
      res.json({ ok: true, ...(await jevStatus()) });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.post('/jev/review', async (req, res) => {
    try {
      const b = req.body ?? {};
      const input = {
        fileCount: Number(b.fileCount) || 0,
        addedLines: Number(b.addedLines) || 0,
        removedLines: Number(b.removedLines) || 0,
        diffSummary: typeof b.diffSummary === 'string' ? b.diffSummary : undefined,
      };
      const { state, questions } = reviewAdvisory(input);
      const jev = buildReviewAdvisory(await decideSystemOne({ state, questions }));
      res.json({ ok: true, input, jev });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.post('/jev/repair', async (req, res) => {
    try {
      const b = req.body ?? {};
      const { state, questions } = repairAdvisory({
        finding: typeof b.finding === 'string' ? b.finding : undefined,
        brief: typeof b.brief === 'string' ? b.brief : undefined,
      });
      const jev = buildRepairAdvisory(await decideSystemOne({ state, questions }));
      res.json({ ok: true, jev });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.post('/jev/audit', async (req, res) => {
    try {
      const b = req.body ?? {};
      const { state, questions } = auditAdvisory({
        status: typeof b.status === 'string' ? b.status : 'unknown',
        factCount: Number(b.factCount) || 0,
        passedFacts: Number(b.passedFacts) || 0,
        discrepancies: Array.isArray(b.discrepancies) ? b.discrepancies.map((d: unknown) => String(d)).slice(0, 20) : [],
      });
      const jev = buildAuditAdvisory(await decideSystemOne({ state, questions }));
      res.json({ ok: true, jev });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.post('/jev/workspace', async (req, res) => {
    try {
      const b = req.body ?? {};
      const path = typeof b.path === 'string' && b.path.trim() ? b.path : '';
      const operation = typeof b.operation === 'string' && b.operation.trim() ? b.operation : '';
      if (!path || !operation) return res.status(400).json({ ok: false, error: 'path and operation are required' });
      const { state, questions } = workspaceAdvisory({ path, operation });
      const jev = buildWorkspaceAdvisory(await decideSystemOne({ state, questions }));
      res.json({ ok: true, workspace: { path, operation }, jev });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  return router;
}