import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { isSubpath } from './pathGuard.js';
import { getActiveProject } from '../services/projectContext.js';

/**
 * Review/audit target resolution.
 *
 * Every route that accepts a caller-supplied directory funnels through here.
 * A raw `path.resolve(req.body.targetDir)` lets an authenticated caller point
 * the reviewer, the patch applier or a spawned `git` at ANY directory on the
 * host — which is how `apply-suggestion` became an arbitrary file write and
 * how a checked-out hostile repo became code execution. The rule is:
 *
 *   - no target at all  -> the caller's own active project
 *   - an explicit target -> must be the active project, or live under one of
 *                           the configured repo roots
 *
 * `OPENHUB_REPOS_ROOT` (same default as server.ts) plus the optional
 * colon/semicolon-separated `OPENHUB_EXTRA_REPO_ROOTS` define the allowlist.
 */

export type ReviewTarget =
  | { ok: true; dir: string }
  | { ok: false; status: number; error: string };

function splitRoots(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(process.platform === 'win32' ? ';' : ':')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Directories a caller is allowed to aim the reviewer at. */
export function allowedRepoRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const primary = env.OPENHUB_REPOS_ROOT
    || path.join(os.homedir(), 'Documents', 'openhub', 'repos');
  return [primary, ...splitRoots(env.OPENHUB_EXTRA_REPO_ROOTS)].map((p) => path.resolve(p));
}

/** True when `dir` is one of the allowed roots or nested inside one. */
export function isAllowedRepoDir(dir: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const resolved = path.resolve(dir);
  return allowedRepoRoots(env).some((root) => isSubpath(root, resolved));
}

/**
 * Resolve the directory a review/patch request may operate on.
 * `userId` comes from the auth middleware, never from the body.
 */
export function resolveReviewTarget(userId: string | undefined, requested: unknown): ReviewTarget {
  const active = typeof userId === 'string' && userId.trim() ? getActiveProject(userId) : null;

  if (requested === undefined || requested === null || requested === '') {
    if (!active) {
      return { ok: false, status: 409, error: 'Load a project first (or pass an allowlisted targetDir)' };
    }
    return { ok: true, dir: path.resolve(active.path) };
  }

  if (typeof requested !== 'string' || !requested.trim()) {
    return { ok: false, status: 400, error: 'targetDir must be a non-empty string' };
  }

  const resolved = path.resolve(requested);
  const permitted = (active && isSubpath(path.resolve(active.path), resolved)) || isAllowedRepoDir(resolved);
  if (!permitted) {
    return { ok: false, status: 403, error: 'targetDir is outside the allowed repository roots' };
  }
  try {
    if (!fs.statSync(resolved).isDirectory()) {
      return { ok: false, status: 400, error: 'targetDir is not a directory' };
    }
  } catch {
    return { ok: false, status: 404, error: 'targetDir does not exist' };
  }
  return { ok: true, dir: resolved };
}

/**
 * The authenticated subject, as the auth middleware puts it on the request.
 * Accepts `unknown` so any caller can pass its `req` without importing auth types.
 */
export function callerId(req: unknown): string | undefined {
  const sub = (req as { user?: { sub?: unknown } } | null | undefined)?.user?.sub;
  return typeof sub === 'string' && sub.trim() ? sub : undefined;
}

/**
 * Resolve a directory a read-only scan/discovery route may operate on.
 *
 * Same allowlist as review targets, but with a different default: an omitted
 * target falls back to `fallback` (the server's working directory) instead of
 * erroring, preserving the historic cwd default. An explicit target must be the
 * caller's active project or live under a configured repo root — a raw
 * `path.resolve(req.query.dir)` let any authenticated caller enumerate and read
 * arbitrary host directories (audit-core, vuln scan, endpoint discovery).
 */
export function resolveScanTarget(
  userId: string | undefined,
  requested: unknown,
  fallback: string = process.cwd(),
): ReviewTarget {
  if (requested === undefined || requested === null || (typeof requested === 'string' && !requested.trim())) {
    return { ok: true, dir: path.resolve(fallback) };
  }
  return resolveReviewTarget(userId, requested);
}

/**
 * Validate a caller-supplied git revision. Anything starting with `-` is an
 * option, not a ref: `git diff --output=<path>` writes files and
 * `git diff --ext-diff` runs a command configured by the repo under review.
 */
export function isSafeGitRef(ref: unknown): ref is string {
  if (typeof ref !== 'string') return false;
  const value = ref.trim();
  if (!value || value.length > 200) return false;
  if (value.startsWith('-')) return false;
  return /^[A-Za-z0-9._\/~^@{}-]+$/.test(value) && !value.includes('..');
}

/** Resolve a caller-supplied relative file path inside `root`, or null. */
export function safeRepoFile(root: string, requested: unknown): string | null {
  if (typeof requested !== 'string' || !requested.trim()) return null;
  if (requested.includes('\0')) return null;
  const rel = requested.replace(/\\/g, '/').replace(/^[/\\]+/, '');
  const abs = path.resolve(root, rel);
  if (!isSubpath(root, abs)) return null;
  return abs;
}
