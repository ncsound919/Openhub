import { Router, type RequestHandler } from 'express';
import { getDb } from '../auth/db.js';
import { getActiveProject } from '../services/projectContext.js';
import { readProjectDrift } from '../services/projectGit.js';
import { listRuns } from '../services/supervisor.js';
import { listIncidents, dispatchState } from '../services/incidentBus.js';
import { sourceCounts } from '../services/ecosystemKnowledge.js';
import { recourseSummary, recourseRegistry, recourseAgendaNext, normalizeRegistryTools } from '../services/recourseClient.js';

/**
 * Shared system snapshot — one call both the 3D visualizer, the copilot,
 * and the dashboards feed off. Every section is independently
 * `{ ok, ... }`; a failing subsystem degrades its own section, never the
 * whole response. Auth-gated, mounted at /api.
 */
export function createSystemSnapshotRouter(deps: { authMiddleware: RequestHandler }): Router {
  const router = Router();
  router.use(deps.authMiddleware);

  router.get('/system/snapshot', async (req, res) => {
    const user = (req as any).user as { sub?: unknown } | undefined;
    const userId = typeof user?.sub === 'string' ? user.sub : null;
    const snapshot: Record<string, unknown> = { generatedAt: new Date().toISOString() };

    // Project + drift
    try {
      const project = userId ? getActiveProject(userId) : null;
      snapshot.project = project ? { ok: true, ...project } : { ok: false, error: 'no active project' };
      if (project) {
        try {
          snapshot.drift = { ok: true, ...(await readProjectDrift(project.path)) };
        } catch (err) {
          snapshot.drift = { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      } else {
        snapshot.drift = { ok: false, error: 'no active project' };
      }
    } catch (err) {
      snapshot.project = { ok: false, error: err instanceof Error ? err.message : String(err) };
      snapshot.drift = { ok: false, error: 'project unavailable' };
    }

    // Latest audit verdict
    try {
      const row = getDb().prepare('SELECT id, overall_status, created_at FROM audit_reports ORDER BY created_at DESC LIMIT 1').get() as
        | { id: string; overall_status: string; created_at: string } | undefined;
      snapshot.audit = row
        ? { ok: true, verdict: row.overall_status, reportId: row.id, at: row.created_at }
        : { ok: false, error: 'no audit recorded' };
    } catch (err) {
      snapshot.audit = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    // Supervision runs
    try {
      const runs = listRuns(5);
      snapshot.runs = {
        ok: true,
        total: runs.length,
        active: runs.filter((r) => ['looping', 'auditing', 'repairing'].includes(r.status)).length,
        latest: runs[0] ?? null,
      };
    } catch (err) {
      snapshot.runs = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    // Research history
    try {
      const rows = getDb().prepare('SELECT id, query, created_at FROM research_queries ORDER BY created_at DESC LIMIT 5').all() as any[];
      snapshot.research = { ok: true, total: rows.length, latest: rows };
    } catch {
      snapshot.research = { ok: false, error: 'research log unavailable' };
    }

    // Ecosystem intel
    try {
      const sources = sourceCounts();
      snapshot.ecosystem = {
        ok: sources.length > 0,
        sources,
        entries: sources.reduce((n, s) => n + s.entries, 0),
      };
    } catch (err) {
      snapshot.ecosystem = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    // Incidents
    try {
      const incidents = listIncidents(8);
      const bySeverity: Record<string, number> = {};
      for (const i of incidents) bySeverity[i.severity] = (bySeverity[i.severity] ?? 0) + 1;
      snapshot.incidents = { ok: true, recent: incidents, bySeverity, dispatch: dispatchState() };
    } catch (err) {
      snapshot.incidents = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    // Recourse
    try {
      const summary = await recourseSummary();
      const [registry, agenda] = await Promise.all([recourseRegistry(), recourseAgendaNext()]);
      const tools = normalizeRegistryTools(registry.data);
      const next = (agenda.data ?? {}) as Record<string, unknown>;
      const nextItem = (next.next ?? next.item ?? next.agenda ?? next) as Record<string, unknown>;
      const agendaLabel = typeof nextItem?.title === 'string' ? nextItem.title
        : typeof nextItem?.goal === 'string' ? nextItem.goal
        : typeof nextItem?.summary === 'string' ? nextItem.summary
        : null;
      snapshot.recourse = {
        ok: true,
        summary,
        registry: registry.available
          ? {
              count: tools.length,
              domains: [...new Set(tools.map((t) => t.domain))].length,
              selfHosted: tools.filter((t) => t.selfHosted).length,
              healthy: tools.filter((t) => t.health === 'healthy').length,
            }
          : { available: false, error: registry.error },
        agenda: agenda.available ? { next: agendaLabel, raw: next } : { available: false, error: agenda.error },
      };
    } catch (err) {
      snapshot.recourse = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    res.json({ ok: true, snapshot });
  });

  return router;
}
