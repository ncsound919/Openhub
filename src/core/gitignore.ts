/**
 * A minimal `.gitignore` matcher, used by the audit's directory walkers.
 *
 * Why this exists. Every walker in the audit carried its own hard-coded skip
 * set (`node_modules`, `dist`, `build`, ...). Those lists are written in the
 * tool's author's vocabulary, not the repo's: a JUCE/CMake project with eight
 * `build-*` directories matched none of them, so a run walked 21.26 GB /
 * 9,997 files of generated output and exceeded the MCP timeout. `.gitignore`
 * is the repo already stating, in its own words, what is generated — and it is
 * the same list the project's own CI and tooling honour.
 *
 * Deliberately NOT a full gitignore implementation. What is implemented is the
 * part that stops a walk: comments, blank lines, negation, anchored patterns,
 * directory-only patterns, `**`, and last-match-wins. Exotic escapes (`\ `, `\!`)
 * are passed through literally. An over-strict matcher is the safer failure
 * here: skipping a file the audit wanted is a coverage gap the report can name,
 * whereas walking 21 GB is a timeout that returns nothing at all.
 *
 * This never throws. A missing or unreadable `.gitignore` yields an empty
 * matcher, which behaves exactly as the walkers behaved before.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Hard cap on rules read, so a pathological .gitignore cannot slow every walk. */
const MAX_IGNORE_RULES = 2_000;
/** Hard cap on directories walked looking for nested .gitignore files. */
const MAX_NESTED_IGNORE_FILES = 32;

interface IgnoreRule {
  /** Directory the pattern is relative to, POSIX-normalized. '' = repo root. */
  base: string;
  negated: boolean;
  dirOnly: boolean;
  anchored: boolean;
  /** Compiled regex source for the pattern's path body. */
  body: RegExp;
}

/** Escape a literal string for use inside a RegExp. */
function escapeRe(s: string): string {
  return s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

/**
 * Translate one gitignore pattern into a regex matched against a repo-relative
 * POSIX path. Returns null for lines that carry no usable pattern.
 */
function compilePattern(pattern: string, base: string): IgnoreRule | null {
  let p = pattern;
  let negated = false;
  if (p.startsWith('!')) { negated = true; p = p.slice(1); }
  // An escaped leading '#' or '!' is a literal, not a comment/escape.
  else if (p.startsWith('\\#') || p.startsWith('\\!')) p = p.slice(1);
  if (!p) return null;

  let dirOnly = false;
  if (p.endsWith('/')) { dirOnly = true; p = p.slice(0, -1); }
  if (!p) return null;

  // A pattern containing a slash (other than a trailing one) is anchored to the
  // directory holding the .gitignore. Otherwise it matches at any depth.
  // Tested AFTER the trailing-slash strip: `build/` is dir-only and unanchored,
  // `docs/api/` is dir-only and anchored. Testing before would make every
  // dir-only pattern anchored to the root, which is the opposite of the rule.
  const anchored = p.includes('/');
  if (p.startsWith('/')) p = p.slice(1);

  const prefix = base ? `${escapeRe(base)}/` : '';
  let body = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        // '**' — consume it, plus a following '/', as "any depth".
        i++;
        if (p[i + 1] === '/') i++;
        body += '(?:.*/)?';
      } else {
        body += '[^/]*';
      }
    } else if (c === '?') {
      body += '[^/]';
    } else if (c === '[') {
      // Character class: copy through to the closing ']'.
      const close = p.indexOf(']', i + 1);
      if (close === -1) { body += '\\['; }
      else { body += p.slice(i, close + 1); i = close; }
    } else {
      body += escapeRe(c);
    }
  }

  const source = anchored || prefix
    ? `^${prefix}${body}(?:/.*)?$`
    : `^(?:.*/)?${body}(?:/.*)?$`;
  try {
    return { base, negated, dirOnly, anchored, body: new RegExp(source) };
  } catch {
    return null;
  }
}

/** Parse the contents of one .gitignore into rules relative to `base`. */
export function parseIgnoreFile(text: string, base: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    if (rules.length >= MAX_IGNORE_RULES) break;
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const rule = compilePattern(line, base);
    if (rule) rules.push(rule);
  }
  return rules;
}

export interface GitIgnoreMatcher {
  /** Is this repo-relative POSIX path ignored? `isDir` matters for `dir/` rules. */
  isIgnored(relPath: string, isDir?: boolean): boolean;
  /** Rules loaded, for reporting. */
  readonly ruleCount: number;
  /** .gitignore files actually read (the root one plus any nested ones). */
  readonly fileCount: number;
  /** True when a .gitignore existed. Absent file => matcher that ignores nothing. */
  readonly present: boolean;
}

