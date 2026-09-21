/**
 * Plain-English rules engine — evaluates repo rules (from `openhub.yaml` plus
 * linked instruction files and path instructions) against changed/all files and
 * converts the model's findings into the shared `Finding` model.
 *
 * The LLM call is injected (`RuleCompleter`) so the engine is unit-testable,
 * provider-agnostic and honest: a rule that cannot be evaluated is reported as
 * skipped, never as a pass. Deterministic path selection happens before any
 * model call, so rules only see files they actually apply to.
 */
import fs from 'node:fs';
import path from 'node:path';
import { MAX_RULE_CHARS, type AuditConfig, type AuditRule } from './config.js';
import { isPathIncluded, matchesGlob } from './glob.js';
import { createFinding, severityFromString, type Finding } from '../services/findings.js';

export interface RuleEvalFile {
  file: string;
  content: string;
}

export interface RuleCompleterArgs {
  system: string;
  prompt: string;
  rule: AuditRule;
}

/** Injected model call. Must return raw model text (ideally a JSON array). */
export type RuleCompleter = (args: RuleCompleterArgs) => Promise<string>;

export interface RuleEvalOptions {
  /** Cap on total file content sent to the model (chars). */
  maxPromptChars?: number;
  /** Cap on a single file's content (chars). */
  maxFileChars?: number;
}

export interface RuleEvalResult {
  findings: Finding[];
  rulesEvaluated: string[];
  rulesSkipped: Array<{ rule: string; reason: string }>;
  errors: string[];
  /** Approximate characters of file content sent (for cost visibility). */
  promptChars: number;
}

const DEFAULT_MAX_PROMPT_CHARS = 120_000;
const DEFAULT_MAX_FILE_CHARS = 8_000;

/** Repo-relative, non-absolute, no-traversal path. */
function safeRel(p: string): boolean {
  const raw = String(p ?? '').trim();
  if (!raw) return false;
  if (/^([a-zA-Z]:[\\/]|[\\/])/.test(raw)) return false;
  return !raw.replace(/\\/g, '/').split('/').includes('..');
}

/** Rule text = description + linked file contents, capped at the shared budget. */
export function assembleRuleText(rule: AuditRule, rootDir: string): string {
  let text = rule.description;
  for (const rel of rule.filePaths) {
    if (!safeRel(rel)) continue;
    try {
      const abs = path.join(rootDir, rel);
      if (!fs.existsSync(abs)) continue;
      const body = fs.readFileSync(abs, 'utf-8');
      text += `\n\n# Linked rule file: ${rel}\n${body}`;
    } catch {
      /* unreadable linked file — skip it, keep the rule usable */
    }
    if (text.length >= MAX_RULE_CHARS) break;
  }
  return text.slice(0, MAX_RULE_CHARS);
}

/** Files a rule applies to after config filters + the rule's own globs. */
export function selectRuleFiles(rule: AuditRule, files: readonly RuleEvalFile[], config: AuditConfig): RuleEvalFile[] {
  return files.filter((f) => {
    if (!isPathIncluded(f.file, config.pathFilters.include, config.pathFilters.exclude)) return false;
    return isPathIncluded(f.file, rule.include, rule.exclude);
  });
}

/** Path instructions whose glob matches any of the given files. */
export function pathInstructionsFor(filePaths: readonly string[], config: AuditConfig): string[] {
  return config.pathInstructions
    .filter((pi) => filePaths.some((f) => matchesGlob(f, pi.path)))
    .map((pi) => `- [${pi.path}] ${pi.instructions}`);
}

function stripFences(text: string): string {
  const m = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  return (m ? m[1] : text).trim();
}

/** Shape-tolerant parse of a rule's JSON findings. Returns [] on any failure. */
export function parseRuleFindings(
  raw: string,
  rule: AuditRule,
): { findings: Array<{ file?: string; line?: number; endLine?: number; message: string; severity: string; remediation?: string; cwe?: string; cve?: string }>; error?: string } {
  const text = stripFences(raw);
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return { findings: [], error: 'no JSON array in model output' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch (err) {
    return { findings: [], error: `invalid JSON: ${(err as Error).message}` };
  }
  if (!Array.isArray(parsed)) return { findings: [], error: 'model output was not an array' };
  const findings = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const message = String(o.message ?? o.title ?? o.description ?? '').trim();
    if (!message) continue;
    findings.push({
      ...(typeof o.file === 'string' ? { file: o.file } : typeof o.path === 'string' ? { file: o.path } : {}),
      ...(typeof o.line === 'number' ? { line: o.line } : {}),
      ...(typeof o.endLine === 'number' ? { endLine: o.endLine } : typeof o.end_line === 'number' ? { endLine: o.end_line } : {}),
      message,
      severity: String(o.severity ?? rule.severity),
      ...(typeof o.remediation === 'string' ? { remediation: o.remediation } : typeof o.fix === 'string' ? { remediation: o.fix } : {}),
      ...(typeof o.cwe === 'string' ? { cwe: o.cwe } : {}),
      ...(typeof o.cve === 'string' ? { cve: o.cve } : {}),
    });
  }
  return { findings };
}

