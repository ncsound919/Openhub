import { Router, type RequestHandler } from 'express';
import {
  reportIncident,
  listIncidents,
  dispatchState,
  getDispatchPrefs,
  setDispatchPrefs,
  type IncidentSeverity,
  type IncidentSource,
} from '../services/incidentBus.js';
import { triggerRepairTriage } from '../services/repairClient.js';

const SEVERITIES: IncidentSeverity[] = ['low', 'medium', 'high', 'critical'];
const SOURCES: IncidentSource[] = ['axiom', 'copilot', 'pipeline', 'mcp', 'ecosystem', 'supervisor', 'system'];

/**
 * Incident bus routes (auth-gated, mounted at /api):
 *   POST /api/incidents/report   { source, kind, severity, detail, dedupKey? }
 *   GET  /api/incidents
 *   POST /api/incidents/:id/dispatch
 *   GET  /api/incidents/prefs
 *   PUT  /api/incidents/prefs    { low?, medium?, high?, critical? }
 */
export function createIncidentsRouter(deps: { authMiddleware: RequestHandler }): Router {
  const router = Router();
  router.use(deps.authMiddleware);

  router.post('/incidents/report', async (req, res) => {
    const { source, kind, severity, detail, dedupKey } = (req.body ?? {}) as Record<string, unknown>;
    if (!SOURCSAFE(source) || typeof kind !== 'string' || !kind.trim() || !SEVERITIES.includes(severity as IncidentSeverity)) {
      return res.status(400).json({ ok: false, error: 'source, kind, and a valid severity (low|medium|high|critical) are required' });
    }
    const result = await reportIncident({
      source: source as IncidentSource,
      kind: kind.trim().slice(0, 120),
      severity: severity as IncidentSeverity,
      detail: typeof detail === 'string' ? detail : '',
      dedupKey: typeof dedupKey === 'string' && dedupKey.trim() ? dedupKey.trim().slice(0, 200) : undefined,
    });
    res.json({ ok: true, ...result, dispatch: dispatchState() });
  });

  router.get('/incidents', (_req, res) => {
    res.json({ ok: true, incidents: listIncidents(100), dispatch: dispatchState(), prefs: getDispatchPrefs() });
  });

  router.post('/incidents/:id/dispatch', async (req, res) => {
    // Manual dispatch: reuse the triage path directly (bypasses prefs/queue).
    try {
      const { getDb } = await import('../auth/db.js');
      const row = (getDb().prepare('SELECT * FROM incidents WHERE id = ?').get(req.params.id) as any) ?? null;
      if (!row) return res.status(404).json({ ok: false, error: 'Incident not found' });
      const outcome = await triggerRepairTriage({
        signal: `openhub:incident:${row.kind}`,
        detail: `[${row.source}/${row.severity}] ${row.detail}`.slice(0, 4000),
        kind: 'job',
      });
      res.json({ ok: !!outcome?.ok, outcome });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/incidents/prefs', (_req, res) => {
    res.json({ ok: true, prefs: getDispatchPrefs(), dispatch: dispatchState() });
  });

  router.put('/incidents/prefs', (req, res) => {
    const patch: Partial<Record<IncidentSeverity, boolean>> = {};
    for (const s of SEVERITIES) {
      if (typeof (req.body as any)?.[s] === 'boolean') patch[s] = (req.body as any)[s];
    }
    res.json({ ok: true, prefs: setDispatchPrefs(patch) });
  });

  function SOURCSAFE(s: unknown): s is IncidentSource {
    return typeof s === 'string' && (SOURCES as string[]).includes(s);
  }

  return router;
}
