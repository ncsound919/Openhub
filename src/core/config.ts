/**
 * Audit configuration — the repo-local source of truth for rules, path
 * filters/instructions, tool toggles and PR/release gating. Mirrors the
 * `.coderabbit.yaml` / `cubic.yaml` model: partial config is supported, bad
 * values degrade to defaults with an explicit error (never a silent crash), and
 * every rule's active tool set is bounded.
 *
 * File: `openhub.yaml` (or `.openhub.yaml` / `audit.config.yaml`) at the repo
 * root. Both snake_case (CodeRabbit/cubic style) and camelCase keys are read.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { normalizePath } from './glob.js';
import { loadGitIgnore, type GitIgnoreMatcher } from './gitignore.js';

export type RuleSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export const RULE_SEVERITIES: readonly RuleSeverity[] = ['critical', 'high', 'medium', 'low', 'info'];

/**
 * Per-repo active-rule ceiling (matches cubic's 5-agent limit).
 *
 * Overflow is an ERROR, not a warning. It used to be a warning plus
 * `enabled: false`, which produced the worst shape this parser can emit:
 * a config you wrote and reasoned about, reported as
 * `errors: []`, with two of its own rules inert and nothing in the summary
 * saying the gate is weaker than the file implies. A rule that was written and
 * then silently disabled is a failure to load, and it now says so.
 *
 * `rules.maxActive` in openhub.yaml is the explicit opt-in to go past this. It
 * exists so raising the ceiling is a deliberate line in a repo's config rather
 * than something discovered after the fact.
 */
export const MAX_ACTIVE_RULES = 5;
/** Ceiling on `rules.maxActive`, so the opt-in cannot itself become unbounded. */
export const MAX_ACTIVE_RULES_HARD_LIMIT = 25;
/** Text + linked files share one budget (matches cubic's 10k-char limit). */
export const MAX_RULE_CHARS = 10_000;

export interface AuditRule {
  id: string;
  name: string;
  description: string;
  severity: RuleSeverity;
  /** Path globs the rule applies to (empty = everywhere). */
  include: string[];
  /** Path globs the rule never applies to (wins over include). */
  exclude: string[];
  /** Repo-relative instruction files whose contents are appended to the rule. */
  filePaths: string[];
  enabled: boolean;
}

export interface PathInstruction {
  /** Path glob the instruction applies to. */
  path: string;
  instructions: string;
}

export interface AuditToolToggles {
  /** When non-empty, restrict the run to these scorers. Intersected with the
   *  preset/stage plan in `resolveAuditPlan`, so it can subtract but not add. */
  enabled: string[];
  /** Scorers removed from the active set (wins over `enabled`). */
  disabled: string[];
}

export interface AuditGateConfig {
  /** Minimum severity that fails the gate. */
  threshold: RuleSeverity;
  /** Report findings but never block. */
  alwaysPass: boolean;
  /** Include draft PRs in gating. */
  drafts: boolean;
  /** Skip gating when the diff exceeds this many changed lines (null = no cap). */
  maxChangedLines: number | null;
  /** Labels that suppress gating. */
  ignoreLabels: string[];
}

export interface AuditPathFilters {
  include: string[];
  exclude: string[];
  /**
   * Honour the repo's `.gitignore` during directory walks. Default true.
   *
   * The hard-coded skip sets the walkers carry are written in the tool's
   * vocabulary, not the repo's — a project with eight `build-*` directories
   * matched none of them and a run walked 21.26 GB of generated output. The
   * repo already states what is generated; this makes the audit read that list.
   * `gitignore: false` restores the old behaviour (skip sets only).
   */
  respectGitIgnore: boolean;
  /**
   * Repo-declared exemptions from the git_history large-file rule.
   *
   * `{ path, reason }`, where `path` may be an exact repo-relative path or a
   * glob. The rule stays on by default: a 4.5 MB vendored model is a decision
   * and a 400 MB stray dump is a defect, and the tool cannot tell them apart.
   * Making the repo state the reason turns an unactionable recurring finding
   * into a recorded decision, and the exemption is reported in the scorer's
   * notes so "this was allowed, and why" stays visible.
   */
  allowLargeFiles: Array<{ path: string; reason: string }>;
}

