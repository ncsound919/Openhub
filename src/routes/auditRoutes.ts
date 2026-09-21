import express from 'express';
import { executeAuditSuite, type AuditRunParams, type AuditReport } from '../services/auditSuite.js';
import { AXIOM_BASE } from '../services/axiomClient.js';
import { getDb } from '../auth/db.js';
import { getActiveProject } from '../services/projectContext.js';
import { saveProjectStatus } from '../services/projectStatus.js';
import { getAgentRoster } from '../services/agentRegistry.js';
import { getAgentReadouts, buildWorkOrder, getOssReviewReadouts } from '../services/agentReadouts.js';
import { writeAuditSnapshot } from '../services/auditSnapshot.js';
import { buildAuditStatement, buildVerificationSummary, verifyAttestation } from '../services/attestation.js';
import { listReceipts } from '../services/receipts.js';

/** Lazily ensure the audit_reports table exists (CREATE IF NOT EXISTS). */
function ensureAuditTable(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_reports (
      id TEXT PRIMARY KEY,
      target TEXT NOT NULL,
      created_at TEXT NOT NULL,
      overall_status TEXT NOT NULL,
      report_json TEXT NOT NULL
    );
  `);
}

/** Most recent persisted audit for a target — the baseline a new run diffs against. */
function getLatestReportForTarget(target: string): AuditReport | null {
  if (!target) return null;
  try {
    ensureAuditTable();
    const db = getDb();
    const row = db
      .prepare('SELECT report_json FROM audit_reports WHERE target = ? ORDER BY created_at DESC LIMIT 1')
      .get(target) as { report_json: string } | undefined;
    if (!row) return null;
    return JSON.parse(row.report_json) as AuditReport;
  } catch {
    return null;
  }
}

export function createAuditRouter(deps: { authMiddleware: express.RequestHandler }): express.Router {
  const router = express.Router();
  router.use(deps.authMiddleware);

  router.post('/audit/run', async (req, res) => {
    try {
      const userId = (req.user as unknown as { sub?: unknown } | undefined)?.sub;
      if (typeof userId !== 'string' || userId.trim() === '') {
        return res.status(401).json({ ok: false, error: 'Authentication required' });
      }
      const project = getActiveProject(userId);
      if (!project) {
        return res.status(409).json({ ok: false, code: 'NO_ACTIVE_PROJECT', error: 'Load a project before running an audit' });
      }
      const repoUrl = project.githubFullName ? `https://github.com/${project.githubFullName}` : undefined;
      const auditTarget = repoUrl || project.path;
      const previousReport = getLatestReportForTarget(auditTarget);
      const params: AuditRunParams = {
        targetDir: project.path,
        ...(repoUrl ? { repoUrl } : {}),
        scorers: req.body?.scorers,
        ...(typeof req.body?.base === 'string' && req.body.base ? { base: req.body.base } : {}),
        ...(req.body?.full === true ? { full: true } : {}),
        ...(previousReport ? { previousReport } : {}),
      };
      const report = await executeAuditSuite(params);

      try {
        ensureAuditTable();
        const db = getDb();
        db.prepare(
          'INSERT OR REPLACE INTO audit_reports (id, target, created_at, overall_status, report_json) VALUES (?, ?, ?, ?, ?)'
        ).run(report.id, report.target, report.timestamp, report.overallStatus, JSON.stringify(report));
      } catch (persistErr: any) {
        // The audit ran; persistence failing must not erase the result.
        console.warn('[audit] failed to persist report:', persistErr.message);
      }

      // Persist the project status file so the repo carries its latest verdict.
      try { saveProjectStatus(userId); } catch { /* best-effort */ }

      // Bridge the audit into Recourse's self-reporter (dimension gaps + trend).
      try { writeAuditSnapshot(report); } catch { /* best-effort */ }

      // Evidence spine: attach the in-toto statement + verification summary so
      // the report is portable and checkable, not just a number.
      // Best-effort: a minimal/mock report should never 500 the entire response.
      let attestation: unknown = null;
      let vsa: unknown = null;
      try {
        const receipts = listReceipts({ runId: report.receiptRunId ?? report.id, includeProbes: true, limit: 1000 });
        attestation = buildAuditStatement(report, receipts);
        vsa = buildVerificationSummary(report, receipts);
      } catch {
        /* attestation build is best-effort enrichment */
      }

      res.json({ ok: true, project, report, attestation, vsa });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.get('/audit/history', (_req, res) => {
    try {
      ensureAuditTable();
      const db = getDb();
      const rows = db.prepare(
        'SELECT report_json FROM audit_reports ORDER BY created_at DESC LIMIT 50'
      ).all() as Array<{ report_json: string }>;
      const history = rows
        .map((r) => { try { return JSON.parse(r.report_json) as AuditReport; } catch { return null; } })
        .filter((r): r is AuditReport => r !== null);
      res.json({ ok: true, history });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  /** NOTE: static routes must stay above `/audit/:id` — Express matches in
   *  registration order and `:id` would otherwise shadow `/audit/tools` and
   *  `/audit/readouts` (both 404'd before this fix). */

  /** Audit tools dashboard: every scorer + agent backend with deep per-tool stats. */
  router.get('/audit/tools', (_req, res) => {
    try {
      ensureAuditTable();
      const db = getDb();
      const scorers = [
        { name: 'reporank', kind: 'scorer', configured: Boolean(process.env.REPORANK_API_KEY), endpoint: process.env.REPORANK_URL || 'http://127.0.0.1:3200' },
        { name: 'grader', kind: 'scorer', configured: Boolean(process.env.GRADER_API_KEY), endpoint: process.env.GRADER_URL || 'http://127.0.0.1:3201' },
        { name: 'claw-protect', kind: 'scorer', configured: Boolean(process.env.CLAW_PROTECT_SYSTEM_AGENT_KEY), endpoint: process.env.CLAW_URL || 'http://127.0.0.1:3300' },
        { name: 'codegraph', kind: 'scorer', configured: true, endpoint: `${AXIOM_BASE}/api/harness/oss-review` },
        { name: 'ocr', kind: 'scorer', configured: true, endpoint: `${AXIOM_BASE}/api/harness/oss-review` },
        { name: 'deep', label: 'The Deep', kind: 'scorer', configured: Boolean(process.env.DEEP_URL), endpoint: process.env.DEEP_URL || 'not configured (set DEEP_URL)' },
        { name: 'codegang', label: 'CodeGang', kind: 'scorer', configured: Boolean(process.env.CODEGANG_URL), endpoint: process.env.CODEGANG_URL || 'http://127.0.0.1:3011' },
        { name: 'codenexus', label: 'CodeNexus', kind: 'scorer', configured: true, endpoint: process.env.CODENEXUS_URL || 'http://127.0.0.1:3205' },
        { name: 'local_qa', label: 'Benchmark Olympics QA', kind: 'scorer', configured: true, endpoint: 'local: target test runner' },
        { name: 'typecheck', label: 'Typecheck', kind: 'scorer', configured: true, endpoint: 'local: tsc / mypy' },
        { name: 'lint', label: 'Lint', kind: 'scorer', configured: true, endpoint: 'local: eslint / ruff / flake8' },
        { name: 'deps_freshness', label: 'Dependency freshness', kind: 'scorer', configured: true, endpoint: 'local: npm outdated / pip' },
        { name: 'licenses_sbom', label: 'Licenses / SBOM', kind: 'scorer', configured: true, endpoint: 'local: license-checker' },
        { name: 'duplication', label: 'Duplication', kind: 'scorer', configured: true, endpoint: 'local: jscpd / pylint' },
        { name: 'perf', label: 'Performance', kind: 'scorer', configured: true, endpoint: 'local: static heuristics' },
        { name: 'a11y', label: 'Accessibility', kind: 'scorer', configured: true, endpoint: 'local: pa11y' },
        { name: 'api_contract', label: 'API contract', kind: 'scorer', configured: true, endpoint: 'local: OpenAPI vs HEAD' },
        { name: 'git_history', label: 'Git history', kind: 'scorer', configured: true, endpoint: 'local: git / gitleaks' },
        { name: 'iac', label: 'IaC', kind: 'scorer', configured: true, endpoint: 'local: tfsec / built-in rules' },
      ];
      const backends = getAgentRoster().audit.map((b) => ({
        name: b.slug,
        label: b.name,
        kind: 'agent',
        configured: b.present,
        endpoint: b.path,
        description: b.description,
      }));

      // Per-scorer stats from persisted audit history.
      const reports = db.prepare('SELECT report_json FROM audit_reports ORDER BY created_at DESC').all() as Array<{ report_json: string }>;
      const perScorer = new Map<string, { runs: number; scores: number[]; fails: number; last: { score: number | null; summary: string; error?: string } | null }>();
      for (const row of reports) {
        let report: AuditReport | null = null;
        try { report = JSON.parse(row.report_json) as AuditReport; } catch { report = null; }
        if (!report) continue;
        for (const r of report.results) {
          const stat = perScorer.get(r.scorer) ?? { runs: 0, scores: [], fails: 0, last: null };
          stat.runs += 1;
          if (typeof r.score === 'number') stat.scores.push(r.score);
          if (r.error) stat.fails += 1;
          if (!stat.last) stat.last = { score: r.score, summary: r.summary, error: r.error };
          perScorer.set(r.scorer, stat);
        }
      }

      const tools = [...scorers, ...backends].map((tool) => {
        const stat = perScorer.get(tool.name);
        const scores = stat?.scores ?? [];
        const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
        return {
          ...tool,
          stats: {
            runs: stat?.runs ?? 0,
            avgScore: avg !== null ? Math.round(avg * 10) / 10 : null,
            lastScore: stat?.last?.score ?? null,
            fails: stat?.fails ?? 0,
            last: stat?.last ?? null,
          },
        };
      });

      res.json({ ok: true, tools, total: reports.length });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  /** Agent readouts + work order for the active project (repair team input). */
  router.get('/audit/readouts', async (req, res) => {
    const userId = (req.user as unknown as { sub?: unknown } | undefined)?.sub;
    if (typeof userId !== 'string' || userId.trim() === '') {
      return res.status(401).json({ ok: false, error: 'Authentication required' });
    }
    const project = getActiveProject(userId);
    if (!project) return res.status(409).json({ ok: false, code: 'NO_ACTIVE_PROJECT', error: 'Load a project first' });
    try {
      const readouts = [...getAgentReadouts(project.repositoryName), ...(await getOssReviewReadouts(project.path))];
      const workOrder = buildWorkOrder(readouts);
      const available = readouts.filter((r) => r.available);
      res.json({
        ok: true,
        project: project.repositoryName,
        readouts,
        workOrder,
        summary: {
          tools: readouts.length,
          toolsWithReadouts: available.length,
          totalFindings: readouts.reduce((n, r) => n + r.findings.length, 0),
          workOrderItems: workOrder.total,
        },
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Attestation for a persisted report: the in-toto statement, the VSA, and a
  // live verification against the receipts retained for that run.
  router.get('/audit/:id/attestation', (req, res) => {
    try {
      ensureAuditTable();
      const db = getDb();
      const row = db.prepare('SELECT report_json FROM audit_reports WHERE id = ?').get(req.params.id) as
        | { report_json: string }
        | undefined;
      if (!row) return res.status(404).json({ ok: false, error: 'Report not found' });
      const report = JSON.parse(row.report_json) as AuditReport;
      const receipts = listReceipts({ runId: report.receiptRunId ?? report.id, includeProbes: true, limit: 1000 });
      const attestation = buildAuditStatement(report, receipts);
      const vsa = buildVerificationSummary(report, receipts);
      const verification = verifyAttestation({ statement: attestation, receipts });
      res.json({ ok: true, attestation, vsa, verification, receiptCount: receipts.length });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Single-report lookup goes last so it cannot shadow the static routes above.
  router.get('/audit/:id', (req, res) => {
    try {
      ensureAuditTable();
      const db = getDb();
      const row = db.prepare('SELECT report_json FROM audit_reports WHERE id = ?').get(req.params.id) as
        | { report_json: string }
        | undefined;
      if (!row) return res.status(404).json({ ok: false, error: 'Report not found' });
      res.json({ ok: true, report: JSON.parse(row.report_json) as AuditReport });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  return router;
}
