/**
 * Audit scope resolution (Workstream E1).
 *
 * An audit is either `full` (every file in the target) or `diff` (only what
 * changed vs a base ref). Diff mode is the default when the target is a git
 * work tree because it answers the question operators actually ask — "did this
 * change make things better or worse?" — and it keeps large-repo audits fast.
 *
 * A large-diff guard forces `full` when the change set is big enough that a
 * diff-scoped audit would be misleading or as expensive as a full one.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

const execFileAsync = promisify(execFile);

export type AuditScopeMode = 'full' | 'diff';

export interface AuditScope {
  mode: AuditScopeMode;
  /** Base ref the diff was taken against (null in full mode). */
  base: string | null;
  /** Changed paths, POSIX-separated, relative to the target. */
  changedFiles: string[];
  insertions: number;
  deletions: number;
  /** Human note when the mode had to fall back or was forced. */
  note?: string;
}

export const DEFAULT_SCOPE_BASE = 'HEAD';
export const MAX_DIFF_FILES = 500;
export const MAX_DIFF_INSERTIONS = 20_000;

export const FULL_SCOPE: AuditScope = {
  mode: 'full',
  base: null,
  changedFiles: [],
  insertions: 0,
  deletions: 0,
};

async function git(targetDir: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', targetDir, ...args], {
      timeout: 20_000,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return null;
  }
}

export interface ResolveScopeOptions {
  base?: string;
  /** Force a full audit regardless of git. */
  full?: boolean;
  maxFiles?: number;
  maxInsertions?: number;
}

/**
 * Resolve the audit scope for `targetDir`. Never throws — a non-git dir, a bad
 * base ref, or an oversized diff all degrade to an explicit `full` scope with a
 * `note` explaining why.
 */
export async function resolveAuditScope(
  targetDir: string,
  opts: ResolveScopeOptions = {},
): Promise<AuditScope> {
  if (opts.full) return { ...FULL_SCOPE, note: 'full audit requested' };

  const inside = await git(targetDir, ['rev-parse', '--is-inside-work-tree']);
  if (!inside || inside.trim() !== 'true') {
    return { ...FULL_SCOPE, note: 'not a git work tree — full audit' };
  }

  const base = opts.base || DEFAULT_SCOPE_BASE;
  const numstat = await git(targetDir, ['diff', '--numstat', base]);
  if (numstat === null) {
    return { ...FULL_SCOPE, base, note: `git diff vs ${base} failed — full audit` };
  }

  const changedFiles: string[] = [];
  const seen = new Set<string>();
  let insertions = 0;
  let deletions = 0;
  for (const line of numstat.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const file = parts.slice(2).join('\t').trim();
    if (!file) continue;
    const posix = file.replace(/\\/g, '/');
    if (seen.has(posix)) continue;
    seen.add(posix);
    changedFiles.push(posix);
    insertions += Number(parts[0]) || 0;
    deletions += Number(parts[1]) || 0;
  }

  // `git diff` omits untracked files, but a brand-new file is a change the
  // audit must see. Count each untracked file and its lines as insertions.
  const untracked = await git(targetDir, ['ls-files', '--others', '--exclude-standard']);
  if (untracked) {
    for (const rel of untracked.split(/\r?\n/)) {
      const file = rel.trim();
      if (!file) continue;
      const posix = file.replace(/\\/g, '/');
      if (seen.has(posix)) continue;
      seen.add(posix);
      changedFiles.push(posix);
      try {
        insertions += fs.readFileSync(path.join(targetDir, file), 'utf8').split(/\r?\n/).length;
      } catch { /* unreadable — still counts as a changed path */ }
    }
  }

  if (changedFiles.length === 0) {
    return { mode: 'diff', base, changedFiles, insertions, deletions, note: 'no changed files vs base' };
  }

  const maxFiles = opts.maxFiles ?? MAX_DIFF_FILES;
  const maxInsertions = opts.maxInsertions ?? MAX_DIFF_INSERTIONS;
  if (changedFiles.length > maxFiles || insertions > maxInsertions) {
    return {
      mode: 'full',
      base,
      changedFiles,
      insertions,
      deletions,
      note: `diff too large (${changedFiles.length} files, ${insertions} insertions) — full audit`,
    };
  }

  return { mode: 'diff', base, changedFiles, insertions, deletions };
}