export interface AuditConfig {
  version: 1;
  sensitivity: 'low' | 'medium' | 'high';
  rules: AuditRule[];
  pathInstructions: PathInstruction[];
  pathFilters: AuditPathFilters;
  tools: AuditToolToggles;
  gate: AuditGateConfig;
  /**
   * Commands the `local_qa` scorer runs INSTEAD of discovering and running every
   * test runner it finds. Each is `{ command, args?, cwd?, label? }`.
   *
   * This exists because `local_qa` used to run every suite it discovered with no
   * bound and no override: on a JUCE project that meant the full ~700s C++ suite
   * plus every vitest lane, which cannot return inside an MCP timeout, and there
   * was no way to scope it. A repo that knows which lane it wants says so.
   */
  testCommands: AuditTestCommand[];
  /** Hard cap on one test command. Default 600s; raise it deliberately. */
  testTimeoutMs: number;
}

export interface AuditTestCommand {
  command: string;
  args: string[];
  /** Repo-relative working directory. Defaults to the repo root. */
  cwd?: string;
  label: string;
}

export interface AuditConfigResult {
  config: AuditConfig;
  /** The config file that was loaded, or null when defaults are in effect. */
  source: string | null;
  errors: string[];
  warnings: string[];
  /**
   * The repo's `.gitignore`, when honouring it is enabled. Absent when the
   * config set `gitignore: false`, or when the caller passed
   * `withGitIgnore: false`. Absent also means "no .gitignore file exists",
   * which is a different thing and is reported by `gitIgnore.present`.
   */
  gitIgnore?: GitIgnoreMatcher;
}

export const DEFAULT_AUDIT_CONFIG: AuditConfig = {
  version: 1,
  sensitivity: 'medium',
  rules: [],
  pathInstructions: [],
  pathFilters: { include: [], exclude: [], respectGitIgnore: true, allowLargeFiles: [] },
  tools: { enabled: [], disabled: [] },
  gate: { threshold: 'high', alwaysPass: false, drafts: false, maxChangedLines: 5000, ignoreLabels: [] },
  testCommands: [],
  testTimeoutMs: 600_000,
};

export const AUDIT_CONFIG_FILES = ['openhub.yaml', 'openhub.yml', '.openhub.yaml', '.openhub.yml', 'audit.config.yaml'];

// ── normalization helpers ──────────────────────────────────────────────────

function asRecord(x: unknown): Record<string, unknown> {
  return x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : {};
}

function pick(o: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) if (o[k] !== undefined) return o[k];
  return undefined;
}

function asStringArray(x: unknown): string[] {
  if (Array.isArray(x)) return x.map((v) => String(v).trim()).filter(Boolean);
  if (typeof x === 'string' && x.trim()) return [x.trim()];
  return [];
}

function parseSeverity(x: unknown): RuleSeverity | undefined {
  const s = String(x ?? '').trim().toLowerCase();
  return (RULE_SEVERITIES as readonly string[]).includes(s) ? (s as RuleSeverity) : undefined;
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'unnamed';
}

/**
 * Resolve the active-rule ceiling. A non-numeric or out-of-range opt-in is an
 * error rather than a silent clamp: if a repo asks for 1000 and gets 25, the
 * rules it did not expect to lose are lost anyway, and the file should say so.
 */
