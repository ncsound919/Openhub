import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  auditFeedbackEnabled,
  buildAuditEpisode,
  buildAuditTelemetry,
  recordAuditFeedback,
} from '../src/services/auditFeedback';
import { executeAuditSuite, type AuditReport } from '../src/services/auditSuite';

let telemetryDir: string;
let learningDir: string;
let projectDir: string;

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** A minimal but complete-enough report for the pure builders / recorder. */
function report(over: Partial<AuditReport> = {}): AuditReport {
  return {
    id: 'audit_test',
    timestamp: '2026-01-01T00:00:00.000Z',
    target: 'C:/work/repo',
    results: [
      { scorer: 'deep', score: 90, summary: 'ok', status: 'ok', determinism: 'static' },
      { scorer: 'grader', score: null, summary: 'no key', error: 'no key', status: 'unavailable' },
    ],
    overallStatus: 'warn',
    overallScore: 76,
    overallScoreDeterministic: 76,
    grade: 'C',
    reconciliation: {
      weightedScore: 76,
      grade: 'C',
      contributing: [{ scorer: 'deep', score: 90, weight: 2 }],
      excluded: [{ scorer: 'grader', reason: 'no key' }],
      dimensions: [],
      deterministicScore: 76,
      llmShare: 0,
      model: 'dimension-v2',
    },
    dimensions: [],
    coverage: { dimensions: [], covered: 0, partial: 0, uncovered: 12, total: 12 },
    coveragePercent: 0,
    findings: [],
    dedup: { input: 4, unique: 3, duplicates: 1, corroborated: 1, dedupRatio: 0.25, bySource: {} },
    scope: { mode: 'diff', base: 'HEAD', changedFiles: ['src/a.ts'], insertions: 1, deletions: 0 },
    delta: {
      baselineId: null,
      baselineAt: null,
      headline: '1 new finding',
      score: { from: 80, to: 76, delta: -4 },
      grade: { from: 'B-', to: 'C', changed: true },
      findings: { newCount: 1, fixedCount: 0, persistedCount: 2, newByDimension: { tests: 1 }, new: [], fixed: [] },
      attribution: [],
      reasons: ['tests regressed -4'],
    },
    determinismConfig: { model: 'pinned', seed: 7, source: 'env' },
    ...over,
  } as AuditReport;
}

beforeEach(() => {
  telemetryDir = tmp('openhub-fb-telemetry-');
  learningDir = tmp('openhub-fb-learning-');
  projectDir = tmp('openhub-fb-project-');
  vi.stubEnv('OPENHUB_TELEMETRY_DIR', telemetryDir);
  vi.stubEnv('OPENHUB_SELFLEARNING_DIR', learningDir);
});

afterEach(() => {
  for (const d of [telemetryDir, learningDir, projectDir]) {
    try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* best-effort */ }
  }
  vi.unstubAllEnvs();
});

function readJsonl(file: string): any[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
}

describe('auditFeedbackEnabled', () => {
  it('is off by default and honours the env flag and explicit override', () => {
    expect(auditFeedbackEnabled()).toBe(false);
    vi.stubEnv('AUDIT_FEEDBACK', '1');
    expect(auditFeedbackEnabled()).toBe(true);
    vi.stubEnv('AUDIT_FEEDBACK', 'no');
    expect(auditFeedbackEnabled()).toBe(false);
    expect(auditFeedbackEnabled(true)).toBe(true);
    expect(auditFeedbackEnabled(false)).toBe(false);
  });
});

describe('buildAuditTelemetry', () => {
  it('maps grade/status to severity and outcome without using accepted/rejected', () => {
    const t = buildAuditTelemetry(report());
    expect(t.system).toBe('audit');
    expect(t.kind).toBe('audit-run');
    expect(t.severity).toBe('medium'); // warn
    expect(t.outcome).toBe('warn');
    expect(t.targetDir).toBe('C:/work/repo');
    expect(t.data).toMatchObject({
      grade: 'C',
      overallScore: 76,
      coveragePercent: 0,
      scope: 'diff',
      newFindings: 1,
      fixedFindings: 0,
      persistedFindings: 2,
    });
  });

  it('uses high/info for fail/pass and skips targetDir for a repo URL', () => {
    expect(buildAuditTelemetry(report({ overallStatus: 'fail' })).severity).toBe('high');
    expect(buildAuditTelemetry(report({ overallStatus: 'pass' })).severity).toBe('info');
    const url = buildAuditTelemetry(report({ target: 'https://github.com/o/r' }));
    expect(url.targetDir).toBeUndefined();
  });
});

describe('buildAuditEpisode', () => {
  it('records a pending episode (never accepted/rejected) with signals', () => {
    const e = buildAuditEpisode(report());
    expect(e.kind).toBe('audit');
    expect(e.outcome).toBe('pending');
    expect(e.targetDir).toBe('C:/work/repo');
    expect(e.systems).toEqual(['audit']);
    expect(e.signals).toMatchObject({
      grade: 'C',
      status: 'warn',
      newFindings: 1,
      persistedFindings: 2,
      scope: 'diff',
      excludedScorers: ['grader'],
    });
  });

  it('marks the llm system when the run leaned on model evidence', () => {
    const e = buildAuditEpisode(report({
      reconciliation: { ...report().reconciliation, llmShare: 0.2 },
    }));
    expect(e.systems).toContain('llm');
  });
});

describe('recordAuditFeedback', () => {
  it('writes one telemetry event and one episode to disk', async () => {
    const res = await recordAuditFeedback(report());
    expect(res.telemetry.wrote).toBe(true);
    expect(res.episode.wrote).toBe(true);
    expect(res.memory.attempted).toBe(false);

    const events = readJsonl(path.join(telemetryDir, 'events.jsonl'));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ system: 'audit', kind: 'audit-run', outcome: 'warn' });

    const episodes = readJsonl(path.join(learningDir, 'episodes.jsonl'));
    expect(episodes).toHaveLength(1);
    expect(episodes[0]).toMatchObject({ kind: 'audit', outcome: 'pending' });
    expect(episodes[0].signals.grade).toBe('C');
  });

  it('does not write a verified verdict that would skew calibration', async () => {
    await recordAuditFeedback(report({ overallStatus: 'pass', grade: 'A' }));
    const episodes = readJsonl(path.join(learningDir, 'episodes.jsonl'));
    expect(episodes[0].outcome).toBe('pending');
    expect(episodes[0].outcome).not.toBe('accepted');
  });
});

describe('executeAuditSuite feedback wiring', () => {
  it('emits nothing when feedback is disabled', async () => {
    await executeAuditSuite({ targetDir: projectDir, scorers: ['deep'] });
    expect(readJsonl(path.join(telemetryDir, 'events.jsonl'))).toHaveLength(0);
    expect(readJsonl(path.join(learningDir, 'episodes.jsonl'))).toHaveLength(0);
  }, 90_000);

  it('emits telemetry + an episode when feedback is enabled', async () => {
    const rep = await executeAuditSuite({ targetDir: projectDir, scorers: ['deep'], feedback: true });
    expect(rep.feedback?.telemetry.wrote).toBe(true);
    expect(rep.feedback?.episode.wrote).toBe(true);

    const events = readJsonl(path.join(telemetryDir, 'events.jsonl'));
    expect(events).toHaveLength(1);
    expect(events[0].system).toBe('audit');
    expect(events[0].data.scorers).toHaveLength(1);

    const episodes = readJsonl(path.join(learningDir, 'episodes.jsonl'));
    expect(episodes).toHaveLength(1);
    expect(episodes[0].kind).toBe('audit');
  }, 90_000);
});
