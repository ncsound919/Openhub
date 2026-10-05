import { describe, expect, it } from 'vitest';
import {
  partKeyForStage,
  partDefForStage,
  todosForStages,
  doneForStages,
  nowStageForJob,
  formatDuration,
  stageElapsedMs,
  jobElapsedMs,
  etaMs,
  auditVerdict,
} from '../src/components/PipelineRobot';
import { describeBuild } from '../src/components/PipelineRobot3D';
import type { PipelineJobView, PipelineStageView } from '../src/ide/usePipeline';

function stage(id: string, status: PipelineStageView['status'], ok: boolean | null = null): PipelineStageView {
  return { id, label: id, status, ok, detail: '', progress: 0 };
}

describe('PipelineRobot stage mapping', () => {
  it('maps the six autopilot stages to robot attachments', () => {
    expect(partKeyForStage('typecheck')).toBe('head');
    expect(partKeyForStage('adversary')).toBe('arm-left');
    expect(partKeyForStage('audit')).toBe('torso');
    expect(partKeyForStage('repair')).toBe('arm-right');
    expect(partKeyForStage('loop')).toBe('legs');
    expect(partKeyForStage('verify')).toBe('visor');
  });

  it('leaves unknown/custom stages unmapped (bolt-on modules, never a wrong part)', () => {
    expect(partKeyForStage('custom-thing')).toBeNull();
    expect(partDefForStage('custom-thing')).toBeNull();
    expect(partDefForStage('audit')?.title).toBe('Audit core');
  });
});

describe('PipelineRobot selectors', () => {
  const stages = [
    stage('typecheck', 'done', true),
    stage('adversary', 'running'),
    stage('audit', 'pending'),
    stage('repair', 'pending'),
    stage('loop', 'pending'),
    stage('verify', 'pending'),
  ];

  it('splits todos and dones', () => {
    expect(todosForStages(stages).map((s) => s.id)).toEqual(['audit', 'repair', 'loop', 'verify']);
    expect(doneForStages(stages).map((s) => s.id)).toEqual(['typecheck']);
  });

  it('spotlights the running stage, then failed, then the next todo', () => {
    expect(nowStageForJob(stages)?.id).toBe('adversary');
    const failed = [stage('typecheck', 'done', true), stage('adversary', 'failed', false), stage('audit', 'pending')];
    expect(nowStageForJob(failed)?.id).toBe('adversary');
    const fresh = [stage('typecheck', 'pending'), stage('audit', 'pending')];
    expect(nowStageForJob(fresh)?.id).toBe('typecheck');
    expect(nowStageForJob([])).toBeNull();
  });
});

describe('PipelineRobot timing + verdict readouts', () => {
  const t0 = Date.parse('2026-09-23T07:00:00.000Z');
  const iso = (ms: number) => new Date(ms).toISOString();

  it('formats durations', () => {
    expect(formatDuration(4500)).toBe('4s');
    expect(formatDuration(192000)).toBe('3m 12s');
    expect(formatDuration(3720000)).toBe('1h 02m');
    expect(formatDuration(NaN)).toBe('—');
    expect(formatDuration(-5)).toBe('—');
  });

  it('measures stage elapsed from started/ended timestamps', () => {
    const running: PipelineStageView = { id: 'audit', label: 'audit', status: 'running', ok: null, detail: '', progress: 0.5, startedAt: iso(t0), endedAt: null };
    expect(stageElapsedMs(running, t0 + 90000)).toBe(90000);
    expect(stageElapsedMs({ ...running, status: 'done', endedAt: iso(t0 + 30000) }, t0 + 999999)).toBe(30000);
    expect(stageElapsedMs({ ...running, status: 'pending', startedAt: null }, t0)).toBeNull();
    expect(stageElapsedMs({ ...running, startedAt: 'not-a-date' }, t0)).toBeNull();
  });

  it('estimates ETA only while running with partial progress', () => {
    const job: PipelineJobView = { id: 'j', mode: 'audit', status: 'running', progress: 0.25, stages: [], error: null, createdAt: iso(t0) };
    expect(jobElapsedMs(job, t0 + 60000)).toBe(60000);
    expect(etaMs(job, t0 + 60000)).toBe(180000);
    expect(etaMs({ ...job, status: 'complete', progress: 1 }, t0 + 60000)).toBeNull();
    expect(etaMs({ ...job, progress: 0 }, t0 + 60000)).toBeNull();
    expect(etaMs({ ...job, createdAt: undefined }, t0 + 60000)).toBeNull();
  });

  it('reads the audit verdict carried on the job payload', () => {
    const withAudit: PipelineJobView = {
      id: 'j', mode: 'audit', status: 'complete', progress: 1, stages: [], error: null,
      audit: { overallStatus: 'fail', overallScore: 58, criticalFindings: 0 },
    };
    expect(auditVerdict(withAudit)).toEqual({ status: 'fail', score: 58, criticals: 0 });
    const bare: PipelineJobView = { id: 'j', mode: 'audit', status: 'running', progress: 0, stages: [], error: null };
    expect(auditVerdict(bare)).toBeNull();
  });

  it('narrates parking, timing, goal and verdict', () => {
    const job: PipelineJobView = {
      id: 'j', mode: 'autopilot', status: 'awaiting-approval', progress: 0, stages: [],
      error: null, goal: 'fix it', createdAt: iso(t0),
    };
    const text = describeBuild(job, t0 + 45000);
    expect(text).toContain('parked for approval');
    expect(text).toContain('Elapsed 45s');
    expect(text).toContain('Goal: fix it');
    const graded: PipelineJobView = {
      ...job, status: 'complete', progress: 1,
      audit: { overallStatus: 'fail', overallScore: 58, criticalFindings: 2 },
    };
    expect(describeBuild(graded, t0 + 45000)).toContain('Audit verdict: fail, score 58, 2 critical');
  });
});
