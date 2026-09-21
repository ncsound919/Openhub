import { Router, type Request, type Response, type NextFunction } from 'express';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { reviewCodeDiff, applyReviewPatch } from '../services/codeReviewer.js';
import { resolveReviewTarget, isSafeGitRef, safeRepoFile } from '../lib/reviewTarget.js';

const execFileAsync = promisify(execFile);

export interface CodeReviewRouterOptions {
  authMiddleware?: (req: Request, res: Response, next: NextFunction) => void;
}

/** The authenticated subject, as the auth middleware puts it on the request. */
function callerId(req: Request): string | undefined {
  const sub = (req.user as { sub?: unknown } | undefined)?.sub;
  return typeof sub === 'string' && sub.trim() ? sub : undefined;
}

export function createCodeReviewRouter(options: CodeReviewRouterOptions = {}): Router {
  const router = Router();
  const auth = options.authMiddleware ?? ((_req, _res, next) => next());

  /**
   * POST /api/review/diff
   * Run semantic code review on a git working tree or a supplied diff.
   *
   * `targetDir` is resolved against the caller's active project and the
   * configured repo roots — it is never taken at face value, because a raw
   * directory here spawns git anywhere on the host.
   */
  router.post('/diff', auth, async (req: Request, res: Response) => {
    const target = resolveReviewTarget(callerId(req), req.body?.targetDir ?? req.query.targetDir);
    if (!target.ok) return res.status(target.status).json({ ok: false, error: target.error });

    const { baseRef, diffText } = req.body ?? {};
    if (baseRef !== undefined && !isSafeGitRef(baseRef)) {
      return res.status(400).json({ ok: false, error: 'Invalid baseRef' });
    }
    if (diffText !== undefined && typeof diffText !== 'string') {
      return res.status(400).json({ ok: false, error: 'diffText must be a string' });
    }

    try {
      const result = await reviewCodeDiff(target.dir, { baseRef, diffText });
      return res.json({ ok: true, result });
    } catch (err: any) {
      return res.status(500).json({ ok: false, error: err.message || 'Failed to review code diff' });
    }
  });

  /**
   * POST /api/review/file
   * Review a single file's diff — used by the file-level panel for incremental
   * re-review. Body: { targetDir?, filePath, baseRef? }
   */
  router.post('/file', auth, async (req: Request, res: Response) => {
    const target = resolveReviewTarget(callerId(req), req.body?.targetDir);
    if (!target.ok) return res.status(target.status).json({ ok: false, error: target.error });

    const { filePath, baseRef } = req.body ?? {};
    if (baseRef !== undefined && !isSafeGitRef(baseRef)) {
      return res.status(400).json({ ok: false, error: 'Invalid baseRef' });
    }
    const abs = safeRepoFile(target.dir, filePath);
    if (!abs) return res.status(400).json({ ok: false, error: 'Invalid or unsafe filePath' });
    const safePath = path.relative(target.dir, abs).replace(/\\/g, '/');

    try {
      // `--` terminates option parsing so a path can never be read as a flag.
      const { stdout: diffText } = await execFileAsync(
        'git',
        ['diff', baseRef || 'HEAD', '--', safePath],
        { cwd: target.dir, windowsHide: true, timeout: 15_000, maxBuffer: 500_000 },
      ).catch(async () =>
        execFileAsync('git', ['diff', '--cached', '--', safePath], {
          cwd: target.dir,
          windowsHide: true,
          timeout: 15_000,
          maxBuffer: 500_000,
        }),
      );

      const result = await reviewCodeDiff(target.dir, { baseRef, diffText });
      const forFile = (name: string) => name === safePath || name.endsWith(`/${safePath}`);
      const fileResult = {
        ...result,
        comments: result.comments.filter((c) => forFile(c.file)),
        fileScores: Object.fromEntries(Object.entries(result.fileScores).filter(([f]) => forFile(f))),
      };

      return res.json({ ok: true, result: fileResult });
    } catch (err: any) {
      return res.status(500).json({ ok: false, error: err.message || 'Failed to review file' });
    }
  });

  /**
   * POST /api/review/apply-suggestion
   * Apply a review fix to disk. Both the directory and the file are contained;
   * `applyReviewPatch` re-checks containment so the primitive is safe on its own.
   */
  router.post('/apply-suggestion', auth, async (req: Request, res: Response) => {
    const target = resolveReviewTarget(callerId(req), req.body?.targetDir);
    if (!target.ok) return res.status(target.status).json({ ok: false, error: target.error });

    const { file, original, replacement } = req.body ?? {};
    if (typeof file !== 'string' || typeof original !== 'string' || typeof replacement !== 'string') {
      return res
        .status(400)
        .json({ ok: false, error: 'file, original, and replacement are required strings' });
    }
    if (replacement.length > 200_000) {
      return res.status(413).json({ ok: false, error: 'replacement is too large' });
    }

    try {
      const outcome = applyReviewPatch(target.dir, file, original, replacement);
      if (!outcome.success) {
        return res.status(400).json({ ok: false, error: outcome.error });
      }
      return res.json({ ok: true, message: `Patch successfully applied to ${file}` });
    } catch (err: any) {
      return res.status(500).json({ ok: false, error: err.message || 'Failed to apply suggested patch' });
    }
  });

  /**
   * POST /api/review/dismiss
   * Validates a dismissal for the audit trail; state lives client-side.
   */
  router.post('/dismiss', auth, async (req: Request, res: Response) => {
    const { commentId, reason } = req.body ?? {};
    if (!commentId || typeof commentId !== 'string') {
      return res.status(400).json({ ok: false, error: 'commentId is required' });
    }
    const validReasons = ['false-positive', 'wont-fix', 'already-fixed', 'not-applicable'];
    if (reason && !validReasons.includes(reason)) {
      return res.status(400).json({ ok: false, error: `reason must be one of: ${validReasons.join(', ')}` });
    }
    return res.json({ ok: true, commentId, dismissed: true, reason: reason || 'not-applicable' });
  });

  return router;
}
