import { describe, it, expect } from 'vitest';
import type { AuditReport, AuditRunParams } from '../src/services/auditSuite.js';
import type { TypecheckResult } from '../src/services/typecheck.js';
import {
  startPipeline,
  getPipeline,
  cancelPipeline,
  overallProgress,
  type PipelineDeps,
  type PipelineJob,
} from '../src/services/pipeline.js';

function report(status: 'pass' | 'warn' | 'fail', score = 90): AuditReport {
  return {
    id: 'r', timestamp: new Date().toISOString(), target: '/x', results: [],
    overallStatus: status, overallScore: score, overallScoreDeterministic: score,
    grade: 'A', reconciliation: {} as never, dimensions: [], coverage: {} as never,
    coveragePercent: 0, findings: [], dedup: {} as never, criticalFindings: 0,
  } as unknown as AuditReport;
}

const cleanTypecheck: TypecheckResult = { available: true, errors: [] };

function baseDeps(overrides: Partial<PipelineDeps> = {}): Partial<PipelineDeps> {
  return {
    typecheck: async () => cleanTypecheck,
    adversary: async () => ({ checked: true, verdict: 'strong', survived: 0, mutantsRun: 12, killRatePct: 100 }),
    audit: async () => report('pass'),
    repair: async () => ({ ok: true }),
    startLoop: async () => ({ id: 'L1' }),
    loopStatus: async () => ({ status: 'done', iteration: 8, maxIterations: 8 }),
    stopLoop: async () => ({}),
    sleep: async () => {},
    pollIntervalMs: 0,
    maxLoopMs: 1000,
    ...overrides,
  };
}

async function waitForTerminal(id: string, timeoutMs = 4000): Promise<PipelineJob> {
  const start = Date.now();
  for (;;) {
    const job = getPipeline(id);
    if (job && job.status !== 'running') return job;
    if (Date.now() - start > timeoutMs) throw new Error(`pipeline ${id} did not finish (status ${job?.status})`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

describe('pipeline runner', () => {
  it('runs autopilot to completion: typecheck → adversary → audit → (skip repair) → loop → verify', async () => {
    const job = startPipeline({ projectPath: '/tmp/p1', projectName: 'p1', goal: 'fix bugs', mode: 'autopilot' }, baseDeps());
    const done = await waitForTerminal(job.id);
    expect(done.status).toBe('complete');
    expect(done.stages.map((s) => s.id)).toEqual(['typecheck', 'adversary', 'audit', 'repair', 'loop', 'verify']);
    expect(done.stages.map((s) => s.status)).toEqual(['done', 'done', 'done', 'skipped', 'done', 'done']);
    expect(done.stages.find((s) => s.id === 'repair')?.detail).toContain('audit passed');
    expect(overallProgress(done)).toBe(1);
  });

  it('flags weak tests from the adversary as a warn, not a failure', async () => {
    const job = startPipeline(
      { projectPath: '/tmp/p1b', projectName: 'p1b', mode: 'autopilot' },
      baseDeps({ adversary: async () => ({ checked: true, verdict: 'weak', survived: 7, mutantsRun: 12, killRatePct: 42 }) }),
    );
    const done = await waitForTerminal(job.id);
    const adv = done.stages.find((s) => s.id === 'adversary');
    expect(adv?.status).toBe('done');
    expect(adv?.ok).toBe(false);
    expect(adv?.detail).toContain('7/12');
    expect(done.status).toBe('complete');
  });

  it('dispatches repair when the audit fails, and reports a failed dispatch', async () => {
    const ok = startPipeline(
      { projectPath: '/tmp/p2', projectName: 'p2', mode: 'audit' },
      baseDeps({ audit: async () => report('fail', 40) }),
    );
    const doneOk = await waitForTerminal(ok.id);
    expect(doneOk.status).toBe('complete');
    expect(doneOk.stages.find((s) => s.id === 'repair')?.ok).toBe(true);

    const bad = startPipeline(
      { projectPath: '/tmp/p3', projectName: 'p3', mode: 'audit' },
      baseDeps({ audit: async () => report('fail', 40), repair: async () => ({ ok: false, error: 'draymond down' }) }),
    );
    const doneBad = await waitForTerminal(bad.id);
    expect(doneBad.status).toBe('failed');
    expect(doneBad.stages.find((s) => s.id === 'repair')?.status).toBe('failed');
    expect(doneBad.error).toContain('draymond down');
  });

  it('skips the loop when no goal is provided', async () => {
    const job = startPipeline({ projectPath: '/tmp/p4', projectName: 'p4', mode: 'autopilot' }, baseDeps());
    const done = await waitForTerminal(job.id);
    expect(done.stages.find((s) => s.id === 'loop')?.status).toBe('skipped');
  });

  it('surfaces audit progress through the onProgress hook', async () => {
    let observed = 0;
    const audit = async (p: AuditRunParams) => {
      p.onProgress?.({ scorer: 'typecheck', index: 0, total: 4 });
      p.onProgress?.({ scorer: 'sca', index: 2, total: 4 });
      observed = 1;
      return report('pass');
    };
    const job = startPipeline({ projectPath: '/tmp/p5', projectName: 'p5', mode: 'audit' }, baseDeps({ audit }));
    const done = await waitForTerminal(job.id);
    expect(observed).toBe(1);
    expect(done.stages.find((s) => s.id === 'audit')?.progress).toBe(1);
  });

  it('cancels a running job', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const audit = async () => { await gate; return report('pass'); };
    const job = startPipeline({ projectPath: '/tmp/p6', projectName: 'p6', mode: 'audit' }, baseDeps({ audit }));
    await new Promise((r) => setTimeout(r, 20));
    expect(cancelPipeline(job.id)).toBe(true);
    release();
    const done = await waitForTerminal(job.id);
    expect(done.status).toBe('cancelled');
  });

  it('fails the job when the audit itself throws', async () => {
    const job = startPipeline(
      { projectPath: '/tmp/p7', projectName: 'p7', mode: 'audit' },
      baseDeps({ audit: async () => { throw new Error('audit exploded'); } }),
    );
    const done = await waitForTerminal(job.id);
    expect(done.status).toBe('failed');
    expect(done.stages.find((s) => s.id === 'audit')?.detail).toContain('audit exploded');
  });
});
