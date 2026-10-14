import express from 'express';
import { listIncidents, dispatchState, getDispatchPrefs } from '../services/incidentBus.js';

/**
 * Alerts health surface (auth-gated, mounted at /api).
 *   GET /api/alerts/health — read-only aggregate: recent incidents + dispatch
 *   state + Draymond backup integrity. Never triggers a repair or a start.
 */
export function createAlertsRouter(deps: { authMiddleware: express.RequestHandler }): express.Router {
  const router = express.Router();
  router.use(deps.authMiddleware);

  router.get('/alerts/health', async (_req, res) => {
    const incidents = listIncidents(100);
    const cutoff = Date.now() - 24 * 60 * 60_000;
    const bySeverity: Record<string, number> = { low: 0, medium: 0, high: 0, critical: 0 };
    for (const inc of incidents) {
      if (Date.parse(inc.createdAt) >= cutoff && inc.severity in bySeverity) bySeverity[inc.severity] += 1;
    }

    // Backup status from Draymond (auth via CRON_SECRET). Honest degrade.
    const draymondUrl = process.env.DRAYMOND_PUBLIC_URL || process.env.DRAYMOND_URL || 'http://127.0.0.1:3444';
    const secret = process.env.CRON_SECRET || process.env.DRAYMOND_CRON_SECRET || '';
    let backup: { ok: boolean | null; reason?: string; detail?: unknown } = { ok: null, reason: 'not_checked' };
    try {
      const r = await fetch(`${draymondUrl.replace(/\/+$/, '')}/api/ops/backup-status`, {
        headers: secret ? { Authorization: `Bearer ${secret}` } : {},
        signal: AbortSignal.timeout(8000),
      });
      const body = await r.json().catch(() => ({}));
      backup = { ok: r.ok, detail: body };
    } catch (err) {
      backup = { ok: null, reason: err instanceof Error ? err.message : 'unreachable' };
    }

    res.json({
      ok: true,
      generatedAt: new Date().toISOString(),
      incidents,
      dispatch: dispatchState(),
      prefs: getDispatchPrefs(),
      bySeverity24h: bySeverity,
      backup,
    });
  });

  return router;
}
