import { Router, type RequestHandler } from 'express';
import {
  buildSelfReport,
  pushSelfReport,
  readSelfReport,
  readSelfReportHistory,
  refreshSelfReport,
  writeSelfReport,
} from '../services/selfReport.js';

/**
 * OpenHub self-report surface — OpenHub's own status as a versioned, durable
 * artifact an external system (e.g. Recourse) can wire into.
 *
 *   GET  /self-report            latest report (built + persisted on first read)
 *   GET  /self-report/history    recent compact records
 *   POST /self-report/refresh    rebuild + persist, optionally push to Recourse
 *   POST /self-report/push       push the current report into Recourse memory
 *
 * Auth-gated like every other /api surface. Failures are reported honestly;
 * a missing Recourse intake answers 503, never a faked success.
 */
export function createSelfReportRouter(deps: { authMiddleware: RequestHandler }): Router {
  const router = Router();
  router.use(deps.authMiddleware);

  router.get('/self-report', async (_req, res) => {
    let report = readSelfReport();
    if (!report) {
      const r = await refreshSelfReport({ push: false });
      report = r.report;
    }
    res.json({ ok: true, report });
  });

  router.get('/self-report/history', (req, res) => {
    const limit = Number(req.query.limit);
    res.json({ ok: true, records: readSelfReportHistory(Number.isFinite(limit) && limit > 0 ? limit : 50) });
  });

  router.post('/self-report/refresh', async (req, res) => {
    // Push by default: the whole point is that Recourse can wire into it, but a
    // caller can opt out with `{ push: false }` (e.g. a read-only probe).
    const push = (req.body as { push?: unknown } | undefined)?.push !== false;
    const r = await refreshSelfReport({ push });
    res.json({ ok: r.ok, report: r.report, write: r.write, ...(r.push ? { push: r.push } : {}) });
  });

  router.post('/self-report/push', async (_req, res) => {
    let report = readSelfReport();
    if (!report) {
      report = await buildSelfReport();
      writeSelfReport(report);
    }
    const result = await pushSelfReport(report);
    res.status(result.available ? 200 : 503).json({ ok: result.pushed, ...result });
  });

  return router;
}