function resolveMaxActiveRules(raw: unknown, errors: string[]): number {
  if (raw === undefined || raw === null) return MAX_ACTIVE_RULES;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    errors.push(`maxActiveRules: "${String(raw)}" is not a positive integer — using the default ${MAX_ACTIVE_RULES}`);
    return MAX_ACTIVE_RULES;
  }
  if (n > MAX_ACTIVE_RULES_HARD_LIMIT) {
    errors.push(
      `maxActiveRules: ${n} exceeds the hard limit of ${MAX_ACTIVE_RULES_HARD_LIMIT} — using ${MAX_ACTIVE_RULES_HARD_LIMIT}`,
    );
    return MAX_ACTIVE_RULES_HARD_LIMIT;
  }
  return n;
}

/** Reject absolute paths and parent traversal in linked file references. */
function safeRepoRelative(p: string): boolean {
  const raw = String(p ?? '').trim();
  if (!raw) return false;
  // Detect absolute paths before normalization strips the leading slash.
  if (/^([a-zA-Z]:[\\/]|[\\/])/.test(raw)) return false;
  const n = normalizePath(raw);
  return n.length > 0 && !n.split('/').includes('..');
}

function parseRule(raw: unknown, index: number, errors: string[], warnings: string[]): AuditRule | null {
  const o = asRecord(raw);
  // `id` is accepted as a name key. It used to be read only near the bottom of
  // this function, after this check, so a rule written as `id:` alone fell through
  // to the missing-name branch and was DROPPED — while the response still
  // echoed a derived `slug(name)` id that looked like a working key. Both
  // halves of that were wrong: the key was not honoured, and the failure was
  // dressed up as a success. Honoured here, `id` is the identity a config
  // author already chose, so it is accepted as the name when `name` is absent.
  const name = String(pick(o, 'name', 'title', 'id') ?? '').trim();
  if (!name) {
    errors.push(
      `rules[${index}]: needs a "name" (or "id") — rule skipped. `
      + `Keys present: ${Object.keys(o).join(', ') || '(none)'}.`,
    );
    return null;
  }
  let description = String(pick(o, 'description', 'instructions', 'text') ?? '').trim();
  const filePaths = asStringArray(pick(o, 'file_paths', 'filePaths', 'files'));
  const bad = filePaths.filter((f) => !safeRepoRelative(f));
  if (bad.length) {
    warnings.push(`${name}: ignored unsafe linked file path(s): ${bad.join(', ')}`);
  }
  const safeFilePaths = filePaths.filter(safeRepoRelative);
  if (description.length > MAX_RULE_CHARS) {
    warnings.push(`${name}: description truncated to ${MAX_RULE_CHARS} chars`);
    description = description.slice(0, MAX_RULE_CHARS);
  }
  if (!description && safeFilePaths.length === 0) {
    errors.push(`rules[${index}] (${name}): needs a "description" or "file_paths" — rule skipped`);
    return null;
  }
  const sev = parseSeverity(pick(o, 'severity', 'level'));
  if (pick(o, 'severity', 'level') !== undefined && !sev) {
    warnings.push(`${name}: unknown severity "${String(pick(o, 'severity', 'level'))}" — defaulted to medium`);
  }
  return {
    id: String(pick(o, 'id') ?? '').trim() || slug(name),
    name,
    description,
    severity: sev ?? 'medium',
    include: asStringArray(pick(o, 'include', 'paths', 'include_paths')),
    exclude: asStringArray(pick(o, 'exclude', 'exclude_paths')),
    filePaths: safeFilePaths,
    enabled: pick(o, 'enabled') === undefined ? true : pick(o, 'enabled') !== false,
  };
}

function parsePathInstructions(raw: unknown, warnings: string[]): PathInstruction[] {
  if (!Array.isArray(raw)) return [];
  const out: PathInstruction[] = [];
  for (const item of raw) {
    const o = asRecord(item);
    const glob = String(pick(o, 'path', 'files', 'glob') ?? '').trim();
    const instructions = String(pick(o, 'instructions', 'text', 'description') ?? '').trim();
    if (!glob || !instructions) {
      warnings.push('path_instructions: entry missing a path or instructions — skipped');
      continue;
    }
    out.push({ path: glob, instructions: instructions.slice(0, 20_000) });
  }
  return out;
}

