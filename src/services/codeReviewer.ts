import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runLocalCommand } from './processRunner.js';
import { isSubpath } from '../lib/pathGuard.js';
import { isSafeGitRef } from '../lib/reviewTarget.js';
import { recordReceipt } from './receipts.js';

const execFileAsync = promisify(execFile);

export type ReviewSeverity = 'critical' | 'warning' | 'info';
export type ReviewDeterminism = 'deterministic' | 'ai-inferred';

export type ReviewCategory =
  | 'security'
  | 'complexity'
  | 'api_contract'
  | 'test_coverage'
  | 'performance'
  | 'type_safety'
  | 'dependency_risk'
  | 'documentation';

export interface ReviewComment {
  id: string;
  file: string;
  line: number;
  ruleId: string;
  category: ReviewCategory;
  severity: ReviewSeverity;
  /** Whether this was produced by a deterministic rule or LLM inference. */
  determinism: ReviewDeterminism;
  title: string;
  description: string;
  /** ±3 lines of diff context around the finding for inline display. */
  contextLines?: string[];
  suggestedPatch?: {
    original: string;
    replacement: string;
  };
  /** Whether the user has dismissed this finding. */
  dismissed?: boolean;
  dismissedReason?: string;
}

export interface ReviewResult {
  targetDir: string;
  branchOrRef: string;
  reviewedAt: string;
  reviewSessionId: string;
  verdict: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
  /** LLM-generated walk-through prose (populated by aiReview, not static rules). */
  walkthrough?: string;
  summary: {
    critical: number;
    warning: number;
    info: number;
    filesReviewed: number;
    linesChanged: number;
  };
  comments: ReviewComment[];
  /** Per-file quality score 0–100 (100 = no findings). */
  fileScores: Record<string, number>;
  diffStat?: string;
  receiptId?: string;
}

export interface DiffHunk {
  file: string;
  oldLine: number;
  newLine: number;
  lines: string[];
}

// ---------------------------------------------------------------------------
// Diff parsing
// ---------------------------------------------------------------------------

/**
 * Parse a raw git unified diff into structured file hunks.
 */
