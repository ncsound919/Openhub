/**
 * Autofix — turns a finding into a concrete, reviewable patch instead of prose.
 *
 * Two paths:
 *  - deterministic: a dependency bump produces the patch directly (no model);
 *  - generative: an injected model returns the corrected file (or a patch),
 *    and we compute a real unified diff so callers get an apply-able artifact.
 *
 * The model call is injected (`FixGenerator`) so this is provider-agnostic and
 * unit-testable. Patches are size-bounded and carry a confidence level; a fix
 * that cannot be produced is reported as skipped, never fabricated.
 */
import { dedupKey, type Finding } from '../services/findings.js';

export type FixConfidence = 'high' | 'medium' | 'low';

export interface CodeSuggestion {
  /** Cross-tool fingerprint of the finding this fixes. */
  fingerprint: string;
  file: string;
  /** Unified diff (`--- a/…`, `+++ b/…`, `@@ … @@`). */
  patch: string;
  confidence: FixConfidence;
  rationale?: string;
  provider?: string;
}

export interface FixModelResponse {
  /** Corrected full file content; the diff is computed from it. */
  newContent?: string;
  /** Or a ready-made unified diff. */
  patch?: string;
  confidence?: string;
  rationale?: string;
}

export interface FixGeneratorArgs {
  finding: Finding;
  file: string;
  content: string;
  system: string;
  prompt: string;
}

export type FixGenerator = (args: FixGeneratorArgs) => Promise<FixModelResponse | string | null>;

const DEFAULT_MAX_PATCH_CHARS = 40_000;

function lines(text: string): string[] {
  return text.replace(/\r\n/g, '\n').split('\n');
}

/**
 * Build a single-hunk unified diff from the longest common prefix/suffix. Valid
 * for any change and cheap on large files (no O(n·m) LCS).
 */
export function buildUnifiedDiff(oldText: string, newText: string, file: string, context = 3): string {
  if (oldText === newText) return '';
  const a = lines(oldText);
  const b = lines(newText);
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix += 1;

  const ctxStart = Math.max(0, prefix - context);
  const before = a.slice(ctxStart, prefix);
  const removed = a.slice(prefix, a.length - suffix);
  const added = b.slice(prefix, b.length - suffix);
  const after = a.slice(a.length - suffix, Math.min(a.length, a.length - suffix + context));

  const start = ctxStart + 1;
  const oldLen = before.length + removed.length + after.length;
  const newLen = before.length + added.length + after.length;
  const body = [
    ...before.map((l) => ` ${l}`),
    ...removed.map((l) => `-${l}`),
    ...added.map((l) => `+${l}`),
    ...after.map((l) => ` ${l}`),
  ];
  return [`--- a/${file}`, `+++ b/${file}`, `@@ -${start},${oldLen} +${start},${newLen} @@`, ...body, ''].join('\n');
}

const DEP_SECTIONS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const;

export interface DependencyUpgrade {
  newContent: string;
  section: string;
  from: string;
  to: string;
}

/**
 * Deterministic dependency upgrade for a JSON manifest (package.json). Preserves
 * the range prefix (`^`/`~`); returns null when the package is absent or
 * already satisfied. No model involved.
 */
export function suggestDependencyUpgrade(manifestText: string, pkg: string, targetVersion: string): DependencyUpgrade | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(manifestText) as Record<string, unknown>;
  } catch {
    return null;
  }
  for (const section of DEP_SECTIONS) {
    const deps = parsed[section];
    if (!deps || typeof deps !== 'object') continue;
    const table = deps as Record<string, string>;
    const current = table[pkg];
    if (typeof current !== 'string') continue;
    const prefix = /^[\^~>=<\s]*/.exec(current)?.[0] ?? '';
    const next = `${prefix}${targetVersion}`;
    if (next === current) return null;
    table[pkg] = next;
    return { newContent: `${JSON.stringify(parsed, null, 2)}\n`, section, from: current, to: next };
  }
  return null;
}

function stripFences(text: string): string {
  const m = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  return (m ? m[1] : text).trim();
}

/** Tolerant parse of a model fix response (JSON object, or a raw diff string). */
export function parseFixResponse(raw: string | FixModelResponse | null): FixModelResponse | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'object') return raw;
  const text = stripFences(String(raw));
  if (!text) return null;
  try {
    const obj = JSON.parse(text) as Record<string, unknown>;
    if (obj && typeof obj === 'object') {
      return {
        ...(typeof obj.newContent === 'string' ? { newContent: obj.newContent } : typeof obj.new_content === 'string' ? { newContent: obj.new_content } : {}),
        ...(typeof obj.patch === 'string' ? { patch: obj.patch } : {}),
        ...(typeof obj.confidence === 'string' ? { confidence: obj.confidence } : {}),
        ...(typeof obj.rationale === 'string' ? { rationale: obj.rationale } : {}),
      };
    }
  } catch {
    /* not JSON — maybe a raw diff */
  }
  if (/^---\s|^@@\s/m.test(text)) return { patch: text };
  return null;
}