/**
 * Parse the `tests:` block. Accepts a bare string command, or an object with
 * `command`/`run`, optional `args`, repo-relative `cwd`, and `label`.
 *
 * `cwd` is validated with the same traversal guard as a rule's linked files, so
 * a config cannot point a test command at a parent directory or an absolute
 * path outside the repo.
 */
function parseTestCommands(raw: unknown, errors: string[], warnings: string[]): AuditTestCommand[] {
  if (raw === undefined || raw === null) return [];
  // Two accepted shapes:
  //   tests: ["npm test"]                       — bare list
  //   tests: { commands: [...], timeoutMs: n }   — list plus the timeout, which
  //                                               a bare array has nowhere to put
  const block = asRecord(raw);
  const items = Array.isArray(raw)
    ? raw
    : pick(block, 'commands', 'run', 'entries') !== undefined
      ? (Array.isArray(pick(block, 'commands', 'run', 'entries'))
        ? pick(block, 'commands', 'run', 'entries') as unknown[]
        : [pick(block, 'commands', 'run', 'entries')])
      : [raw];
  const out: AuditTestCommand[] = [];
  for (const item of items) {
    if (typeof item === 'string' && item.trim()) {
      // A bare string is split on whitespace: no quoting layer, no shell, no
      // interpolation. This is argv, deliberately.
      const parts = item.trim().split(/\s+/);
      out.push({ command: parts[0], args: parts.slice(1), label: parts[0] });
      continue;
    }
    const o = asRecord(item);
    const command = String(pick(o, 'command', 'run', 'cmd') ?? '').trim();
    if (!command) {
      errors.push(`tests: entry needs a "command" — skipped`);
      continue;
    }
    const args = asStringArray(pick(o, 'args', 'arguments'));
    const cwdRaw = String(pick(o, 'cwd', 'dir') ?? '').trim();
    let cwd: string | undefined;
    if (cwdRaw) {
      if (!safeRepoRelative(cwdRaw)) {
        errors.push(`tests: "${command}" has an unsafe cwd "${cwdRaw}" (must be a repo-relative path) — entry skipped`);
        continue;
      }
      cwd = normalizePath(cwdRaw);
    }
    const label = String(pick(o, 'label') ?? '').trim() || `${command}${args.length ? ` ${args.join(' ')}` : ''}`;
    out.push({ command, args, ...(cwd ? { cwd } : {}), label });
  }
  if (items.length && out.length === 0) warnings.push('tests: no usable entries — local_qa will fall back to discovery');
  return out;
}

/** Resolve `tests.timeoutMs`. A non-positive or non-integer value is an error. */
function resolveTestTimeoutMs(raw: unknown, errors: string[]): number {
  if (raw === undefined || raw === null) return DEFAULT_AUDIT_CONFIG.testTimeoutMs;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    errors.push(`tests.timeoutMs: "${String(raw)}" is not a positive number — using the default ${DEFAULT_AUDIT_CONFIG.testTimeoutMs}ms`);
    return DEFAULT_AUDIT_CONFIG.testTimeoutMs;
  }
  return Math.floor(n);
}

/**
 * Parse `pathFilters.allowLargeFiles`. An entry without a reason is an ERROR,
 * not a skipped line: "this large file is fine" is only a decision if someone
 * wrote down why, and a reason-less exemption is indistinguishable from having
 * switched the rule off.
 */
function parseAllowLargeFiles(raw: unknown, errors: string[]): Array<{ path: string; reason: string }> {
  if (raw === undefined || raw === null) return [];
  const items = Array.isArray(raw) ? raw : [raw];
  const out: Array<{ path: string; reason: string }> = [];
  for (const item of items) {
    const o = asRecord(item);
    const p = String(pick(o, 'path', 'file', 'glob') ?? '').trim();
    const reason = String(pick(o, 'reason', 'why', 'justification') ?? '').trim();
    if (!p) {
      errors.push('pathFilters.allowLargeFiles: entry needs a "path" — skipped');
      continue;
    }
    if (!reason) {
      errors.push(`pathFilters.allowLargeFiles: "${p}" has no "reason" — skipped. A large-file exemption must say why the file is intentional.`);
      continue;
    }
    out.push({ path: normalizePath(p), reason });
  }
  return out;
}