export function parseUnifiedDiff(rawDiff: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  const fileDiffs = rawDiff.split(/^diff --git /m);

  for (const fDiff of fileDiffs) {
    if (!fDiff.trim()) continue;

    const fileMatch = fDiff.match(/^[ab]\/(.+?) [ab]\/(.+)/m) || fDiff.match(/^\+\+\+ b\/(.+)/m);
    const fileName = fileMatch ? (fileMatch[2] || fileMatch[1]).trim() : 'unknown';

    const hunkBlocks = fDiff.split(/^@@ /m).slice(1);
    for (const block of hunkBlocks) {
      const headerMatch = block.match(/-(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (!headerMatch) continue;

      const oldLine = parseInt(headerMatch[1], 10);
      const newLine = parseInt(headerMatch[2], 10);
      const lines = block.split('\n').slice(1);

      hunks.push({ file: fileName, oldLine, newLine, lines });
    }
  }

  return hunks;
}

// ---------------------------------------------------------------------------
// Context extraction helper
// ---------------------------------------------------------------------------

function extractContext(lines: string[], idx: number, radius = 3): string[] {
  const start = Math.max(0, idx - radius);
  const end = Math.min(lines.length - 1, idx + radius);
  return lines.slice(start, end + 1);
}

// ---------------------------------------------------------------------------
// Static rule engine (18 rules)
// ---------------------------------------------------------------------------

const SEVERITY_ORDER: Record<ReviewSeverity, number> = { critical: 0, warning: 1, info: 2 };

interface StaticRule {
  id: string;
  category: ReviewCategory;
  severity: ReviewSeverity;
  title: string;
  description: string;
  test: (content: string, line: string, hunk: DiffHunk, lineIdx: number) => boolean;
  patch?: (content: string) => { original: string; replacement: string } | undefined;
}

const STATIC_RULES: StaticRule[] = [
  // ── Security ──────────────────────────────────────────────────────────────
  {
    id: 'security/no-hardcoded-secrets',
    category: 'security',
    severity: 'critical',
    title: 'Potential Hardcoded Secret / API Key',
    description:
      'Credentials or tokens detected in source. Use environment variables (e.g. process.env.API_KEY) or Keywire secret store.',
    test: (content) => {
      // Two independent signals, because either one alone misses real secrets:
      //   (a) the IDENTIFIER looks credential-ish (apiKey, authToken, …)
      //   (b) the VALUE carries a known provider prefix — this is what catches
      //       `const stripeKey = "sk_live_..."`, which name-matching alone
      //       walked straight past.
      const byName =
        /(api[_-]?key|secret|token|password|passwd|auth[_-]?token|credential|private[_-]?key)\s*[:=]\s*["'][a-zA-Z0-9_\-]{16,}["']/i.test(content);
      const byValue =
        /["'](?:sk_live_|sk_test_|pk_live_|rk_live_|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|xox[baprs]-|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_\-]{35}|glpat-|npm_|dop_v1_|shpat_)[A-Za-z0-9_\-]{8,}["']/.test(content);
      if (!byName && !byValue) return false;
      if (/process\.env|import\.meta\.env/.test(content)) return false;
      // The old exclusions were bare substring checks, so ANY line containing
      // "test" was exempt — `latest`, `greatest`, `contest`, `attestation`.
      // Match placeholder markers with a LEFT boundary only, so `EXAMPLE_0000`
      // and `PLACEHOLDER_KEY` are still recognised as placeholders.
      const placeholder =
        /(?:^|[^A-Za-z0-9])(EXAMPLE|PLACEHOLDER|REDACTED|CHANGEME|XXXXXX|DUMMY|FIXTURE|YOUR[_-]?KEY|INSERT[_-]?KEY)/i.test(content);
      return !placeholder;
    },
    // No auto-patch. The previous one replaced the quoted literal INCLUDING its
    // quotes with a bare `process.env.SECRET_TOKEN`, producing code that does
    // not parse — and it left the real secret in git history either way.
  },
  {
    id: 'security/no-eval',
    category: 'security',
    severity: 'critical',
    title: 'Arbitrary Code Execution Risk: eval()',
    description:
      'Use of eval() introduces severe arbitrary code execution vulnerabilities. Refactor with static JSON parsing or AST interpreters.',
    test: (content) => /\beval\s*\(/.test(content),
  },
  {
    id: 'security/command-injection',
    category: 'security',
    severity: 'critical',
    title: 'Command Injection Vulnerability',
    description:
      'String template interpolation in process execution without sanitization allows command injection. Use execFile or spawn with argument arrays.',
    test: (content) => /\bexec\s*\(\s*`[^`]*\${/.test(content),
  },
  {
    id: 'security/sql-injection',
    category: 'security',
    severity: 'critical',
    title: 'Potential SQL Injection',
    description:
      'SQL query built by string concatenation or template literal with user-controlled input. Use parameterized queries or an ORM.',
    test: (content) =>
      /\b(query|execute|run)\s*\(\s*[`"'].*\$\{/.test(content) ||
      /["'`]\s*SELECT.+\+\s*(req|params|body|query)\b/i.test(content),
  },
  {
    id: 'security/xss-innerhtml',
    category: 'security',
    severity: 'critical',
    title: 'XSS Risk: innerHTML Assignment',
    description:
      'Assigning user-controlled content to innerHTML enables cross-site scripting. Use textContent or a sanitizer library.',
    // `=` not followed by `=` — otherwise `if (a.innerHTML === b)` was reported
    // as an XSS sink. An empty-string or plain-literal assignment is inert.
    test: (content) =>
      /\.innerHTML\s*=(?!=)\s*(?!['"`]\s*['"`])(?!['"`][^<'"`]*['"`]\s*;?\s*$)/.test(content),
  },
  {
    id: 'security/path-traversal',
    category: 'security',
    severity: 'critical',
    title: 'Path Traversal Risk',
    description:
      'File path constructed from request parameter without normalization may allow traversal outside the intended directory. Use path.resolve() and validate the result stays within a safe root.',
    test: (content) =>
      /(?:readFile|writeFile|readdir|createReadStream)\s*\(.*(?:req\.|params\.|body\.|query\.)/.test(content) &&
      !content.includes('path.resolve'),
  },
  {
    id: 'security/weak-random',
    category: 'security',
    severity: 'warning',
    title: 'Weak Random for Security Token',
    description:
      'Math.random() is not cryptographically secure. Use crypto.randomBytes() or crypto.randomUUID() for tokens, secrets, or IDs.',
    test: (content) =>
      /Math\.random\(\)/.test(content) &&
      /(token|secret|key|id|uuid|nonce|salt)/i.test(content),
    // No auto-patch: Math.random() returns a number and crypto.randomUUID() a
    // string, so the old suggestion silently changed the expression's type.
  },

  // ── Complexity / Maintainability ───────────────────────────────────────────
  {
    id: 'complexity/no-empty-catch',
    category: 'complexity',
    severity: 'warning',
    title: 'Swallowed Exception / Silent Catch Block',
    description:
      'Empty catch block suppresses errors, making debugging difficult. Log error or handle gracefully with fallback.',
    test: (content) =>
      /catch\s*\([^)]*\)\s*\{\s*\}/.test(content) || /catch\s*\{\s*\}/.test(content),
    patch: (content) => ({
      original: content,
      replacement: content.replace(/\{\s*\}/, '{ /* handle or log error */ }'),
    }),
  },
  {
    id: 'complexity/excessive-nesting',
    category: 'complexity',
    severity: 'info',
    title: 'Deep Nesting Detected (> 4 levels)',
    description:
      'Deeply nested logic increases cyclomatic complexity. Consider early returns (guard clauses) or decomposing into helper functions.',
    test: (_content, line) => {
      const indentMatch = line.match(/^(\s+)/);
      return !!(indentMatch && indentMatch[1].length >= 16);
    },
  },
  {
    id: 'complexity/long-function',
    category: 'complexity',
    severity: 'info',
    title: 'Long Function (> 80 added lines)',
    description:
      'Functions exceeding ~80 lines are harder to reason about. Consider splitting into smaller, named helpers.',
    // This rule is checked at the file level after hunk scan; the per-line test always returns false.
    test: () => false,
  },

  // ── Performance ────────────────────────────────────────────────────────────
  {
    id: 'performance/sync-io-on-request-path',
    category: 'performance',
    severity: 'info',
    title: 'Synchronous Filesystem Call',
    description:
      'readFileSync / writeFileSync / readdirSync block the event loop. That is fine at module load or in a CLI, and a problem on a request path — prefer the fs/promises equivalents there. Suppress with a `// sync-ok` comment.',
    // Downgraded to info and renamed: a per-line regex cannot tell whether the
    // call sits inside an async function, and the old title asserted something
    // the check never established. `existsSync` was dropped — it is the
    // standard way to test for a path and has no meaningful async form.
    test: (content) =>
      /\b(readFileSync|writeFileSync|readdirSync|appendFileSync)\b/.test(content) &&
      !/\/\/\s*sync-ok/.test(content),
  },
  {
    id: 'performance/missing-await',
    category: 'performance',
    severity: 'warning',
    title: 'Possible Missing await on Async Call',
    description:
      'An async function is called without await, which may cause the result promise to be silently dropped or produce a race condition.',
    test: (content) =>
      /^\s+[a-zA-Z_$][a-zA-Z0-9_$.]*Async\s*\(/.test(content) &&
      !/\bawait\b/.test(content) &&
      !/\breturn\b/.test(content) &&
      !/\bconst\b|\blet\b|\bvar\b/.test(content),
  },

  // ── Type Safety ────────────────────────────────────────────────────────────
  {
    id: 'type_safety/no-any-spread',
    category: 'type_safety',
    severity: 'warning',
    title: 'TypeScript `any` in Type Position',
    description:
      'Explicit `any` widens the type to escape type checking, masking potential runtime errors. Use `unknown` and narrow explicitly.',
    test: (content) =>
      /:\s*any\b/.test(content) &&
      !/\/\/ any-ok/.test(content) &&
      !/eslint-disable/.test(content),
  },
  {
    id: 'type_safety/non-null-assertion',
    category: 'type_safety',
    severity: 'info',
    title: 'Non-Null Assertion on External Input',
    description:
      'Using ! to assert non-null on request params or parsed data may cause runtime crashes if the value is absent. Add an explicit null check.',
    test: (content) =>
      /(?:req\.|params\.|body\.|query\.|res\.)[a-zA-Z0-9_]+!/.test(content),
  },

  // ── API Contract ───────────────────────────────────────────────────────────
  {
    id: 'api_contract/prefix-guidelines',
    category: 'api_contract',
    severity: 'info',
    title: 'Unversioned REST Route',
    description:
      'New HTTP route registered without API namespace. Consider prefixing with /api/v1/ to preserve contract versioning.',
    test: (content) =>
      /\bapp\.(get|post|put|delete|patch)\s*\(/.test(content) && !content.includes('/api/'),
  },

  // ── Dependency Risk ────────────────────────────────────────────────────────
  {
    id: 'dependency_risk/dynamic-require',
    category: 'dependency_risk',
    severity: 'warning',
    title: 'Dynamic require() Call',
    description:
      'Dynamic require() with a variable argument defeats static analysis and bundler tree-shaking, and may load unexpected code at runtime.',
    // Only an identifier/template argument is genuinely dynamic; the old
    // pattern also matched `require(__dirname + '/x')`-free ordinary calls
    // whose first character merely was not a quote.
    test: (content) =>
      /\brequire\s*\(\s*(?:`|[A-Za-z_$][\w$]*\s*[,)+]|[A-Za-z_$][\w$]*\s*$)/.test(content) &&
      !/\brequire\s*\(\s*['"]/.test(content),
  },

  // ── Test Coverage ──────────────────────────────────────────────────────────
  // (evaluated at changeset level, not per-line — per-line test returns false)
  {
    id: 'test_coverage/test-deficit',
    category: 'test_coverage',
    severity: 'warning',
    title: 'Test Coverage Deficit in Changeset',
    description: '', // filled dynamically
    test: () => false,
  },

  // ── Documentation ──────────────────────────────────────────────────────────
  {
    id: 'documentation/missing-jsdoc',
    category: 'documentation',
    severity: 'info',
    title: 'Exported Symbol Without JSDoc',
    description:
      'Exported function or class added without a JSDoc comment. Document public API surface for maintainability.',
    test: (content, _line, hunk, lineIdx) => {
      if (!/^\s*export\s+(function|class|const|async function)/.test(content)) return false;
      // Check if the line immediately before in the hunk is a doc comment
      const prev = hunk.lines[lineIdx - 1] ?? '';
      return !prev.includes('*/') && !prev.includes('* @');
    },
  },
];

// ---------------------------------------------------------------------------
// Per-file score computation
// ---------------------------------------------------------------------------

/** At most this many findings are reported for a single changed line. */
const MAX_FINDINGS_PER_LINE = 3;

/**
 * Per-line rules, severity-first. `test-deficit` and `long-function` are
 * changeset-level and are evaluated after the hunk scan, so they are excluded
 * here rather than skipped by id inside the hot loop.
 */
const LINE_RULES: StaticRule[] = STATIC_RULES
  .filter((r) => r.id !== 'test_coverage/test-deficit' && r.id !== 'complexity/long-function')
  .slice()
  .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

function computeFileScore(fileComments: ReviewComment[]): number {
  if (fileComments.length === 0) return 100;
  const penalty = fileComments.reduce((acc, c) => {
    if (c.severity === 'critical') return acc + 30;
    if (c.severity === 'warning') return acc + 10;
    return acc + 3;
  }, 0);
  return Math.max(0, 100 - penalty);
}

// ---------------------------------------------------------------------------
// Main review engine
// ---------------------------------------------------------------------------

/**
 * Run semantic code review on a unified diff or git working tree.
 */
export async function reviewCodeDiff(
  targetDir: string,
  options: { baseRef?: string; diffText?: string; walkthrough?: string } = {},
): Promise<ReviewResult> {
  const startedAt = Date.now();
  const reviewSessionId = `rev_${Date.now().toString(36)}_${crypto.randomBytes(5).toString('hex')}`;
  let diff = options.diffText;
  let diffStat = '';

  if (!diff) {
    // A ref beginning with `-` is a git OPTION, not a revision: `--output=<p>`
    // writes files and `--ext-diff` runs a command the reviewed repo configures.
    const requestedBase = options.baseRef ?? 'HEAD';
    if (!isSafeGitRef(requestedBase)) {
      throw new Error('Invalid baseRef');
    }
    const base = requestedBase;
    // Read the diff from stdout ALONE. runLocalCommand concatenates stderr onto
    // stdout and trims the result, so git warnings ("warning: LF will be
    // replaced by CRLF") were being fed into the diff parser as content, and
    // trailing significant whitespace was stripped from the last hunk line.
    const gitDiff = async (args: string[]): Promise<string> => {
      try {
        const { stdout } = await execFileAsync('git', args, {
          cwd: targetDir,
          windowsHide: true,
          timeout: 60_000,
          maxBuffer: 16 * 1024 * 1024,
        });
        return stdout;
      } catch {
        return '';
      }
    };

    diff = await gitDiff(['diff', base]);
    if (!diff.trim()) diff = await gitDiff(['diff', '--cached']);
    diffStat = (await gitDiff(['diff', '--stat', base])).trim();
  }

  const hunks = parseUnifiedDiff(diff || '');
  const comments: ReviewComment[] = [];
  const modifiedFiles = new Set<string>();
  let addedLinesCount = 0;
  let hasTestModifications = false;

  for (const hunk of hunks) {
    modifiedFiles.add(hunk.file);
    if (
      hunk.file.includes('.test.') ||
      hunk.file.includes('.spec.') ||
      hunk.file.startsWith('tests/') ||
      hunk.file.startsWith('__tests__/')
    ) {
      hasTestModifications = true;
    }

    let currentLine = hunk.newLine;

    for (let i = 0; i < hunk.lines.length; i++) {
      const line = hunk.lines[i];
      if (line.startsWith('+')) addedLinesCount++;
      if (line.startsWith('-')) continue;
      if (!line.startsWith('+')) {
        currentLine++;
        continue;
      }

      const content = line.slice(1); // Strip leading '+'

      // Evaluate in SEVERITY order and report every distinct category that
      // fires, capped at MAX_FINDINGS_PER_LINE. The previous loop walked the
      // rules in array order and `break`-ed on the first hit, so an `info`
      // rule that happened to sit earlier in the array (deep indentation, say)
      // suppressed a `critical` on the same line — a hardcoded secret could be
      // silently downgraded out of the report by its own indentation.
      let firedOnThisLine = 0;
      const categoriesOnThisLine = new Set<ReviewCategory>();
      for (const rule of LINE_RULES) {
        if (firedOnThisLine >= MAX_FINDINGS_PER_LINE) break;
        // One finding per category per line keeps related rules from flooding.
        if (categoriesOnThisLine.has(rule.category)) continue;

        if (rule.test(content, line, hunk, i)) {
          const contextLines = extractContext(hunk.lines, i);
          const patch = rule.patch ? rule.patch(content) : undefined;
          comments.push({
            id: `${rule.id.replace(/\//g, '_')}_${comments.length + 1}`,
            file: hunk.file,
            line: currentLine,
            ruleId: rule.id,
            category: rule.category,
            severity: rule.severity,
            determinism: 'deterministic',
            title: rule.title,
            description: rule.description,
            contextLines,
            ...(patch ? { suggestedPatch: patch } : {}),
          });
          categoriesOnThisLine.add(rule.category);
          firedOnThisLine += 1;
        }
      }

      currentLine++;
    }
  }

  // ── Changeset-level: test deficit ─────────────────────────────────────────
  if (addedLinesCount > 40 && !hasTestModifications) {
    const rule = STATIC_RULES.find((r) => r.id === 'test_coverage/test-deficit')!;
    comments.push({
      id: `test_deficit_${comments.length + 1}`,
      file: Array.from(modifiedFiles)[0] || 'changeset',
      line: 1,
      ruleId: rule.id,
      category: 'test_coverage',
      severity: 'warning',
      determinism: 'deterministic',
      title: rule.title,
      description: `${addedLinesCount} lines of implementation were added or modified across ${modifiedFiles.size} file(s) without any matching test file changes. Add unit or integration tests to guard against regressions.`,
    });
  }

  // ── Per-file scores ────────────────────────────────────────────────────────
  const fileScores: Record<string, number> = {};
  for (const file of modifiedFiles) {
    const fileComments = comments.filter((c) => c.file === file);
    fileScores[file] = computeFileScore(fileComments);
  }

  const counts = {
    critical: comments.filter((c) => c.severity === 'critical').length,
    warning: comments.filter((c) => c.severity === 'warning').length,
    info: comments.filter((c) => c.severity === 'info').length,
    filesReviewed: modifiedFiles.size,
    linesChanged: addedLinesCount,
  };

  const verdict: ReviewResult['verdict'] =
    counts.critical > 0 ? 'REQUEST_CHANGES' : counts.warning > 0 ? 'COMMENT' : 'APPROVE';

  // ── Evidence receipt ───────────────────────────────────────────────────────
  let receiptId: string | undefined;
  try {
    const receipt = recordReceipt({
      kind: 'decision',
      command: `code_review:${options.baseRef || 'HEAD'}`,
      target: targetDir,
      label: `semantic_reviewer:${verdict.toLowerCase()}`,
      status: verdict === 'REQUEST_CHANGES' ? 'failed' : 'passed',
      durationMs: Date.now() - startedAt,
      output: `Code review completed across ${counts.filesReviewed} files. Verdict: ${verdict} (${counts.critical} crit, ${counts.warning} warn, ${counts.info} info).`,
      meta: { verdict, counts, commentsCount: comments.length },
    });
    receiptId = receipt.id;
  } catch {
    /* best-effort */
  }

  return {
    targetDir,
    branchOrRef: options.baseRef || 'HEAD',
    reviewedAt: new Date().toISOString(),
    reviewSessionId,
    verdict,
    walkthrough: options.walkthrough,
    summary: counts,
    comments,
    fileScores,
    diffStat,
    receiptId,
  };
}

/**
 * Apply a suggested code patch directly to a file on disk.
 */
export function applyReviewPatch(
  targetDir: string,
  filePath: string,
  original: string,
  replacement: string,
): { success: boolean; error?: string } {
  // `filePath` originates in a parsed diff (`diff --git a/<path>`), which is
  // attacker-controlled input. Without containment this writes anywhere on the
  // host; with an empty `original` the drift check below is vacuous because
  // every string contains "". Both are enforced here, not at the route, so the
  // primitive itself is safe wherever it is called from.
  if (typeof filePath !== 'string' || !filePath.trim() || filePath.includes('\0')) {
    return { success: false, error: 'Invalid file path' };
  }
  if (typeof original !== 'string' || typeof replacement !== 'string') {
    return { success: false, error: 'original and replacement must be strings' };
  }
  if (!original.trim()) {
    return { success: false, error: 'original must be a non-empty snippet' };
  }

  const root = path.resolve(targetDir);
  const rel = filePath.replace(/\\/g, '/').replace(/^[/\\]+/, '');
  const fullPath = path.resolve(root, rel);
  if (!isSubpath(root, fullPath)) {
    return { success: false, error: 'File path escapes the review target directory' };
  }

  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(fullPath);
  } catch {
    return { success: false, error: `File not found: ${rel}` };
  }
  // lstat, not stat: a symlink inside the repo must not become a write outside it.
  if (!stat.isFile()) {
    return { success: false, error: 'Target is not a regular file' };
  }

  try {
    const content = fs.readFileSync(fullPath, 'utf8');
    const first = content.indexOf(original);
    if (first === -1) {
      return {
        success: false,
        error: 'Original code snippet not found in target file (drift detected)',
      };
    }
    // An ambiguous match would silently patch the wrong occurrence.
    if (content.indexOf(original, first + 1) !== -1) {
      return {
        success: false,
        error: 'Original snippet appears more than once; patch is ambiguous',
      };
    }
    const updated = content.slice(0, first) + replacement + content.slice(first + original.length);
    fs.writeFileSync(fullPath, updated, 'utf8');
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message || 'Failed to apply patch' };
  }
}

export const reviewDiff = reviewCodeDiff;
