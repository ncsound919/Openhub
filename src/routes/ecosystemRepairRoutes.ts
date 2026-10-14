import { Router, type RequestHandler } from 'express';
import { operatorGateFor } from '../lib/operator.js';
import { runEcosystemRepair, resolveToolFolder, type EcosystemRepairReportSource } from '../services/ecosystemRepair.js';
import { getRegistryEntry } from '../services/ecosystemRegistry.js';
import { listIncidents } from '../services/incidentBus.js';

const SOURCES: EcosystemRepairReportSource[] = ['dev-brain', 'draymond', 'ecosystem', 'system'];
const SEVERITIES = ['low', 'medium', 'high', 'critical'];
const PRESETS = ['quick', 'standard', 'deep', 'release'];

/**
 * Ecosystem repair routes — OpenHub as the ecosystem-aware repair intake for
 * Dev-Brain + Draymond. Mounted at /api (auth-gated).
 *
 *   POST /api/ecosystem/report       { toolId, source, severity, kind, detail, preset?, goalOverride? }
 *   GET  /api/ecosystem/report/tools — the operative tools OpenHub can repair
 *   GET  /api/ecosystem/report/incidents — recent ecosystem-repair incidents
 *
 * The caller names the TOOL (from the ecosystem registry), NOT a code path:
 * OpenHub resolves the tool's preloaded local folder, audits it, and dispatches
 * the fix to Axiom with the same targetDir — no full-codebase rescan.
 */
export function createEcosystemRepairRouter(deps: { authMiddleware: RequestHandler }): Router {
  const router = Router();
  router.use(deps.authMiddleware);
  // Operator gate (OPENHUB_ADMIN_ROLES): these start agents, apply code or
  // dispatch repairs, so an ordinary authenticated account must not reach them.
  router.use(operatorGateFor([/^\/ecosystem\/report\/?$/]));

  router.post('/ecosystem/report', async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const toolId = typeof body.toolId === 'string' ? body.toolId.trim() : '';
      const source = body.source as EcosystemRepairReportSource;
      const severity = body.severity as string;
      const kind = typeof body.kind === 'string' && body.kind.trim() ? body.kind.trim() : 'ecosystem-report';
      const detail = typeof body.detail === 'string' ? body.detail : '';

      if (!toolId) return res.status(400).json({ ok: false, error: 'toolId is required (ecosystem registry id, e.g. "draymond", "recourse", "global-lens")' });
      if (!SOURCES.includes(source)) return res.status(400).json({ ok: false, error: `source must be one of: ${SOURCES.join(', ')}` });
      if (!SEVERITIES.includes(severity)) return res.status(400).json({ ok: false, error: 'severity must be one of: low, medium, high, critical' });

      const preset = typeof body.preset === 'string' && PRESETS.includes(body.preset) ? (body.preset as 'quick' | 'standard' | 'deep' | 'release') : undefined;
      const goalOverride = typeof body.goalOverride === 'string' && body.goalOverride.trim() ? body.goalOverride.trim() : undefined;

      const result = await runEcosystemRepair({
        toolId,
        source,
        severity: severity as 'low' | 'medium' | 'high' | 'critical',
        kind,
        detail,
        ...(preset ? { preset } : {}),
        ...(goalOverride ? { goalOverride } : {}),
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  /** The operative tools OpenHub can repair — preloaded local folders only. */
  router.get('/ecosystem/report/tools', (_req, res) => {
    const tools = ['axiom', 'openhub', 'draymond', 'dev-brain', 'deterministic-brain', 'recourse', 'litellm', 'omniresearch', 'reporank', 'grader', 'claw-protect', 'codenexus', 'the-deep', 'agentbrowser', 'vibe-reality', 'mutly', 'open-chat', 'global-lens', 'soundlab', 'middleman']
      .map((id) => {
        const entry = getRegistryEntry(id);
        if (!entry) return null;
        const { dir } = resolveToolFolder(id);
        return { id, name: entry.name, folderResolved: dir, port: entry.port, pillar: entry.pillar, auditGrade: entry.auditGrade };
      })
      .filter((t): t is NonNullable<typeof t> => t !== null && t.folderResolved !== null);
    res.json({ ok: true, tools });
  });

  router.get('/ecosystem/report/incidents', (_req, res) => {
    const incidents = listIncidents(50).filter((i) => SOURCES.includes(i.source as EcosystemRepairReportSource));
    res.json({ ok: true, incidents });
  });

  return router;
}