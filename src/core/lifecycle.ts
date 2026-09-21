/**
 * Finding lifecycle — persistent status across audits so results behave like a
 * managed backlog instead of a fresh dump every run.
 *
 * A finding is fingerprinted with the cross-tool `dedupKey`, so the same issue
 * seen by any analyzer resolves/reopens as one record. Statuses mirror Aikido /
 * cubic: operator decisions (`false_positive`, `wontfix`, `intended`,
 * `accepted_risk`) suppress a finding without deleting it; `resolved` is the
 * automatic outcome when a finding no longer appears and reopens if it returns.
 */
import { dedupKey, severityRank, type Finding, type Severity } from '../services/findings.js';

export type FindingStatus =
  | 'open'
  | 'in_review'
  | 'resolved'
  | 'false_positive'
  | 'wontfix'
  | 'intended'
  | 'accepted_risk';

/** How a finding moved between the previous audit and this one. */
export type FindingTransition = 'new' | 'persisting' | 'resolved' | 'reopened' | 'unchanged';

export interface LifecycleRecord {
  fingerprint: string;
  source: string;
  category: string;
  dimension: string;
  severity: Severity;
  file?: string;
  line?: number;
  status: FindingStatus;
  firstSeen: string;
  lastSeen: string;
  seenCount: number;
  resolvedAt?: string;
  /** Why it resolved: `fixed` (auto) or an operator note. */
  resolution?: string;
  note?: string;
}

/** Statuses in which a finding is hidden from the active backlog/gate. */
const SUPPRESSED: ReadonlySet<FindingStatus> = new Set([
  'false_positive',
  'wontfix',
  'intended',
  'accepted_risk',
]);

export function isSuppressed(status: FindingStatus): boolean {
  return SUPPRESSED.has(status);
}

function fingerprint(f: Finding): string {
  return dedupKey(f);
}

/** Build a fresh record for a finding first seen now. */
export function newLifecycleRecord(f: Finding, now: string): LifecycleRecord {
  return {
    fingerprint: fingerprint(f),
    source: f.source,
    category: f.category,
    dimension: f.dimension,
    severity: f.severity,
    ...(f.location?.file ? { file: f.location.file } : {}),
    ...(typeof f.location?.line === 'number' ? { line: f.location.line } : {}),
    status: 'open',
    firstSeen: now,
    lastSeen: now,
    seenCount: 1,
  };
}

export interface LifecycleResult {
  /** Every record after reconciliation (current + auto-resolved history). */
  records: LifecycleRecord[];
  byFingerprint: Map<string, LifecycleRecord>;
  /** Transition for each finding present in this run. */
  transitions: Map<string, FindingTransition>;
  /** Findings to report (not suppressed), each with its post-run status. */
  active: Array<{ finding: Finding; record: LifecycleRecord; transition: FindingTransition }>;
  /** Findings hidden by an operator decision, kept for audit. */
  suppressed: Array<{ finding: Finding; record: LifecycleRecord }>;
  /** Records auto-resolved this run. */
  resolvedNow: LifecycleRecord[];
}

/**
 * Reconcile the previous lifecycle records against this run's findings.
 * Deterministic and side-effect free; callers persist the returned records.
 */