const EMPTY: GitIgnoreMatcher = {
  isIgnored: () => false,
  ruleCount: 0,
  fileCount: 0,
  present: false,
};

/**
 * Load the root `.gitignore` plus any nested ones (bounded), and return a
 * matcher over repo-relative POSIX paths. Nested files are read eagerly for
 * the directories under `rootDir` up to a bounded depth — a walk is not a good
 * place to do lazy I/O per directory.
 */
export function loadGitIgnore(rootDir: string, opts: { maxDepth?: number } = {}): GitIgnoreMatcher {
  const maxDepth = opts.maxDepth ?? 6;
  const rules: IgnoreRule[] = [];

  const readOne = (dirAbs: string, base: string): boolean => {
    const abs = path.join(dirAbs, '.gitignore');
    let text: string;
    try {
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return false;
      text = fs.readFileSync(abs, 'utf8');
    } catch {
      return false;
    }
    rules.push(...parseIgnoreFile(text, base));
    return true;
  };

  const rootText = (() => {
    try {
      const abs = path.join(rootDir, '.gitignore');
      return fs.existsSync(abs) && fs.statSync(abs).isFile() ? fs.readFileSync(abs, 'utf8') : null;
    } catch {
      return null;
    }
  })();
  if (rootText === null) return EMPTY;

  rules.push(...parseIgnoreFile(rootText, ''));

  // Nested .gitignore files. Bounded in both count and depth: a monorepo can
  // have hundreds, and a walk that stats thousands of extra paths to save a
  // few would be its own problem.
  let filesRead = 1;
  const walk = (dirAbs: string, base: string, depth: number): void => {
    if (depth >= maxDepth || filesRead >= MAX_NESTED_IGNORE_FILES) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dirAbs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (filesRead >= MAX_NESTED_IGNORE_FILES) return;
      if (!e.isDirectory()) continue;
      // Never descend into the trees the walk itself would skip; reading a
      // .gitignore from inside node_modules is pure cost.
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const childBase = base ? `${base}/${e.name}` : e.name;
      const childAbs = path.join(dirAbs, e.name);
      if (readOne(childAbs, childBase)) filesRead++;
      walk(childAbs, childBase, depth + 1);
    }
  };
  walk(rootDir, '', 0);

  if (rules.length === 0) return EMPTY;

  return {
    present: true,
    ruleCount: rules.length,
    fileCount: filesRead,
    /**
     * Last match wins, which is what git does: a later `!keep.me` re-includes a
     * path an earlier rule excluded. Only the deepest matching rule counts, so a
     * nested .gitignore can override its parent — matching git's precedence.
     */
    isIgnored(relPath: string, isDir = false): boolean {
      const slashed = relPath.replace(/\\/g, '/');
      // A trailing slash is the caller saying "this is a directory". Normalizing
      // it away while leaving isDir false would make `build/` answer "not
      // ignored" against a `build/` rule, which is backwards.
      const wasDir = isDir || /\/$/.test(slashed);
      const p = slashed.replace(/^\.\//, '').replace(/\/+$/, '');
      if (!p) return false;
      // Ancestors, so a dir-only pattern (`build/`) ignores everything beneath
      // it whether the probe is a directory or a file inside one.
      const ancestors: string[] = [];
      {
        const parts = p.split('/');
        for (let i = 1; i < parts.length; i++) ancestors.push(parts.slice(0, i).join('/'));
      }
      let ignored = false;
      let bestDepth = -1;
      for (const rule of rules) {
        // A `build/` rule matches a path when the path IS that directory, or
        // when one of its ancestors is. It must NOT match a plain FILE named
        // `build` with no such ancestor — hence the dir flag gates the
        // self-test, while the ancestor test needs no flag.
        if (rule.dirOnly) {
          const self = wasDir && rule.body.test(p);
          if (!self && !ancestors.some((a) => rule.body.test(a))) continue;
        }
        if (!rule.body.test(p)) continue;
        // Precedence by the directory the rule was declared in: deeper wins,
        // so a nested .gitignore overrides its parent the way git resolves it.
        //
        // `ignored = !rule.negated`, not `= rule.negated`: a matching plain rule
        // IGNORES the path, and only a matching `!rule` re-includes it. Written
        // the other way round the matcher answers "nothing is ignored", which is
        // indistinguishable from a repo with no .gitignore — the exact failure
        // this module exists to prevent.
        const depth = rule.base ? rule.base.split('/').length : 0;
        if (depth > bestDepth) { bestDepth = depth; ignored = !rule.negated; }
        else if (depth === bestDepth) ignored = !rule.negated;
      }
      return ignored;
    },
  };
}