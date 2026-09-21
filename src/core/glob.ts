/**
 * Repository-relative glob matching for audit configuration (include/exclude
 * filters, path instructions). Dependency-free and deterministic.
 *
 * Supported syntax: `**` (any depth), `*` (within a segment), `?` (one char),
 * and single-level `{a,b}` alternation. Patterns without a `/` match at any
 * depth (so a bare `*.test.ts` matches at any depth). Paths are normalized to
 * forward slashes. An empty include list means "all paths".
 */

function normalizeInput(p: string): string {
  return p
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\//, '');
}

/** Normalize a path or pattern to a repo-relative, forward-slash form. */
export function normalizePath(p: string): string {
  return normalizeInput(String(p ?? '').trim());
}

/** Expand a single-level `{a,b}` group into every alternative. */
export function expandBraces(pattern: string): string[] {
  const open = pattern.indexOf('{');
  if (open === -1) return [pattern];
  const close = pattern.indexOf('}', open);
  if (close === -1) return [pattern];
  const prefix = pattern.slice(0, open);
  const suffix = pattern.slice(close + 1);
  const options = pattern.slice(open + 1, close).split(',');
  const out: string[] = [];
  for (const opt of options) {
    for (const rest of expandBraces(suffix)) out.push(`${prefix}${opt.trim()}${rest}`);
  }
  return out;
}

const REGEX_SPECIALS = new Set(['\\', '^', '$', '.', '|', '+', '(', ')', '[', ']', '{', '}']);

/** Compile one brace-free glob into an anchored RegExp. */
function globToRegExp(pattern: string): RegExp {
  let p = normalizePath(pattern);
  if (!p.includes('/')) p = `**/${p}`;
  let re = '^';
  for (let i = 0; i < p.length; i += 1) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        if (p[i + 2] === '/') {
          re += '(?:.*/)?'; // `**/` matches zero or more directories
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (REGEX_SPECIALS.has(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  re += '$';
  return new RegExp(re);
}

/** True when `path` matches the glob `pattern` (ignores a leading `!`). */
export function matchesGlob(path: string, pattern: string): boolean {
  const norm = normalizePath(path);
  const pat = String(pattern ?? '').replace(/^!/, '');
  if (!pat) return false;
  return expandBraces(pat).some((p) => globToRegExp(p).test(norm));
}

/**
 * Include/exclude decision for one path. Empty `include` means "all paths";
 * any matching `exclude` wins. This mirrors the include/`!exclude` semantics
 * used by CodeRabbit/cubic path filters.
 */
export function isPathIncluded(
  path: string,
  include: readonly string[] = [],
  exclude: readonly string[] = [],
): boolean {
  if (include.length > 0 && !include.some((p) => matchesGlob(path, p))) return false;
  if (exclude.some((p) => matchesGlob(path, p))) return false;
  return true;
}

/** Filter a file list down to those allowed by the include/exclude globs. */
export function filterPaths(
  paths: readonly string[],
  include: readonly string[] = [],
  exclude: readonly string[] = [],
): string[] {
  return paths.filter((p) => isPathIncluded(p, include, exclude));
}
