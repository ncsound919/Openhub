import express from 'express';
import { readRepairLogs, triggerRepairTriage } from '../services/repairClient.js';
import { executeAuditSuite } from '../services/auditSuite.js';
import { buildRepairBrief, renderRepairBrief } from '../services/repairBrief.js';
import { getActiveProject } from '../services/projectContext.js';

export function createRepairRouter(deps: { authMiddleware: express.RequestHandler }): express.Router {
  const router = express.Router();
  router.use(deps.authMiddleware);

  router.post('/repair/audit-and-repair', async (req, res) => {
    try {
      const userId = (req.user as unknown as { sub?: unknown } | undefined)?.sub;
      if (typeof userId !== 'string' || userId.trim() === '') {
        return res.status(401).json({ ok: false, error: 'Authentication required' });
      }
      const project = getActiveProject(userId);
      if (!project) {
        return res.status(409).json({ ok: false, code: 'NO_ACTIVE_PROJECT', error: 'Load a project before auditing and repairing' });
      }
      const repoUrl = project.githubFullName ? `https://github.com/${project.githubFullName}` : undefined;
      // Same PR-grade gate as the supervisor's loop completion: `standard`
      // preset, diff-scoped when possible, honest degradation per scorer.
      const audit = await executeAuditSuite({ targetDir: project.path, repoUrl, preset: 'standard', core: true });
      // The repair agent needs the fresh, deduped findings — not just scorer
      // summaries. Build a prioritized, remediation-carrying brief so the
      // dispatch says exactly what to fix and where.
      const brief = buildRepairBrief(audit);
      if (audit.overallStatus === 'pass') {
        return res.json({ ok: true, project, audit, brief, repair: null, message: 'Audit passed; repair was not dispatched.' });
      }
      const repair = await triggerRepairTriage({
        signal: 'openhub:audit-failed',
        detail: renderRepairBrief(brief, { maxChars: 6000 }),
        kind: 'job',
        repoUrl,
      });
      res.json({ ok: true, project, audit, brief, repair, message: repair?.ok ? 'Audit completed and repair dispatched.' : 'Audit completed; repair dispatch failed.' });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.get('/repair/logs', (_req, res) => {
    try {
      const logs = readRepairLogs();
      res.json({ ok: true, logs });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.post('/repair/trigger', async (req, res) => {
    try {
      const userId = (req.user as unknown as { sub?: unknown } | undefined)?.sub;
      if (typeof userId !== 'string' || userId.trim() === '') {
        return res.status(401).json({ ok: false, error: 'Authentication required' });
      }
      const project = getActiveProject(userId);
      if (!project) {
        return res.status(409).json({ ok: false, code: 'NO_ACTIVE_PROJECT', error: 'Load a project before dispatching repair' });
      }
      const { signal, detail, kind } = req.body || {};
      if (typeof signal !== 'string' || signal.trim() === '') {
        return res.status(400).json({ ok: false, error: 'signal is required' });
      }
      const repoUrl = project.githubFullName ? `https://github.com/${project.githubFullName}` : undefined;
      const outcome = await triggerRepairTriage({ signal: signal.trim(), detail: typeof detail === 'string' && detail.trim() ? detail.trim() : signal.trim(), kind, repoUrl });
      res.json({ ok: true, project, outcome });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  return router;
}
