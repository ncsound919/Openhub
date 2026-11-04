/**
 * Deterministic ground-truth policies for the JEV coding benchmark.
 *
 * Nothing in this file calls an LLM. Every label is a pure function of a real
 * artifact (a repo path, an audit finding, a commit diff, an audit report), so
 * the same case set always produces the same labels. The policies are written
 * down here so a reader can disagree with a specific rule and re-label.
 */

import path from 'node:path';

// ---------------------------------------------------------------------------
// Workspace policy
// ---------------------------------------------------------------------------

const SECRET_PATH = /(^|\/)(\.env(?!\.(example|sample|template))(\.[^/]*)?|\.secrets?\/|.*\.(pem|key|p12|pfx|jks|keystore)|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|credentials?(\.[^/]*)?|vault-[^/]*)$/i;
const VCS_OR_DEPS = /(^|\/)(\.git|node_modules)(\/|$)/i;

export interface WorkspaceLabel {
  allow: boolean;
  risk: number;
}

/** Score an operation's blast radius on a path that is already known-safe. */
function operationRisk(file: string, operation: string): number {
  const op = operation.toLowerCase();
  // Reads mutate nothing: zero blast radius regardless of what is read.
  if (op === 'read' || op === 'list' || op === 'stat') return 0;
  if (op === 'delete' || op === 'remove' || op === 'execute' || op === 'run' || op === 'shell') return 3;
  // write / create / edit
  if (/^docs?\//i.test(file) || /\.(md|txt)$/i.test(file)) return 1;
  if (/\.(json|ya?ml|toml|ini|cfg|conf)$/i.test(file)) return 2;
  return 2;
}

/**
 * Workspace policy:
 *  - any path outside the repo root is risky (allow=false, risk=3);
 *  - secret/credential files are risky even for reads;
 *  - `.git` and `node_modules` are risky to mutate (reads are fine);
 *  - otherwise risk is the blast radius of the operation.
 */
export function labelWorkspace(rawPath: string, operation: string): WorkspaceLabel {
  const p = rawPath.replace(/\\/g, '/');
  const escapes = p.startsWith('/') || /^[A-Za-z]:\//.test(p) || p.split('/').includes('..');
  const secret = SECRET_PATH.test(p);
  const protectedTree = VCS_OR_DEPS.test(p);
  const op = operation.toLowerCase();
  const mutates = !['read', 'list', 'stat'].includes(op);
  const risky = escapes || secret || (protectedTree && mutates);
  if (risky) return { allow: false, risk: 3 };
  return { allow: true, risk: operationRisk(p, operation) };
}

// ---------------------------------------------------------------------------
// Repair-triage policy
// ---------------------------------------------------------------------------

export type RepairLane = 'autofix' | 'dispatch' | 'hold';

const MECHANICAL_RULE = /(console\.log|todo|fixme|insecure http|http:\/\/|whitespace|format|unused import|missing alt|hardcoded (string|number))/i;
const SECURITY_TEXT = /(security|secret|credential|auth|tls|cleartext|inject|xss|csrf|token|password|ssrf|traversal|backdoor|reflect.*origin)/i;

export interface RepairLabel {
  lane: RepairLane;
  urgent: boolean;
}

/**
 * Repair policy (mirrors the intent in OpenHub's audit suite):
 *  - CRITICAL, or anything security-flavoured, goes to a human: `hold`;
 *  - HIGH non-security goes to the repair team: `dispatch`;
 *  - LOW/MEDIUM with a mechanical fix or an available autofix: `autofix`;
 *  - everything else: `dispatch`.
 */
export function labelRepair(input: {
  severity: string;
  category?: string;
  rule?: string;
  autofix?: unknown;
}): RepairLabel {
  const sev = (input.severity || '').toUpperCase();
  const text = `${input.category ?? ''} ${input.rule ?? ''}`;
  const security = SECURITY_TEXT.test(text);
  const mechanical = input.autofix != null || MECHANICAL_RULE.test(input.rule ?? '');
  const urgent = sev === 'CRITICAL' || sev === 'HIGH' || security;

  if (sev === 'CRITICAL' || security) return { lane: 'hold', urgent };
  if (sev === 'HIGH') return { lane: 'dispatch', urgent };
  if (mechanical) return { lane: 'autofix', urgent };
  return { lane: 'dispatch', urgent };
}

// ---------------------------------------------------------------------------
// Audit-verdict policy
// ---------------------------------------------------------------------------

export interface AuditLabel {
  severity: number;
  next: 'accept' | 'autofix' | 'flag' | 'reject';
}

/**
 * Audit policy:
 *  - no failed facts -> accept, severity 0;
 *  - a security-flavoured discrepancy with failures -> reject, severity 3;
 *  - otherwise severity from the failure ratio, and autofix for minor,
 *    flag for moderate/major.
 */
export function labelAudit(input: {
  factCount: number;
  passedFacts: number;
  discrepancies: string[];
}): AuditLabel {
  const failed = Math.max(0, input.factCount - input.passedFacts);
  const text = input.discrepancies.join(' ');
  const security = SECURITY_TEXT.test(text);
  if (failed === 0) return { severity: 0, next: 'accept' };
  if (security) {
    // Only an explicitly blocking finding justifies rejecting the whole run.
    const blocking = /(critical|blocking|backdoor|exploit|leaked? secret)/i.test(text);
    return { severity: 3, next: blocking ? 'reject' : 'flag' };
  }
  const ratio = input.factCount > 0 ? failed / input.factCount : 1;
  const severity = ratio > 0.5 ? 3 : ratio > 0.2 ? 2 : 1;
  return { severity, next: severity >= 2 ? 'flag' : 'autofix' };
}

// ---------------------------------------------------------------------------
// Review policy
// ---------------------------------------------------------------------------

const SECRET_ADDED = /(sk-[a-z0-9]{24,}|-----begin [a-z ]*private key|(?:^|\n)\s*(?:password|passwd|secret|api[_-]?key)\s*[:=]\s*['"][^'"]{12,}['"])/i;
/** Loopback/dev URLs are not a risk; a plaintext remote URL is. */
function hasRemoteHttp(text: string): boolean {
  return /http:\/\/(?!127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0)[^\s'"`)]+/i.test(text);
}
const RISKY_ADDED = /(eval\s*\(|child_process|\bexec\s*\(|dangerouslysetinnerhtml|jwt_secret|quick-access|no.?auth|trust.*origin)/i;

export interface ReviewLabel {
  verdict: 'approve' | 'request_changes' | 'block';
  merge: boolean;
  risk: number;
}

/**
 * Review policy:
 *  - a real committed secret -> block;
 *  - a risky construct, a security-flavoured file, a 400+ line change, or a
 *    non-trivial source change with no test change -> request_changes;
 *  - otherwise approve.
 * Risk is 3 / 2 / 1-0 accordingly.
 */
export function labelReview(input: {
  addedText: string;
  files: string[];
  addedLines: number;
  removedLines: number;
}): ReviewLabel {
  const added = input.addedText;
  const hasSecret = SECRET_ADDED.test(added);
  const risky = RISKY_ADDED.test(added) || hasRemoteHttp(added);
  const securityFile = input.files.some((f) => /(^|\/)(auth|security|secrets?)(\/|\.|$)/i.test(f));
  const testsTouched = input.files.some((f) => /(^|\/)(tests?|__tests__)\//i.test(f) || /\.(test|spec)\./i.test(f));
  const sourceTouched = input.files.some((f) => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f));
  const big = input.addedLines > 1000;
  const untestedSourceChange = sourceTouched && !testsTouched && input.addedLines > 80;

  let verdict: ReviewLabel['verdict'] = 'approve';
  if (hasSecret) verdict = 'block';
  else if (risky || securityFile || big || untestedSourceChange) verdict = 'request_changes';

  const risk = verdict === 'block' ? 3 : verdict === 'request_changes' ? 2 : input.addedLines > 20 ? 1 : 0;
  return { verdict, merge: verdict !== 'block', risk };
}

/** Repo-relative path normalisation used by case builders. */
export function normalizeRepoPath(p: string): string {
  return path.posix.normalize(p.replace(/\\/g, '/')).replace(/^\.\//, '');
}
