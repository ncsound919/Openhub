/**
 * internalAuditRoutes.ts — machine-to-machine audit surface.
 *
 * WHY THIS EXISTS
 * Recourse's autopilot work loop needs to audit a repo before it proposes a
 * change. Its own five-auditor team (`grader`, `reporank`, `deep`, `codegang`,
 * `olympics`) had no working backend, so the loop always failed at the audit
 * stage. Meanwhile OpenHub already runs `executeAuditSuite` — 20 scorers
 * including 12 deterministic local ones (typecheck, lint, local_qa,
 * duplication, git_history, iac, a11y, api_contract, deps_freshness,
 * licenses_sbom, perf, plus reporank/grader/deep/codegang/codenexus when
 * configured).
 *
 * The existing `POST /api/audit/run` cannot serve that: it is behind
 * `auth.middleware()` (a real user session), and it audits the CALLER'S ACTIVE
 * PROJECT rather than a directory the caller names. An unattended cron loop has
 * no session and no active project, so it could never use it.
 *
 * This route is the symmetric counterpart to how Recourse already exposes itself
 * to OpenHub (`recourseClient.ts` -> Bearer `RECOURSE_API_SECRET`): a shared
 * secret, a narrow surface, fail-closed.
 *
 * SECURITY CONTRACT
 *  - FAILS CLOSED. With no `OPENHUB_INTERNAL_SECRET` configured, every route
 *    here answers 503. It is never open by default.
 *  - Constant-time comparison, so the secret cannot be recovered by timing.
 *  - `targetDir` is validated against the SAME allowlist the interactive audit
 *    routes use (`isAllowedRepoDir`). A service token must not become a way to
 *    point the suite at an arbitrary directory on the host — the exact
 *    arbitrary-file-read hole `reviewTarget.ts` documents.
 *  - `full: true` is refused: a full sweep spawns every scorer and is far too
 *    expensive to trigger from a cron loop. Depth is the caller's choice within
 *    the presets.
 *  - Read-only with respect to the target: this runs the audit suite, it does
 *    not apply fixes.
 */
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { executeAuditSuite, type ScorerName } from '../services/auditSuite.js';
import { isAllowedRepoDir } from '../lib/reviewTarget.js';

function internalSecret(env: NodeJS.ProcessEnv = process.env): string {
  return (env.OPENHUB_INTERNAL_SECRET ?? '').trim();
}

/** Timing-safe secret check. An unset secret never matches. */
export function isInternalAuthed(
  provided: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const expected = internalSecret(env);
  if (!expected) return false;
  if (!provided) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Pull the secret out of either header shape Recourse sends. */
function readProvidedSecret(req: express.Request): string | undefined {
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice(7).trim();
  const direct = req.headers['x-internal-secret'];
  return typeof direct === 'string' ? direct.trim() : undefined;
}

function guard(req: express.Request, res: express.Response): boolean {
  if (!internalSecret()) {
    res.status(503).json({
      ok: false,
      code: 'INTERNAL_AUDIT_DISABLED',
      error: 'internal audit surface is disabled (set OPENHUB_INTERNAL_SECRET to enable)',
    });
    return false;
  }
  if (!isInternalAuthed(readProvidedSecret(req))) {
    res.status(401).json({ ok: false, code: 'UNAUTHORIZED', error: 'invalid internal secret' });
    return false;
  }
  return true;
}

export function createInternalAuditRouter(): express.Router {
  const router = express.Router();

  /** Is the internal audit surface usable at all? Cheap liveness for callers. */
  router.get('/internal/audit', (req, res) => {
    if (!guard(req, res)) return;
    res.json({
      ok: true,
      service: 'openhub-internal-audit',
      // The allowlist is part of the contract: a caller that cannot see which
      // roots are permitted can only discover it by being refused.
      allowedRepoRoots: [process.env.OPENHUB_REPOS_ROOT, process.env.OPENHUB_EXTRA_REPO_ROOTS].filter(Boolean),
    });
  });

  /**
   * Run the audit suite against a named directory.
   * Body: { targetDir, repoUrl?, scorers?, preset?, full? }
   */
  router.post('/internal/audit/run', async (req, res) => {
    if (!guard(req, res)) return;

    const targetDir = typeof req.body?.targetDir === 'string' ? req.body.targetDir.trim() : '';
    if (!targetDir) {
      return res.status(400).json({ ok: false, error: 'targetDir is required' });
    }
    // Containment, via the same guard the interactive routes use.
    if (!isAllowedRepoDir(targetDir)) {
      return res.status(403).json({
        ok: false,
        error: 'targetDir is outside the allowed repository roots (OPENHUB_REPOS_ROOT / OPENHUB_EXTRA_REPO_ROOTS)',
      });
    }
    if (!fs.existsSync(targetDir)) {
      return res.status(400).json({ ok: false, error: `targetDir does not exist: ${targetDir}` });
    }
    if (req.body?.full === true) {
      return res.status(400).json({
        ok: false,
        error: 'full: true is not permitted on the internal surface (too expensive for a scheduled caller); request a preset instead',
      });
    }

    const scorers = Array.isArray(req.body?.scorers)
      ? (req.body.scorers.filter((s: unknown): s is ScorerName => typeof s === 'string') as ScorerName[])
      : undefined;

    try {
      const report = await executeAuditSuite({
        targetDir,
        ...(typeof req.body?.repoUrl === 'string' && req.body.repoUrl ? { repoUrl: req.body.repoUrl } : {}),
        ...(scorers && scorers.length > 0 ? { scorers } : {}),
        ...(typeof req.body?.preset === 'string' && req.body.preset ? { preset: req.body.preset } : {}),
        ...(typeof req.body?.base === 'string' && req.body.base ? { base: req.body.base } : {}),
        // Recurrence comparison is opt-in: the interactive route feeds the
        // previous report in, but a scheduled caller wants an absolute reading.
        requiredScorers: [],
      });
      return res.json({ ok: true, report });
    } catch (err: any) {
      // The suite failing is a real, reportable outcome — the caller needs to
      // distinguish "audited and found problems" from "could not audit".
      return res.status(500).json({
        ok: false,
        error: err?.message ? String(err.message) : 'audit suite failed',
      });
    }
  });

  return router;
}
