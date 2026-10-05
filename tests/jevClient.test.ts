import { describe, expect, it } from 'vitest';
import {
  jevEnabled,
  decideSystemOne,
  reviewAdvisory,
  buildReviewAdvisory,
  repairAdvisory,
  buildRepairAdvisory,
  auditAdvisory,
  buildAuditAdvisory,
  workspaceAdvisory,
  buildWorkspaceAdvisory,
  type JevResult,
} from '../src/services/jevClient';

describe('jevEnabled', () => {
  it('is enabled by default (gateway or local base present) and needs no key', () => {
    delete process.env.OPENHUB_JEV_ENABLED;
    expect(jevEnabled()).toBe(true);
  });
});

describe('decideSystemOne offline gate', () => {
  it('returns ok:false offline when disabled, never fabricating', async () => {
    process.env.OPENHUB_JEV_ENABLED = '0';
    try {
      const r = await decideSystemOne({ state: 's', questions: { go: { type: 'noul', instructions: 'Go?' } } });
      expect(r.ok).toBe(false);
      expect(r.source).toBe('offline');
      expect(r.error).toMatch(/disabled/);
    } finally {
      delete process.env.OPENHUB_JEV_ENABLED;
    }
  });
});

describe('reviewAdvisory', () => {
  it('builds verdict choice + merge noul + risk score', () => {
    const { state, questions } = reviewAdvisory({ fileCount: 3, addedLines: 120, removedLines: 10, diffSummary: 'feat: auth' });
    expect((state as any).action).toBe('code_review');
    expect(questions.verdict.type).toBe('choice');
    expect(questions.merge.type).toBe('noul');
    expect(questions.risk.type).toBe('score');
  });

  it('parses the answers', () => {
    const result: JevResult = {
      ok: true,
      source: 'vercel',
      model: 'typesafe-ai/jev',
      answers: {
        verdict: { type: 'choice', choice: 'request_changes', probabilities: { approve: 0.1, request_changes: 0.8, block: 0.1 }, confidence: 0.9 },
        merge: { type: 'noul', noul: 0.3 },
        risk: { type: 'score', score: 1.8, legend: { '0': 'None', '1': 'Low', '2': 'Medium', '3': 'High' }, probabilities: {}, confidence: 0.7 },
      },
      latencyMs: 80,
    };
    const advisory = buildReviewAdvisory(result);
    expect(advisory.ok).toBe(true);
    expect(advisory.verdict).toBe('request_changes');
    expect(advisory.merge).toBe(false);
    expect(advisory.riskScore).toBeCloseTo(1.8);
    expect(advisory.source).toBe('vercel');
  });
});

describe('repairAdvisory', () => {
  it('builds lane choice + urgent noul', () => {
    const { questions } = repairAdvisory({ finding: 'flaky test', brief: 'retry then escalate' });
    expect(questions.lane.type).toBe('choice');
    expect(questions.urgent.type).toBe('noul');
  });

  it('parses answers', () => {
    const result: JevResult = {
      ok: true,
      source: 'localjev',
      model: 'localjev-0.2',
      answers: {
        lane: { type: 'choice', choice: 'autofix', probabilities: { autofix: 0.8, dispatch: 0.1, hold: 0.1 }, confidence: 0.85 },
        urgent: { type: 'noul', noul: 0.95 },
      },
      latencyMs: 30,
    };
    const advisory = buildRepairAdvisory(result);
    expect(advisory.lane).toBe('autofix');
    expect(advisory.urgent).toBe(true);
    expect(advisory.source).toBe('localjev');
  });
});

describe('auditAdvisory', () => {
  it('builds severity score + next choice', () => {
    const { questions } = auditAdvisory({ status: 'fail', factCount: 3, passedFacts: 1, discrepancies: ['x'] });
    expect(questions.severity.type).toBe('score');
    expect(questions.next.type).toBe('choice');
  });

  it('parses answers', () => {
    const result: JevResult = {
      ok: true,
      source: 'vercel',
      model: 'typesafe-ai/jev',
      answers: {
        severity: { type: 'score', score: 2.6, legend: { '0': 'None', '1': 'Minor', '2': 'Moderate', '3': 'Severe' }, probabilities: {}, confidence: 0.7 },
        next: { type: 'choice', choice: 'flag', probabilities: { accept: 0.05, autofix: 0.1, flag: 0.8, reject: 0.05 }, confidence: 0.9 },
      },
      latencyMs: 60,
    };
    const advisory = buildAuditAdvisory(result);
    expect(advisory.severityScore).toBeCloseTo(2.6);
    expect(advisory.next).toBe('flag');
  });
});

describe('workspaceAdvisory', () => {
  it('builds allow noul + risk score', () => {
    const { questions } = workspaceAdvisory({ path: 'src/main.ts', operation: 'rewrite' });
    expect(questions.allow.type).toBe('noul');
    expect(questions.risk.type).toBe('score');
  });

  it('parses answers', () => {
    const result: JevResult = {
      ok: true,
      source: 'localjev',
      model: 'localjev-0.2',
      answers: {
        allow: { type: 'noul', noul: 0.88 },
        risk: { type: 'score', score: 0.2, legend: { '0': 'None', '1': 'Low', '2': 'Medium', '3': 'High' }, probabilities: {}, confidence: 0.6 },
      },
      latencyMs: 20,
    };
    const advisory = buildWorkspaceAdvisory(result);
    expect(advisory.allow).toBe(true);
    expect(advisory.riskScore).toBeCloseTo(0.2);
  });

  it('reports offline honestly when the call failed', () => {
    const advisory = buildWorkspaceAdvisory({ ok: false, source: 'offline', latencyMs: 3, error: 'down' });
    expect(advisory.ok).toBe(false);
    expect(advisory.source).toBe('offline');
    expect(advisory.allow).toBeUndefined();
  });
});