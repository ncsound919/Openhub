/**
 * Finding validator — deterministic, evidence-based confirmation before a
 * finding is trusted or acted on. This is the false-positive brake that makes
 * the difference between "a scanner dumped 2,000 rows" and an actionable
 * backlog: a finding whose location vanished is `stale`, a dependency CVE whose
 * package is never imported is `unreachable`, an injection sink with no tainted
 * source is `unconfirmed`, and only evidence-backed findings are `confirmed`.
 *
 * No LLM: every verdict is a reproducible check over file contents, so the
 * result is auditable and cannot hallucinate confidence.
 */
import { dedupKey, type Finding } from '../services/findings.js';

export type ValidationVerdict = 'confirmed' | 'unconfirmed' | 'stale' | 'not_applicable';
export type Reachability = 'reachable' | 'unreachable' | 'unknown';

export interface ValidationEvidence {
  kind:
    | 'file-exists'
    | 'line-in-range'
    | 'evidence-present'
    | 'secret-present'
    | 'placeholder'
    | 'import-present'
    | 'symbol-present'
    | 'sink-present'
    | 'source-present'
    | 'not-found';
  detail?: string;
}

export interface FindingValidation {
  fingerprint: string;
  verdict: ValidationVerdict;
  /** 0..1 — calibrated by which evidence was found, not by the model. */
  confidence: number;
  rationale: string;
  evidence: ValidationEvidence[];
  reachability?: Reachability;
  /** Estimated remediation effort, 1 (trivial) .. 10 (large refactor). */
  fixEffort: number;
}

export interface ValidationContext {
  /** Repo-relative path → full file content. */
  files: ReadonlyMap<string, string>;
  /** Direct dependency names (from package.json / requirements, etc.). */
  directDependencies?: ReadonlySet<string>;
  /** Optional package → symbols/APIs for finer CVE reachability. */
  packageSymbols?: ReadonlyMap<string, readonly string[]>;
}

// ── category classifiers ───────────────────────────────────────────────────

const SECRET_RE = /secret|credential|api[-_]?key|password|token/i;
const DEPENDENCY_RE = /cve|dependenc|vulnerab/i;
const INJECTION_RE = /inject|sqli|xss|eval|exec|command|traversal|ssrf|deserial|redirect/i;

