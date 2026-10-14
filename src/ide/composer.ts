// Pure parsing for the multi-file composer.
//
// A composer turn asks Axiom to return whole-file edits as fenced code blocks
// whose info string names a repo-relative path, e.g.
//     ```src/lib/a.ts
//     <full file contents>
//     ```
// (also accepts `path=...`, `ts src/a.ts`, backslash paths and `./` prefixes).
// Blocks without a resolvable path are illustrative snippets, not edits, so they
// are ignored rather than mis-applied. Kept free of the DOM/fetch so the parser
// is unit-tested in isolation.

export interface ComposerFile {
  /** Normalized repo-relative path (forward slashes, no leading `./` or `/`). */
  path: string;
  /** Full proposed file contents (trailing newline guaranteed when non-empty). */
  content: string;
}

export interface ParsedComposer {
  files: ComposerFile[];
  /** Fenced blocks skipped because they carried no file path. */
  ignored: number;
}

const FENCE = /```([^\n`]*)\n([\s\S]*?)```/g;

function stripQuotes(token: string): string {
  return token.replace(/^[`'"]+/, '').replace(/[`'"]+$/, '');
}

/** A token is treated as a file path when it has a path separator or a file
 *  extension. A bare language id (`ts`, `python`) has neither, so it is ignored. */
function looksLikePath(token: string): boolean {
  if (!token || token.includes('=')) return false;
  if (token.includes('/') || token.includes('\\')) return true;
  return /^[\w.-]+\.[A-Za-z0-9]{1,6}$/.test(token);
}

/** Extract the repo-relative path from a fence info string, or null. */
export function pathFromInfo(info: string): string | null {
  const trimmed = info.trim();
  if (!trimmed) return null;
  const explicit = trimmed.match(/(?:^|\s)path=("[^"]*"|'[^']*'|\S+)/i);
  if (explicit) return stripQuotes(explicit[1]);
  for (const token of trimmed.split(/\s+/)) {
    const clean = stripQuotes(token);
    if (looksLikePath(clean)) return clean;
  }
  return null;
}

export function normalizeRepoPath(p: string): string {
  return p.trim().replace(/\\/g, '/').replace(/^\.?\//, '').replace(/\/{2,}/g, '/');
}

/** Parse whole-file edits out of a composer response. Later blocks for the same
 *  path win (models sometimes restate a file after revising it). */
export function parseCodeFences(text: string): ParsedComposer {
  const byPath = new Map<string, string>();
  let ignored = 0;
  FENCE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FENCE.exec(text)) !== null) {
    const rawPath = pathFromInfo(m[1] ?? '');
    let body = m[2] ?? '';
    if (!rawPath) { ignored += 1; continue; }
    const path = normalizeRepoPath(rawPath);
    if (!path || !body.trim()) { ignored += 1; continue; }
    if (!body.endsWith('\n')) body += '\n';
    byPath.set(path, body);
  }
  return { files: [...byPath].map(([path, content]) => ({ path, content })), ignored };
}
