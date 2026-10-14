import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import {
  loadLifecycle,
  runAuditCore,
  runRulesForRepo,
  makeCoreCompleter,
  makeTextCompleter,
} from '../services/auditCore.js';
import { loadAuditConfig } from '../core/config.js';
import { generateAutofixes, parseFixResponse, type FixGenerator } from '../core/autofix.js';
import type { Finding } from '../services/findings.js';
import { callerId, resolveReviewTarget } from '../lib/reviewTarget.js';

/**
 * Shared audit-core surface: config, rules, validate/lifecycle/gate, autofix.
 * This is how RepoRank, CodeNexus and The Deep consume one implementation of the
 * rules engine, validator, lifecycle and autofix instead of re-inventing them.
 */
export function createAuditCoreRouter(deps: { authMiddleware: express.RequestHandler }): express.Router {
  const router = express.Router();
  router.use(deps.authMiddleware);

  const resolveTarget = (req: express.Request, raw: unknown): string | null => {
    if (typeof raw !== 'string' || !raw.trim()) return null;
    try {
      const abs = path.resolve(raw);
      if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) return null;
    } catch {
      return null;
    }
    // Containment: a raw `path.resolve(raw)` let any authenticated caller point
    // the audit at any directory on the host (read configs, enumerate files).
    // An explicit target must be the caller's active project or under a repo root.
    const target = resolveReviewTarget(callerId(req), raw);
    return target.ok ? target.dir : null;
  };

  router.get('/audit-core/config', (req, res) => {
    const root = resolveTarget(req, req.query.targetDir);
    if (!root) return res.status(400).json({ ok: false, error: 'targetDir is required, must exist, and must be under an allowed repo root' });
    const cfg = loadAuditConfig(root);
    res.json({ ok: true, targetDir: root, ...cfg });
  });

  router.get('/audit-core/lifecycle', (req, res) => {
    const root = resolveTarget(req, req.query.targetDir);
    if (!root) return res.status(400).json({ ok: false, error: 'targetDir is required, must exist, and must be under an allowed repo root' });
    res.json({ ok: true, records: loadLifecycle(root) });
  });

  // Validate → lifecycle → gate a set of findings (the main consumer entry).
  router.post('/audit-core/run', (req, res) => {
    const root = resolveTarget(req, req.body?.targetDir);
    if (!root) return res.status(400).json({ ok: false, error: 'targetDir is required, must exist, and must be under an allowed repo root' });
    const findings = Array.isArray(req.body?.findings) ? (req.body.findings as Finding[]) : [];
    const result = runAuditCore({
      rootDir: root,
      findings,
      ...(Number.isFinite(Number(req.body?.changedLines)) ? { changedLines: Number(req.body.changedLines) } : {}),
      ...(Array.isArray(req.body?.labels) ? { labels: req.body.labels.map(String) } : {}),
      ...(req.body?.persist === false ? { persist: false } : {}),
    });
    res.json({ ok: true, core: result });
  });

  // Plain-English rules (needs a configured model; honest 'configured:false' otherwise).
  router.post('/audit-core/rules', async (req, res) => {
    const root = resolveTarget(req, req.body?.targetDir);
    if (!root) return res.status(400).json({ ok: false, error: 'targetDir is required, must exist, and must be under an allowed repo root' });
    const complete = makeCoreCompleter();
    if (!complete) {
      return res.json({ ok: true, configured: false, note: 'no LLM configured (set OPENHUB_LLM_BASE_URL / OPENHUB_LLM_MODEL)', findings: [], evaluated: [], skipped: [], errors: [] });
    }
    try {
      const r = await runRulesForRepo(root, complete);
      res.json({ ok: true, configured: true, ...r });
    } catch (err) {
      res.status(502).json({ ok: false, error: (err as Error).message });
    }
  });

  // Autofix: dependency bumps are deterministic; code fixes use the model.
  router.post('/audit-core/autofix', async (req, res) => {
    const root = resolveTarget(req, req.body?.targetDir);
    if (!root) return res.status(400).json({ ok: false, error: 'targetDir is required, must exist, and must be under an allowed repo root' });
    const findings = Array.isArray(req.body?.findings) ? (req.body.findings as Finding[]) : [];
    const text = makeTextCompleter();
    if (!text) {
      return res.json({ ok: true, configured: false, note: 'no LLM configured', suggestions: [], skipped: [], errors: [] });
    }
    const generate: FixGenerator = async ({ system, prompt }) => parseFixResponse(await text(system, prompt));
    const r = await generateAutofixes(findings, {
      readFile: (file) => {
        const abs = path.resolve(root, file);
        if (abs !== root && !abs.startsWith(root + path.sep)) return null;
        try {
          return fs.readFileSync(abs, 'utf-8');
        } catch {
          return null;
        }
      },
      generate,
    });
    res.json({ ok: true, configured: true, ...r });
  });

  return router;
}