const SINK_RE = /\b(eval|exec|execSync|execFile|spawn|query|raw|innerHTML|dangerouslySetInnerHTML|deserialize|Function|readFile|readFileSync)\s*\(/;
const SOURCE_RE = /\b(req|request|ctx|event)\s*\.\s*(body|query|params|headers)|process\.(argv|env)|\bwindow\.|\bdocument\.|location\.(search|hash)|getParameter|\binput\b/i;
const PLACEHOLDER_RE = /example|dummy|sample|placeholder|changeme|redacted|your[_-]|xxxx+|<[^>]+>|test[_-]?key/i;

const FIX_EFFORT_BY_CATEGORY: Array<[RegExp, number]> = [
  [/dependenc|cve|license|sbom/i, 2],
  [/secret|credential|api[-_]?key/i, 4],
  [/lint|style|format|naming/i, 1],
  [/duplicat|simplif|maintainab/i, 4],
  [/inject|sqli|xss|eval|exec|traversal|ssrf|deserial/i, 6],
  [/complex|architecture|refactor|coupling/i, 8],
  [/race|concurrency|deadlock|integrity/i, 8],
];

function fixEffortFor(f: Finding): number {
  const hay = `${f.category} ${f.dimension}`;
  for (const [re, effort] of FIX_EFFORT_BY_CATEGORY) if (re.test(hay)) return effort;
  return 3;
}

function packageOf(f: Finding): string | undefined {
  const m = /^cve[:\-](.+)$/i.exec(f.category);
  if (m) return m[1].trim();
  const ev = f.evidence ?? '';
  const m2 = /(?:^|\s)(@?[a-z0-9][\w@/.-]*)@\d/i.exec(ev);
  return m2 ? m2[1] : undefined;
}

function linesOf(content: string): string[] {
  return content.replace(/\r\n/g, '\n').split('\n');
}

function lineAt(content: string, line?: number): string {
  if (typeof line !== 'number' || line < 1) return '';
  return linesOf(content)[line - 1] ?? '';
}

/** Is `pkg` imported anywhere in the provided file set? */
function isImported(pkg: string, files: ReadonlyMap<string, string>): boolean {
  const esc = pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const fromRe = new RegExp(`(?:from|require\\s*\\(|import\\s*\\()\\s*['"]${esc}(?:/[^'"]*)?['"]`);
  for (const content of files.values()) {
    if (fromRe.test(content)) return true;
  }
  return false;
}

function packageSymbolPresent(symbols: readonly string[], files: ReadonlyMap<string, string>): string | null {
  for (const sym of symbols) {
    if (!sym) continue;
    const re = new RegExp(`\\b${sym.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    for (const content of files.values()) if (re.test(content)) return sym;
  }
  return null;
}

/** Validate one finding against the repo context. Deterministic. */
export function validateFinding(f: Finding, ctx: ValidationContext): FindingValidation {
  const base = { fingerprint: dedupKey(f), verdict: 'not_applicable' as ValidationVerdict, confidence: 0, rationale: '', evidence: [] as ValidationEvidence[], fixEffort: fixEffortFor(f) };
  const file = f.location?.file;
  const line = f.location?.line;
  const evidence: ValidationEvidence[] = [];

  if (!file) {
    return { ...base, rationale: 'no file location to verify', evidence: [{ kind: 'not-found', detail: 'finding has no location' }] };
  }
  const content = ctx.files.get(file);
  if (content === undefined) {
    return { ...base, verdict: 'stale', confidence: 0.2, rationale: `file not found in the current tree: ${file}`, evidence: [{ kind: 'not-found', detail: file }] };
  }
  evidence.push({ kind: 'file-exists', detail: file });
  const lines = linesOf(content);
  if (typeof line === 'number' && line > 0) {
    if (line > lines.length) {
      return { ...base, verdict: 'stale', confidence: 0.2, rationale: `line ${line} is past end of file (${lines.length} lines) — code moved`, evidence: [...evidence, { kind: 'not-found', detail: `line ${line} > ${lines.length}` }] };
    }
    evidence.push({ kind: 'line-in-range', detail: String(line) });
  }
  const lineText = lineAt(content, line);
  const evText = (f.evidence ?? '').trim();

  // ── secret: must still be present and not a placeholder ──
  if (SECRET_RE.test(f.category) || SECRET_RE.test(evText)) {
    const hay = lineText || content;
    if (lineText && lineText.trim()) {
      if (/['"]([A-Za-z0-9_\-./+=]{12,})['"]/.test(lineText) || evText && lineText.includes(evText.slice(0, 24))) {
        if (PLACEHOLDER_RE.test(lineText)) {
          return { ...base, verdict: 'unconfirmed', confidence: 0.3, rationale: 'the matched value looks like a placeholder/example', evidence: [...evidence, { kind: 'placeholder' }] };
        }
        return { ...base, verdict: 'confirmed', confidence: 0.9, rationale: 'credential-shaped value is present at the reported line', evidence: [...evidence, { kind: 'secret-present' }] };
      }
    }
    const stillPresent = evText.length > 3 && hay.includes(evText.slice(0, 24));
    if (stillPresent) return { ...base, verdict: 'confirmed', confidence: 0.8, rationale: 'secret evidence still present', evidence: [...evidence, { kind: 'secret-present' }] };
    return { ...base, verdict: 'stale', confidence: 0.25, rationale: 'secret no longer present at the reported location', evidence: [...evidence, { kind: 'not-found' }] };
  }

  // ── dependency / CVE: reachability ──
  if (DEPENDENCY_RE.test(f.category) || f.cve) {
    const pkg = packageOf(f) ?? f.cve;
    if (!pkg) {
      return { ...base, verdict: 'not_applicable', confidence: 0, rationale: 'no package name to trace', evidence, reachability: 'unknown' };
    }
    const symbols = ctx.packageSymbols?.get(pkg) ?? [];
    const sym = symbols.length ? packageSymbolPresent(symbols, ctx.files) : null;
    if (sym) {
      return { ...base, verdict: 'confirmed', confidence: 0.9, rationale: `vulnerable symbol "${sym}" from ${pkg} is referenced`, evidence: [...evidence, { kind: 'symbol-present', detail: sym }], reachability: 'reachable' };
    }
    if (isImported(pkg, ctx.files)) {
      return { ...base, verdict: 'confirmed', confidence: 0.7, rationale: `${pkg} is imported and may be reachable`, evidence: [...evidence, { kind: 'import-present', detail: pkg }], reachability: 'reachable' };
    }
    if (ctx.directDependencies?.has(pkg)) {
      return { ...base, verdict: 'unconfirmed', confidence: 0.4, rationale: `${pkg} is a direct dependency but is not imported — verify reachability`, evidence: [...evidence, { kind: 'not-found', detail: 'no import' }], reachability: 'unknown' };
    }
    return { ...base, verdict: 'unconfirmed', confidence: 0.3, rationale: `no usage of ${pkg} found in the tree — likely unreachable`, evidence: [...evidence, { kind: 'not-found', detail: pkg }], reachability: 'unreachable' };
  }

  // ── injection/taint: sink + source heuristic ──
  if (INJECTION_RE.test(f.category)) {
    const region = lineText || content;
    const sink = SINK_RE.test(region) || (SINK_RE.test(content) && evText && content.includes(evText.slice(0, 20)));
    const source = SOURCE_RE.test(content);
    if (sink && source) {
      return { ...base, verdict: 'confirmed', confidence: 0.75, rationale: 'a dangerous sink and a plausible tainted source co-occur in this file', evidence: [...evidence, { kind: 'sink-present' }, { kind: 'source-present' }], reachability: 'reachable' };
    }
    if (sink && !source) {
      return { ...base, verdict: 'unconfirmed', confidence: 0.45, rationale: 'a dangerous sink exists but no tainted source was found in this file', evidence: [...evidence, { kind: 'sink-present' }], reachability: 'unknown' };
    }
    return { ...base, verdict: 'unconfirmed', confidence: 0.35, rationale: 'reported sink not found at the location', evidence: [...evidence, { kind: 'not-found' }], reachability: 'unknown' };
  }

  // ── generic code finding: location + evidence presence ──
  if (evText && evText.length > 3 && (lineText.includes(evText.slice(0, 24)) || content.includes(evText.slice(0, 24)))) {
    return { ...base, verdict: 'confirmed', confidence: 0.85, rationale: 'reported evidence is present at/near the location', evidence: [...evidence, { kind: 'evidence-present' }] };
  }
  return { ...base, verdict: 'confirmed', confidence: 0.6, rationale: 'location is valid (file and line exist)', evidence };
}

export interface ValidationApplyOptions {
  /** Drop `stale` findings (default true). */
  dropStale?: boolean;
  /** Drop `unconfirmed` findings (default false — kept, just downgraded). */
  dropUnconfirmed?: boolean;
  /** Drop `not_applicable` findings (default false). */
  dropNotApplicable?: boolean;
}

export interface ValidationApplyResult {
  kept: Finding[];
  dropped: Array<{ finding: Finding; validation: FindingValidation }>;
  validations: Map<string, FindingValidation>;
}

/** Validate a batch and optionally prune. Confidence is NOT rewritten here. */
export function validateFindings(
  findings: readonly Finding[],
  ctx: ValidationContext,
  opts: ValidationApplyOptions = {},
): ValidationApplyResult {
  const dropStale = opts.dropStale !== false;
  const kept: Finding[] = [];
  const dropped: ValidationApplyResult['dropped'] = [];
  const validations = new Map<string, FindingValidation>();
  for (const finding of findings) {
    const v = validateFinding(finding, ctx);
    validations.set(v.fingerprint || keyOf(finding), v);
    const drop = (v.verdict === 'stale' && dropStale)
      || (v.verdict === 'unconfirmed' && opts.dropUnconfirmed === true)
      || (v.verdict === 'not_applicable' && opts.dropNotApplicable === true);
    if (drop) dropped.push({ finding, validation: v });
    else kept.push(finding);
  }
  return { kept, dropped, validations };
}

function keyOf(f: Finding): string {
  return `${f.source}|${f.category}|${f.location?.file ?? ''}|${f.location?.line ?? ''}`;
}