const KNOWN_TOP_LEVEL = new Set([
  'version', 'sensitivity', 'rules', 'custom_rules', 'customRules',
  'path_instructions', 'pathInstructions', 'path_filters', 'pathFilters',
  'tools', 'gate', 'reviews', 'maxActiveRules', 'max_active_rules',
  'tests', 'test_commands', 'testCommands',
]);

/** Parse an already-decoded config object into a normalized AuditConfig. */
export function normalizeAuditConfig(raw: unknown): { config: AuditConfig; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const root = asRecord(raw);
  // Accept a nested `reviews:` block (CodeRabbit shape) or a flat document.
  const reviews = asRecord(pick(root, 'reviews'));
  const scope = { ...root, ...reviews };

  for (const key of Object.keys(root)) {
    if (!KNOWN_TOP_LEVEL.has(key)) warnings.push(`unknown top-level key "${key}" ignored`);
  }

  const sensitivityRaw = String(pick(scope, 'sensitivity') ?? 'medium').toLowerCase();
  const sensitivity = (['low', 'medium', 'high'] as const).includes(sensitivityRaw as never)
    ? (sensitivityRaw as AuditConfig['sensitivity'])
    : (warnings.push(`unknown sensitivity "${sensitivityRaw}" — defaulted to medium`), 'medium' as const);

  const rawRules = pick(scope, 'rules', 'custom_rules');
  const parsedRules = Array.isArray(rawRules)
    ? rawRules.map((r, i) => parseRule(r, i, errors, warnings)).filter((r): r is AuditRule => r !== null)
    : [];

  // Bound the active-rule set. `maxActiveRules` is the explicit opt-in past the
  // default ceiling; without it, an overflowing rule is an ERROR and every rule
  // over the limit is disabled, because a config that keeps half its own rules
  // inert while reporting `errors: []` is worse than one that refuses to load.
  const maxActiveRules = resolveMaxActiveRules(pick(root, 'maxActiveRules', 'max_active_rules'), errors);

  let active = 0;
  const overflow: string[] = [];
  const rules = parsedRules.map((r) => {
    if (!r.enabled) return r;
    active += 1;
    if (active > maxActiveRules) {
      overflow.push(r.name);
      return { ...r, enabled: false };
    }
    return r;
  });
  if (overflow.length) {
    errors.push(
      `${overflow.length} rule(s) over the ${maxActiveRules}-rule active limit and DISABLED: ${overflow.join(', ')}. `
      + `Rules kept: ${rules.filter((r) => r.enabled).length}. `
      + `Raise "maxActiveRules" (max ${MAX_ACTIVE_RULES_HARD_LIMIT}) to opt in, `
      + `or set "enabled: false" on the rules you are dropping.`,
    );
  }

  const pf = asRecord(pick(scope, 'path_filters', 'pathFilters'));
  const toolsRaw = asRecord(pick(scope, 'tools'));
  const gateRaw = asRecord(pick(scope, 'gate'));

  const gateSeverity = parseSeverity(pick(gateRaw, 'threshold', 'severity'));
  const maxLinesRaw = pick(gateRaw, 'max_changed_lines', 'maxChangedLines');
  const maxChangedLines = maxLinesRaw === null || maxLinesRaw === false
    ? null
    : Number.isFinite(Number(maxLinesRaw)) && Number(maxLinesRaw) >= 0
      ? Number(maxLinesRaw)
      : DEFAULT_AUDIT_CONFIG.gate.maxChangedLines;

  return {
    config: {
      version: 1,
      sensitivity,
      rules,
      pathInstructions: parsePathInstructions(pick(scope, 'path_instructions', 'pathInstructions'), warnings),
      pathFilters: {
        include: asStringArray(pick(pf, 'include', 'paths')),
        exclude: asStringArray(pick(pf, 'exclude', 'ignore')),
        // Default ON: honouring the repo's own .gitignore is strictly less
        // surprising than the tool's hard-coded skip list. Opt out with
        // `gitignore: false` / `respect_git_ignore: false`.
        respectGitIgnore: pick(pf, 'gitignore', 'respect_git_ignore', 'respectGitIgnore') !== false,
        allowLargeFiles: parseAllowLargeFiles(
          pick(pf, 'allow_large_files', 'allowLargeFiles'),
          errors,
        ),
      },
      tools: {
        enabled: asStringArray(pick(toolsRaw, 'enabled', 'only')),
        disabled: asStringArray(pick(toolsRaw, 'disabled', 'exclude')),
      },
      gate: {
        threshold: gateSeverity ?? (pick(gateRaw, 'threshold') !== undefined
          ? (warnings.push(`gate.threshold "${String(pick(gateRaw, 'threshold'))}" invalid — defaulted to high`), 'high')
          : 'high'),
        alwaysPass: pick(gateRaw, 'always_pass', 'alwaysPass') === true,
        drafts: pick(gateRaw, 'drafts') === true,
        maxChangedLines,
        ignoreLabels: asStringArray(pick(gateRaw, 'ignore_labels', 'ignoreLabels')),
      },
      testCommands: parseTestCommands(
        pick(scope, 'tests', 'test_commands', 'testCommands'),
        errors,
        warnings,
      ),
      testTimeoutMs: resolveTestTimeoutMs(
        pick(asRecord(pick(scope, 'tests')), 'timeoutMs', 'timeout_ms')
        ?? pick(root, 'test_timeout_ms'),
        errors,
      ),
    },
    errors,
    warnings,
  };
}

