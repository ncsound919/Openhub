/**
 * Evidence attestations (in-toto / SLSA-aligned).
 *
 * An audit report is a claim. An attestation makes that claim *checkable* and
 * portable: an in-toto Statement binds a predicate (what was audited, what the
 * verdict was, which executed commands back it) to a subject (the audited tree)
 * by digest. A Verification Summary Attestation (VSA) records the result of
 * verifying it, so downstream consumers can trust a prior check without redoing
 * it.
 *
 * This is deliberately the *shape* of in-toto/SLSA, not a full Sigstore
 * integration: statements are unsigned by default (the receipt chain already
 * gives tamper-evidence) and DSSE envelopes can be layered on later without
 * changing consumers, because the predicate is self-describing.
 *
 * Fail-closed rule: verification fails if the evidence is missing. Signatures
 * prove a file was not tampered with; they can never prove a file arrived.
 */
import { createHash } from 'node:crypto';
import { signatureForDir } from './auditRuntime.js';
import type { AuditReport } from './auditSuite.js';
import { verifyReceipt, type Receipt } from './receipts.js';

export const IN_TOTO_STATEMENT_TYPE = 'https://in-toto.io/Statement/v1';
export const AUDIT_PREDICATE_TYPE = 'https://openhub.dev/audit/v1';
export const VSA_PREDICATE_TYPE = 'https://slsa.dev/verification_summary/v1';

export interface InTotoSubject {
  name: string;
  digest: Record<string, string>;
}

export interface InTotoStatement<P = any> {
  _type: typeof IN_TOTO_STATEMENT_TYPE;
  subject: InTotoSubject[];
  predicateType: string;
  predicate: P;
}

export interface AuditPredicate {
  builder: { id: string };
  auditId: string;
  timestamp: string;
  scope: 'full' | 'diff';
  grade: string;
  overallScore: number | null;
  overallScoreDeterministic: number | null;
  coveragePercent: number;
  gate: { stage?: string; passed: boolean; reason: string } | null;
  findings: { total: number; bySeverity: Record<string, number> };
  evidence: {
    receiptRunId: string;
    receiptCount: number;
    receiptHead: string;
  };
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sorted((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** Deterministic JSON (sorted keys) so a digest is stable across runs. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sorted(value));
}

export function digestOf(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/** Best-effort content-addressed subject for the audited tree. */
export function subjectForReport(report: AuditReport): InTotoSubject {
  const local = isLocalDir(report.target);
  const digest = local
    ? signatureForDir(report.target)
    : createHash('sha256').update(report.target).digest('hex').slice(0, 16);
  return { name: report.target, digest: { sha256: digest } };
}

function isLocalDir(target: string): boolean {
  return !/^[a-z]+:\/\//i.test(target);
}

function bySeverity(report: AuditReport): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of report.findings) out[f.severity] = (out[f.severity] ?? 0) + 1;
  return out;
}

/** Build the in-toto Statement for an audit report. */
export function buildAuditStatement(report: AuditReport, receipts: readonly Receipt[]): InTotoStatement<AuditPredicate> {
  return {
    _type: IN_TOTO_STATEMENT_TYPE,
    subject: [subjectForReport(report)],
    predicateType: AUDIT_PREDICATE_TYPE,
    predicate: {
      builder: { id: 'openhub' },
      auditId: report.id,
      timestamp: report.timestamp,
      scope: report.scope?.mode ?? 'full',
      grade: report.grade,
      overallScore: report.overallScore,
      overallScoreDeterministic: report.overallScoreDeterministic,
      coveragePercent: report.coveragePercent,
      gate: report.gate
        ? { stage: report.gate.stage, passed: report.gate.pass, reason: report.gate.reason }
        : null,
      findings: { total: report.findings.length, bySeverity: bySeverity(report) },
      evidence: {
        receiptRunId: report.receiptRunId ?? report.id,
        receiptCount: receipts.length,
        receiptHead: receipts.length ? receipts[receipts.length - 1].chainHash : '',
      },
    },
  };
}

export interface VerificationSummary {
  _type: typeof IN_TOTO_STATEMENT_TYPE;
  subject: InTotoSubject[];
  predicateType: typeof VSA_PREDICATE_TYPE;
  predicate: {
    verifier: { id: string };
    timeVerified: string;
    resourceUri: string;
    policy: { uri: string };
    verificationResult: 'PASSED' | 'FAILED';
    verifiedLevels: string[];
    inputAttestations: Array<{ uri: string; digest: { sha256: string } }>;
  };
}

/** Summarize the outcome of verifying an audit against its evidence. */
export function buildVerificationSummary(report: AuditReport, receipts: readonly Receipt[]): VerificationSummary {
  const statement = buildAuditStatement(report, receipts);
  const result = verifyAttestation({ statement, receipts });
  return {
    _type: IN_TOTO_STATEMENT_TYPE,
    subject: statement.subject,
    predicateType: VSA_PREDICATE_TYPE,
    predicate: {
      verifier: { id: 'openhub' },
      timeVerified: new Date().toISOString(),
      resourceUri: report.target,
      policy: { uri: AUDIT_PREDICATE_TYPE },
      verificationResult: result.valid ? 'PASSED' : 'FAILED',
      verifiedLevels: result.valid
        ? ['OPENHUB_AUDIT_VERIFIED', ...(report.gate?.pass ? [`GATE_PASSED:${report.gate.stage || 'default'}`] : [])]
        : [],
      inputAttestations: [{ uri: `audit:${report.id}`, digest: { sha256: digestOf(statement) } }],
    },
  };
}

export interface AttestationVerification {
  valid: boolean;
  checks: Array<{ name: string; ok: boolean; detail: string }>;
}

/**
 * Verify an attestation against its evidence. Fails closed: absent receipts are
 * a gap, not a pass.
 */
export function verifyAttestation(input: {
  statement: InTotoStatement<any>;
  receipts: readonly Receipt[];
}): AttestationVerification {
  const { statement, receipts } = input;
  const checks: AttestationVerification['checks'] = [];

  const subjectDigest = statement.subject?.[0]?.digest?.sha256 ?? '';
  checks.push({
    name: 'subject-digest-present',
    ok: subjectDigest.length > 0,
    detail: subjectDigest ? `subject digest ${subjectDigest}` : 'no subject digest',
  });

  checks.push({
    name: 'predicate-type',
    ok: statement.predicateType === AUDIT_PREDICATE_TYPE,
    detail: statement.predicateType,
  });

  checks.push({
    name: 'evidence-present',
    ok: receipts.length > 0,
    detail: receipts.length > 0 ? `${receipts.length} receipt(s)` : 'no executed-command receipts (fail closed)',
  });

  const pred = statement.predicate as Partial<AuditPredicate>;
  const runMatches = receipts.every((r) => !pred.evidence?.receiptRunId || r.runId === pred.evidence.receiptRunId);
  checks.push({
    name: 'receipts-belong-to-run',
    ok: receipts.length > 0 && runMatches,
    detail: runMatches ? 'all receipts tagged to the attested run' : 'receipt run mismatch',
  });

  const integrityOk = receipts.length > 0 && receipts.every((r) => verifyReceipt(r).valid);
  checks.push({
    name: 'receipts-integrity-valid',
    ok: receipts.length > 0 && integrityOk,
    detail: receipts.length === 0 ? 'no receipts to verify' : integrityOk ? 'all receipt digests match' : 'tampered receipt detected',
  });

  return { valid: checks.every((c) => c.ok), checks };
}
