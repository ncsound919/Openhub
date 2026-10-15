// securityAlerts.test.ts — the OpenHub-native leak-alert producer.
// Two contracts matter here: (1) only security findings at/above the floor are
// alerted, and (2) a secret's VALUE never travels into an alert.
import { describe, it, expect } from 'vitest';
import {
  isSecurityFinding,
  alertFromFinding,
  reportSecurityFindings,
  type SecurityAlert,
} from '../src/services/securityAlerts.js';
import type { Finding } from '../src/services/findings.js';

const LEAKED = 'sk-live-SUPERSECRETVALUE1234567890';

function finding(over: Partial<Finding> = {}): Finding {
  return {
    id: `fp-${Math.random().toString(36).slice(2)}`,
    source: 'sca',
    dimension: 'security',
    category: 'secret',
    severity: 'high',
    confidence: 0.9,
    determinism: 'static',
    location: { file: 'src/leak.ts', line: 12 },
    evidence: `AWS key found: ${LEAKED}`,
    remediation: 'rotate the key',
    ...over,
  } as Finding;
}

describe('isSecurityFinding', () => {
  it('accepts the security dimension and security categories', () => {
    expect(isSecurityFinding(finding())).toBe(true);
    expect(isSecurityFinding(finding({ dimension: 'docs', category: 'cwe-79' }))).toBe(true);
    expect(isSecurityFinding(finding({ dimension: 'docs', category: 'secret' }))).toBe(true);
  });
  it('rejects non-security findings', () => {
    expect(isSecurityFinding(finding({ dimension: 'maintainability', category: 'coverage-gap' }))).toBe(false);
    expect(isSecurityFinding(finding({ dimension: 'docs', category: 'missing-readme' }))).toBe(false);
  });
});

describe('alertFromFinding', () => {
  it('names the leak class and pins the location', () => {
    const a = alertFromFinding(finding(), 'BUSINESS/INFRASTRUCTURE/openhub');
    expect(a.kind).toBe('secret-leak');
    expect(a.severity).toBe('high');
    expect(a.detail).toContain('src/leak.ts:12');
    expect(a.detail).toContain('repo=BUSINESS/INFRASTRUCTURE/openhub');
  });

  it('NEVER carries the secret value, even though the finding evidence does', () => {
    const f = finding();
    const a = alertFromFinding(f);
    expect(f.evidence).toContain(LEAKED); // the input really does hold the value
    expect(a.detail).not.toContain(LEAKED);
    expect(JSON.stringify(a)).not.toContain(LEAKED);
  });

  it('uses the fingerprint for a stable dedup key', () => {
    const f = finding({ identity: 'lesson:abc' });
    expect(alertFromFinding(f).dedupKey).toBe('openhub-security:lesson:abc');
    expect(alertFromFinding(f).dedupKey).toBe(alertFromFinding(f).dedupKey);
  });
});

describe('reportSecurityFindings', () => {
  it('alerts security findings at/above the floor and skips the rest', async () => {
    const sent: SecurityAlert[] = [];
    const r = await reportSecurityFindings(
      [
        finding({ severity: 'critical' }),
        finding({ severity: 'high' }),
        finding({ severity: 'medium' }),                                  // below floor
        finding({ dimension: 'docs', category: 'missing-readme' }),       // not security
      ],
      { report: async (a) => { sent.push(a); }, env: {} },
    );
    expect(r.considered).toBe(3);
    expect(r.alerted).toBe(2);
    expect(r.skipped.length).toBe(1);
    expect(sent.map((s) => s.severity)).toEqual(['critical', 'high']);
  });

  it('honours the kill switch and the severity floor override', async () => {
    const sent: SecurityAlert[] = [];
    const off = await reportSecurityFindings([finding()], { report: async (a) => { sent.push(a); }, env: { OPENHUB_ALERT_FROM_FINDINGS: '0' } });
    expect(off.alerted).toBe(0);
    const low = await reportSecurityFindings([finding({ severity: 'low' })], { report: async (a) => { sent.push(a); }, env: { OPENHUB_SECRET_ALERT_MIN_SEVERITY: 'low' } });
    expect(low.alerted).toBe(1);
    expect(sent.length).toBe(1);
  });

  it('a failing reporter does not abort the batch', async () => {
    let calls = 0;
    const r = await reportSecurityFindings([finding(), finding()], {
      env: {},
      report: async () => { calls += 1; if (calls === 1) throw new Error('bus down'); return null; },
    });
    expect(r.alerted).toBe(1);
    expect(r.skipped.some((s) => s.includes('report failed'))).toBe(true);
  });
});
