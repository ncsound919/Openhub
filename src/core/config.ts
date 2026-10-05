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

export type RuleSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export const RULE_SEVERITIES: readonly RuleSeverity[] = ['critical', 'high', 'medium', 'low', 'info'];

/** Per-repo active-rule ceiling (matches cubic's 5-agent limit). */
export const MAX_ACTIVE_RULES = 5;
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
  /** When non-empty, only these tools run. */
  enabled: string[];
  /** Tools removed from the active set (wins over `enabled`). */
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

export interface AuditConfig {
  version: 1;
  sensitivity: 'low' | 'medium' | 'high';
  rules: AuditRule[];
  pathInstructions: PathInstruction[];
  pathFilters: { include: string[]; exclude: string[] };
  tools: AuditToolToggles;
  gate: AuditGateConfig;
}

export interface AuditConfigResult {
  config: AuditConfig;
  /** The config file that was loaded, or null when defaults are in effect. */
  source: string | null;
  errors: string[];
  warnings: string[];
}

export const DEFAULT_AUDIT_CONFIG: AuditConfig = {
  version: 1,
  sensitivity: 'medium',
  rules: [],
  pathInstructions: [],
  pathFilters: { include: [], exclude: [] },
  tools: { enabled: [], disabled: [] },
  gate: { threshold: 'high', alwaysPass: false, drafts: false, maxChangedLines: 5000, ignoreLabels: [] },
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
  const name = String(pick(o, 'name', 'title') ?? '').trim();
  if (!name) {
    errors.push(`rules[${index}]: missing "name" — rule skipped`);
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

const KNOWN_TOP_LEVEL = new Set([
  'version', 'sensitivity', 'rules', 'custom_rules', 'customRules',
  'path_instructions', 'pathInstructions', 'path_filters', 'pathFilters',
  'tools', 'gate', 'reviews',
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

  // Bound the active-rule set (only the first MAX_ACTIVE_RULES enabled rules apply).
  let active = 0;
  const rules = parsedRules.map((r) => {
    if (!r.enabled) return r;
    active += 1;
    if (active > MAX_ACTIVE_RULES) {
      warnings.push(`${r.name}: over the ${MAX_ACTIVE_RULES}-rule active limit — disabled`);
      return { ...r, enabled: false };
    }
    return r;
  });

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
  opts: { fileName?: string; files?: readonly string[] } = {},
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
    return { config: DEFAULT_AUDIT_CONFIG, source: null, errors: [], warnings: [] };
  }
  try {
    const decoded = parseYaml(text);
    const normalized = normalizeAuditConfig(decoded);
    return { ...normalized, source };
  } catch (err) {
    return {
      config: DEFAULT_AUDIT_CONFIG,
      source,
      errors: [`failed to parse ${source}: ${(err as Error).message}`],
      warnings: [],
    };
  }
}
