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

/**
 * Caps that keep a hostile `openhub.yaml` from turning brace expansion into a
 * memory bomb (`{a,b}{a,b}{a,b}...` doubles per group). A pattern that exceeds
 * any cap is not expanded: its braces are matched literally.
 */
export const MAX_BRACE_ALTERNATIVES = 64;
export const MAX_BRACE_EXPANSIONS = 256;
export const MAX_GLOB_PATTERN_LENGTH = 512;

function expandCapped(pattern: string): string[] | null {
  const open = pattern.indexOf('{');
  if (open === -1) return [pattern];
  const close = pattern.indexOf('}', open);
  if (close === -1) return [pattern];
  const prefix = pattern.slice(0, open);
  const suffix = pattern.slice(close + 1);
  const options = pattern.slice(open + 1, close).split(',');
  if (options.length > MAX_BRACE_ALTERNATIVES) return null;
  const rests = expandCapped(suffix);
  if (!rests) return null;
  if (options.length * rests.length > MAX_BRACE_EXPANSIONS) return null;
  const out: string[] = [];
  for (const opt of options) {
    for (const rest of rests) out.push(`${prefix}${opt.trim()}${rest}`);
  }
  return out;
}

/**
 * Expand single-level `{a,b}` groups into every alternative. Bounded: at most
 * MAX_BRACE_ALTERNATIVES per group and MAX_BRACE_EXPANSIONS in total, and no
 * expansion at all for patterns longer than MAX_GLOB_PATTERN_LENGTH; past a
 * cap the pattern is returned unexpanded (braces then match literally).
 */
export function expandBraces(pattern: string): string[] {
  if (pattern.length > MAX_GLOB_PATTERN_LENGTH) return [pattern];
  return expandCapped(pattern) ?? [pattern];
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

/** Compiled patterns, so a pattern is expanded/compiled once, not once per file. */
const compiledCache = new Map<string, RegExp[]>();
const COMPILED_CACHE_MAX = 1000;

function compilePattern(pat: string): RegExp[] {
  const hit = compiledCache.get(pat);
  if (hit) return hit;
  // Over-long patterns never match (bounded regex size and backtracking).
  const compiled = pat.length > MAX_GLOB_PATTERN_LENGTH ? [] : expandBraces(pat).map(globToRegExp);
  if (compiledCache.size >= COMPILED_CACHE_MAX) compiledCache.clear();
  compiledCache.set(pat, compiled);
  return compiled;
}

/** True when `path` matches the glob `pattern` (ignores a leading `!`). */
export function matchesGlob(path: string, pattern: string): boolean {
  const norm = normalizePath(path);
  const pat = String(pattern ?? '').replace(/^!/, '');
  if (!pat) return false;
  return compilePattern(pat).some((re) => re.test(norm));
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