const RULE_SYSTEM = [
  'You are a precise code reviewer enforcing a single repository rule.',
  'Report ONLY concrete violations of the rule, with the exact file and line.',
  'Do not report style preferences the rule does not ask for. If there are no violations, return [].',
  'Respond with a JSON array of objects:',
  '{"file": "path", "line": number, "message": "what is wrong and why", "severity": "critical|high|medium|low|info", "remediation": "the specific fix", "cwe": "optional"}',
].join(' ');

/**
 * Evaluate every enabled rule against the supplied files. Rules with no
 * applicable file are skipped (not passed); model/parse failures are recorded
 * in `errors` and never abort the remaining rules.
 */
export async function evaluateRules(
  config: AuditConfig,
  files: readonly RuleEvalFile[],
  rootDir: string,
  complete: RuleCompleter,
  opts: RuleEvalOptions = {},
): Promise<RuleEvalResult> {
  const maxPromptChars = opts.maxPromptChars ?? DEFAULT_MAX_PROMPT_CHARS;
  const maxFileChars = opts.maxFileChars ?? DEFAULT_MAX_FILE_CHARS;
  const findings: Finding[] = [];
  const rulesEvaluated: string[] = [];
  const rulesSkipped: Array<{ rule: string; reason: string }> = [];
  const errors: string[] = [];
  let promptChars = 0;

  for (const rule of config.rules) {
    if (!rule.enabled) continue;
    const applicable = selectRuleFiles(rule, files, config);
    if (applicable.length === 0) {
      rulesSkipped.push({ rule: rule.name, reason: 'no files match the rule scope' });
      continue;
    }
    const ruleText = assembleRuleText(rule, rootDir);
    if (!ruleText.trim()) {
      rulesSkipped.push({ rule: rule.name, reason: 'rule has no text or linked files' });
      continue;
    }
    const pathNotes = pathInstructionsFor(applicable.map((f) => f.file), config);

    const budget = Math.max(0, maxPromptChars - ruleText.length - pathNotes.join('\n').length);
    let used = 0;
    const blocks: string[] = [];
    for (const f of applicable) {
      if (used >= budget) break;
      const body = f.content.slice(0, Math.min(maxFileChars, budget - used));
      used += body.length;
      blocks.push(`### ${f.file}\n${body}`);
    }

    const prompt = [
      `RULE: ${rule.name} (severity: ${rule.severity})`,
      ruleText,
      pathNotes.length ? `\nPATH-SPECIFIC GUIDANCE:\n${pathNotes.join('\n')}` : '',
      `\nFILES TO REVIEW:\n${blocks.join('\n\n')}`,
    ].filter(Boolean).join('\n');

    promptChars += prompt.length;
    let raw: string;
    try {
      raw = await complete({ system: RULE_SYSTEM, prompt, rule });
    } catch (err) {
      errors.push(`${rule.name}: model call failed: ${(err as Error).message}`);
      rulesSkipped.push({ rule: rule.name, reason: 'model call failed' });
      continue;
    }

    const parsed = parseRuleFindings(raw, rule);
    if (parsed.error) {
      errors.push(`${rule.name}: ${parsed.error}`);
      rulesSkipped.push({ rule: rule.name, reason: parsed.error });
      continue;
    }
    rulesEvaluated.push(rule.name);
    for (const hit of parsed.findings) {
      const sev = severityFromString(hit.severity);
      findings.push(createFinding({
        source: 'rules',
        dimension: 'maintainability',
        category: `rule:${rule.id}`,
        severity: sev,
        confidence: 0.7,
        determinism: 'llm',
        ...(hit.file ? { location: { file: hit.file, ...(hit.line !== undefined ? { line: hit.line } : {}), ...(hit.endLine !== undefined ? { endLine: hit.endLine } : {}) } } : {}),
        evidence: hit.message,
        remediation: hit.remediation ?? `Resolve this "${rule.name}" violation.`,
        ...(hit.cwe ? { cwe: hit.cwe } : {}),
        ...(hit.cve ? { cve: hit.cve } : {}),
      }));
    }
  }

  return { findings, rulesEvaluated, rulesSkipped, errors, promptChars };
}