/**
 * Load and normalize the audit config for a repo root. Missing file → defaults.
 * Invalid YAML → defaults plus an explicit error (never throws).
 */
export function loadAuditConfig(
  rootDir: string,
  opts: { fileName?: string; files?: readonly string[]; withGitIgnore?: boolean } = {},
): AuditConfigResult {
  const candidates = opts.fileName ? [opts.fileName] : (opts.files ?? AUDIT_CONFIG_FILES);
  let source: string | null = null;
  let text: string | null = null;
  for (const name of candidates) {
    const abs = path.join(rootDir, name);
    try {
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        text = fs.readFileSync(abs, 'utf-8');
        source = name;
        break;
      }
    } catch {
      /* unreadable candidate — try the next */
    }
  }
  if (text === null) {
    return {
      config: DEFAULT_AUDIT_CONFIG,
      source: null,
      errors: [],
      warnings: [],
      ...(opts.withGitIgnore === false ? {} : { gitIgnore: loadGitIgnore(rootDir) }),
    };
  }
  try {
    const decoded = parseYaml(text);
    const normalized = normalizeAuditConfig(decoded);
    return {
      ...normalized,
      source,
      // Loaded here rather than inside normalizeAuditConfig because this is the
      // only function that knows the repo root, and a matcher is per-root.
      // Skipped when the config opted out, so `gitignore: false` costs nothing.
      ...(opts.withGitIgnore === false || !normalized.config.pathFilters.respectGitIgnore
        ? {}
        : { gitIgnore: loadGitIgnore(rootDir) }),
    };
  } catch (err) {
    return {
      config: DEFAULT_AUDIT_CONFIG,
      source,
      errors: [`failed to parse ${source}: ${(err as Error).message}`],
      warnings: [],
      ...(opts.withGitIgnore === false ? {} : { gitIgnore: loadGitIgnore(rootDir) }),
    };
  }
}