export function reconcileLifecycle(
  previous: readonly LifecycleRecord[],
  current: readonly Finding[],
  now: string = new Date().toISOString(),
): LifecycleResult {
  const prevByKey = new Map(previous.map((r) => [r.fingerprint, r]));
  const records: LifecycleRecord[] = [];
  const transitions = new Map<string, FindingTransition>();
  const active: LifecycleResult['active'] = [];
  const suppressed: LifecycleResult['suppressed'] = [];
  const seen = new Set<string>();

  for (const finding of current) {
    const key = fingerprint(finding);
    if (seen.has(key)) {
      // Duplicate within the same run — dedupe, keep the first.
      continue;
    }
    seen.add(key);
    const prev = prevByKey.get(key);
    let record: LifecycleRecord;
    let transition: FindingTransition;

    if (prev) {
      if (prev.status === 'resolved') {
        transition = 'reopened';
        record = { ...prev, status: 'open', lastSeen: now, seenCount: prev.seenCount + 1 };
        delete record.resolvedAt;
        delete record.resolution;
      } else if (isSuppressed(prev.status)) {
        transition = 'unchanged';
        record = { ...prev, lastSeen: now, seenCount: prev.seenCount + 1 };
      } else {
        transition = 'persisting';
        record = { ...prev, lastSeen: now, seenCount: prev.seenCount + 1 };
      }
      // Refresh mutable descriptors in case the analyzer refined them.
      record = { ...record, severity: finding.severity, source: finding.source, category: finding.category, dimension: finding.dimension };
    } else {
      transition = 'new';
      record = newLifecycleRecord(finding, now);
    }

    records.push(record);
    transitions.set(key, transition);
    if (isSuppressed(record.status)) suppressed.push({ finding, record });
    else active.push({ finding, record, transition });
  }

  // Previous open findings that did not reappear are auto-resolved.
  const resolvedNow: LifecycleRecord[] = [];
  for (const prev of previous) {
    if (seen.has(prev.fingerprint)) continue;
    if (prev.status === 'open' || prev.status === 'in_review') {
      const resolved: LifecycleRecord = { ...prev, status: 'resolved', resolvedAt: now, resolution: 'fixed' };
      records.push(resolved);
      transitions.set(prev.fingerprint, 'resolved');
      resolvedNow.push(resolved);
    } else {
      records.push(prev);
    }
  }

  return {
    records,
    byFingerprint: new Map(records.map((r) => [r.fingerprint, r])),
    transitions,
    active,
    suppressed,
    resolvedNow,
  };
}

export interface GateResult {
  passed: boolean;
  /** False when the gate did not actually evaluate findings (diff cap, an
   *  always-pass policy, or an ignored label). `passed` is then not a verdict
   *  on the diff. */
  evaluated: boolean;
  /** Findings at or above the threshold that fail the gate. */
  failing: Array<{ finding: Finding; record: LifecycleRecord; transition: FindingTransition }>;
  /** Every finding considered by the gate this run. */
  considered: number;
  reason: string;
}

export interface GateOptions {
  /** Fail only on findings new in this diff (default true). */
  newOnly?: boolean;
  /** Number of changed lines, for the max_changed_lines cap. */
  changedLines?: number;
  /** PR labels, for ignore_labels. */
  labels?: readonly string[];
}

export interface AuditGateInput {
  threshold: Severity;
  alwaysPass: boolean;
  drafts: boolean;
  maxChangedLines: number | null;
  ignoreLabels: readonly string[];
}

/**
 * Decide whether the PR/release gate passes. Operator-suppressed findings never
 * count; by default only findings new in this diff can fail the gate, so an
 * existing backlog does not block every PR.
 */
export function gateDecision(
  reconciled: LifecycleResult,
  gate: AuditGateInput,
  opts: GateOptions = {},
): GateResult {
  const newOnly = opts.newOnly !== false;
  if (gate.alwaysPass) {
    return { passed: true, evaluated: false, failing: [], considered: reconciled.active.length, reason: 'always_pass is enabled' };
  }
  if (gate.maxChangedLines !== null && typeof opts.changedLines === 'number' && opts.changedLines > gate.maxChangedLines) {
    // Deliberate policy (covered by tests/core.lifecycle.test.ts): a diff larger
    // than max_changed_lines is treated as a bulk/mechanical change and is not
    // gated on findings — the cap means "too large to review here", not "clean".
    // `evaluated:false` records that: this is not a passing verdict.
    return {
      passed: false,
      evaluated: false,
      failing: [],
      considered: reconciled.active.length,
      reason: `diff exceeds max_changed_lines (${opts.changedLines} > ${gate.maxChangedLines}) — findings not gated`,
    };
  }
  if (gate.ignoreLabels.length && (opts.labels ?? []).some((l) => gate.ignoreLabels.includes(l))) {
    return { passed: true, evaluated: false, failing: [], considered: reconciled.active.length, reason: 'a gate-ignored label is present' };
  }

  const thresholdRank = severityRank(gate.threshold);
  const failing = reconciled.active.filter(({ record, transition }) => {
    if (newOnly && transition !== 'new' && transition !== 'reopened') return false;
    return severityRank(record.severity) <= thresholdRank;
  });

  return {
    passed: failing.length === 0,
    evaluated: true,
    failing,
    considered: reconciled.active.length,
    reason: failing.length === 0
      ? `no new findings at or above "${gate.threshold}"`
      : `${failing.length} finding(s) at or above "${gate.threshold}"`,
  };
}
