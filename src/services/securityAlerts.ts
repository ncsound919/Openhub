import { reportIncident, type IncidentSeverity } from './incidentBus.js';
import type { Finding, Severity } from './findings.js';

/**
 * Security alerts — OpenHub-native producer for the security spine.
 *
 * 2026-10-15: "deep audits happen in OpenHub", so the leak-alert class no longer
 * needs Keywire's `data/security/alerts.jsonl` tail. Any set of normalized
 * findings that comes out of an audit run is mapped here straight onto the
 * incident bus (repair auto-dispatch for high/critical, `alert.raised` webhooks,
 * ntfy channel, dedupe) — the same rails the file-tailing bridge uses.
 *
 * Two rules this module enforces, because an alert about a leaked secret is the
 * one place a secret value could leak again:
 *   1. A finding's `evidence` is NEVER copied into an incident for a secret or
 *      any security finding — only location + remediation travel.
 *   2. Severity below the floor (default `high`, env
 *      `OPENHUB_SECRET_ALERT_MIN_SEVERITY`) is not alerted; it stays a finding.
 */

export const SECURITY_CATEGORY_PREFIXES = ['secret', 'cwe', 'cve', 'vuln', 'injection', 'xss', 'sqli', 'ssrf', 'rce'];

const SEVERITY_ORDER: Record<Severity, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };

/** A finding is security-relevant when its dimension is `security`, or its
 *  category names a security class (secret, cwe-*, cve, vuln, injection, ...). */
export function isSecurityFinding(finding: Finding): boolean {
  if (finding.dimension === 'security') return true;
  const category = String(finding.category ?? '').toLowerCase();
  return SECURITY_CATEGORY_PREFIXES.some((prefix) => category.startsWith(prefix));
}

export function minSeverity(env: NodeJS.ProcessEnv = process.env): Severity {
  const raw = String(env.OPENHUB_SECRET_ALERT_MIN_SEVERITY ?? 'high').toLowerCase();
  return (Object.keys(SEVERITY_ORDER) as Severity[]).includes(raw as Severity) ? (raw as Severity) : 'high';
}

function alertSeverity(severity: Severity): IncidentSeverity {
  return severity === 'info' ? 'low' : severity;
}

/**
 * The alert an incident bus will carry. Deliberately excludes `evidence` —
 * see rule 1 in the module header.
 */
export interface SecurityAlert {
  source: 'ecosystem';
  kind: string;
  severity: IncidentSeverity;
  detail: string;
  dedupKey: string;
}

export function alertFromFinding(finding: Finding, repo = ''): SecurityAlert {
  const category = String(finding.category ?? 'security').toLowerCase();
  const kind = category.startsWith('secret') ? 'secret-leak' : 'security-finding';
  const where = finding.location?.file
    ? `${finding.location.file}${finding.location.line ? `:${finding.location.line}` : ''}`
    : 'location-unpinned';
  const parts = [
    repo ? `repo=${repo}` : '',
    `tool=${finding.source}`,
    `category=${category}`,
    `confidence=${finding.confidence}`,
    `determinism=${finding.determinism}`,
    where !== 'location-unpinned' ? `at=${where}` : 'at=location-unpinned',
    finding.remediation ? `fix=${String(finding.remediation).slice(0, 300)}` : '',
    finding.corroboratedBy?.length ? `also_seen_by=${finding.corroboratedBy.join(',')}` : '',
  ].filter(Boolean);
  return {
    source: 'ecosystem',
    kind,
    severity: alertSeverity(finding.severity),
    detail: parts.join(' · ').slice(0, 4000),
    // Stable across runs: the finding fingerprint (identity when namespaced).
    dedupKey: `openhub-security:${finding.identity ?? finding.id}`.slice(0, 200),
  };
}

export interface SecurityAlertResult {
  considered: number;
  alerted: number;
  skipped: string[];
}

/**
 * Report security findings (severity >= floor) as incidents. Never throws for a
 * single bad finding; returns what it did so a caller can log honestly.
 *
 * `report` is injectable so this can be unit-tested without a database.
 */
export async function reportSecurityFindings(
  findings: readonly Finding[],
  opts: { repo?: string; env?: NodeJS.ProcessEnv; report?: (alert: SecurityAlert) => Promise<unknown> } = {},
): Promise<SecurityAlertResult> {
  const env = opts.env ?? process.env;
  const report = opts.report ?? ((alert: SecurityAlert) => reportIncident(alert));
  if (String(env.OPENHUB_ALERT_FROM_FINDINGS ?? '1') === '0') {
    return { considered: 0, alerted: 0, skipped: ['disabled (OPENHUB_ALERT_FROM_FINDINGS=0)'] };
  }
  const floor = SEVERITY_ORDER[minSeverity(env)];
  const result: SecurityAlertResult = { considered: 0, alerted: 0, skipped: [] };

  for (const finding of findings) {
    if (!isSecurityFinding(finding)) continue;
    result.considered += 1;
    if (SEVERITY_ORDER[finding.severity] < floor) {
      result.skipped.push(`${finding.id} (below ${minSeverity(env)})`);
      continue;
    }
    try {
      const alert = alertFromFinding(finding, opts.repo ?? '');
      await report(alert);
      result.alerted += 1;
    } catch {
      result.skipped.push(`${finding.id} (report failed)`);
    }
  }
  return result;
}
