import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executeAuditSuite, evaluateAuditGate, resolveRequiredScorers } from '../src/services/auditSuite';

describe('evaluateAuditGate — fail-closed conditions', () => {
  it('a critical finding fails an otherwise high-scoring gate', () => {
    const g = evaluateAuditGate(95, 'pr', { criticalFindings: 1 });
    expect(g).not.toBeNull();
    expect(g!.pass).toBe(false);
    expect(g!.reason).toContain('critical finding');
  });

  it('a required scorer that could not run fails the gate even at a high score', () => {
    const g = evaluateAuditGate(95, 'pr', { requiredUnavailableScorers: ['sca'] });
    expect(g!.pass).toBe(false);
    expect(g!.reason).toContain('required scorer');
  });

  it('a clean high score still passes', () => {
    const g = evaluateAuditGate(95, 'pr', { criticalFindings: 0, requiredUnavailableScorers: [] });
    expect(g!.pass).toBe(true);
  });

  it('advisory stages record the condition but never block', () => {
    const g = evaluateAuditGate(95, 'nightly', { criticalFindings: 2 });
    expect(g!.advisory).toBe(true);
    expect(g!.pass).toBe(true);
    expect(g!.reason).toContain('critical finding');
  });
});

describe('resolveRequiredScorers', () => {
  it('defaults to the security scorers, honours env overrides, and explicit wins', () => {
    expect(resolveRequiredScorers(undefined, {} as NodeJS.ProcessEnv)).toEqual(['sca', 'claw']);
    expect(resolveRequiredScorers(undefined, { AUDIT_REQUIRE_SCORERS: 'sonarqube,sca' } as NodeJS.ProcessEnv)).toEqual(['sonarqube', 'sca']);
    expect(resolveRequiredScorers(undefined, { AUDIT_REQUIRE_SCORERS: '' } as NodeJS.ProcessEnv)).toEqual([]);
    expect(resolveRequiredScorers(['grader'], {} as NodeJS.ProcessEnv)).toEqual(['grader']);
  });
});

describe('executeAuditSuite — coverage fail-closed', () => {
  it('reports coverage and fails closed when a required scorer cannot run', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-audit-failclosed-'));
    try {
      // codenexus is deterministically unavailable without its service, so this
      // exercises the coverage gap without depending on any live service.
      const report = await executeAuditSuite({
        targetDir: dir,
        scorers: ['codenexus'],
        requiredScorers: ['codenexus'],
      });
      expect(report.scorersTotal).toBe(1);
      expect(report.scorersRun).toBe(0);
      expect(report.unavailableScorers).toContain('codenexus');
      expect(report.requiredUnavailableScorers).toContain('codenexus');
      expect(report.overallStatus).toBe('fail');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});