function confidenceOf(v?: string): FixConfidence {
  const s = String(v ?? '').toLowerCase();
  return s === 'high' || s === 'medium' || s === 'low' ? s : 'medium';
}

export const FIX_SYSTEM = [
  'You are a precise code-fix engine. Fix ONLY the reported issue.',
  'Keep the change minimal and behavior-preserving. Do not reformat unrelated code.',
  'Return JSON: {"newContent": "<the complete corrected file>", "confidence": "high|medium|low", "rationale": "<what changed and why>"}.',
  'If you cannot produce a safe, minimal fix, return {"newContent": null}.',
].join(' ');

export interface GenerateAutofixOptions {
  fileContent: string;
  generate: FixGenerator;
  finding: Finding;
  maxPatchChars?: number;
  provider?: string;
}

/** Produce one patch for one finding, or null when no safe fix was produced. */
export async function generateAutofix(opts: GenerateAutofixOptions): Promise<CodeSuggestion | null> {
  const { finding, fileContent, generate } = opts;
  const file = finding.location?.file;
  if (!file) return null;
  const maxPatchChars = opts.maxPatchChars ?? DEFAULT_MAX_PATCH_CHARS;

  const prompt = [
    `FILE: ${file}`,
    `FINDING (${finding.severity}, ${finding.category}): ${finding.evidence ?? ''}`,
    finding.remediation ? `SUGGESTED REMEDIATION: ${finding.remediation}` : '',
    typeof finding.location?.line === 'number' ? `LINE: ${finding.location.line}` : '',
    finding.cwe ? `CWE: ${finding.cwe}` : '',
    '',
    'CURRENT FILE CONTENT:',
    fileContent,
  ].filter(Boolean).join('\n');

  // Let a generator failure propagate so batch callers can record it honestly.
  const response = parseFixResponse(await generate({ finding, file, content: fileContent, system: FIX_SYSTEM, prompt }));
  if (!response) return null;

  let patch = response.patch?.trim() ?? '';
  if (!patch && typeof response.newContent === 'string' && response.newContent !== fileContent) {
    patch = buildUnifiedDiff(fileContent, response.newContent, file);
  }
  if (!patch) return null;
  if (patch.length > maxPatchChars) return null;

  return {
    fingerprint: dedupKey(finding),
    file,
    patch,
    confidence: confidenceOf(response.confidence),
    ...(response.rationale ? { rationale: response.rationale } : {}),
    ...(opts.provider ? { provider: opts.provider } : {}),
  };
}

export interface GenerateAutofixesOptions {
  readFile: (file: string) => string | null;
  generate: FixGenerator;
  maxPatchChars?: number;
  provider?: string;
  /** Findings whose category matches are skipped (e.g. advisory-only). */
  skipCategory?: RegExp;
}

export interface GenerateAutofixesResult {
  suggestions: CodeSuggestion[];
  skipped: Array<{ finding: Finding; reason: string }>;
  errors: string[];
}

/** Batch autofix: per-finding failures are recorded, never thrown. */
export async function generateAutofixes(
  findings: readonly Finding[],
  opts: GenerateAutofixesOptions,
): Promise<GenerateAutofixesResult> {
  const suggestions: CodeSuggestion[] = [];
  const skipped: GenerateAutofixesResult['skipped'] = [];
  const errors: string[] = [];
  for (const finding of findings) {
    const file = finding.location?.file;
    if (!file) {
      skipped.push({ finding, reason: 'finding has no file location' });
      continue;
    }
    if (opts.skipCategory?.test(finding.category)) {
      skipped.push({ finding, reason: 'category is not auto-fixable' });
      continue;
    }
    const content = opts.readFile(file);
    if (content === null) {
      skipped.push({ finding, reason: `file not readable: ${file}` });
      continue;
    }
    try {
      const suggestion = await generateAutofix({
        finding,
        fileContent: content,
        generate: opts.generate,
        ...(opts.maxPatchChars !== undefined ? { maxPatchChars: opts.maxPatchChars } : {}),
        ...(opts.provider ? { provider: opts.provider } : {}),
      });
      if (suggestion) suggestions.push(suggestion);
      else skipped.push({ finding, reason: 'no safe fix produced' });
    } catch (err) {
      errors.push(`${file}: ${(err as Error).message}`);
    }
  }
  return { suggestions, skipped, errors };
}
