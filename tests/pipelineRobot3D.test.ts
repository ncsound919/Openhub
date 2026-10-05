import { describe, expect, it } from 'vitest';
import { describeBuild } from '../src/components/PipelineRobot3D';
import { buildPartStates } from '../src/components/PipelineRobotScene';
import type { PipelineJobView, PipelineStageView } from '../src/ide/usePipeline';

function stage(id: string, status: PipelineStageView['status'], detail = '', progress = 0): PipelineStageView {
  return { id, label: id, status, ok: status === 'done' ? true : null, detail, progress };
}

function job(stages: PipelineStageView[], status: PipelineJobView['status'] = 'running', progress = 0.4): PipelineJobView {
  return { id: 'j1', mode: 'autopilot', goal: 'ship it', status, progress, stages, error: null };
}

describe('buildPartStates', () => {
  it('lights sectors by stage status and marks the running sector hot', () => {
    const stages = [stage('typecheck', 'done'), stage('adversary', 'running'), stage('audit', 'pending')];
    const { lights, active } = buildPartStates(stages);
    expect(lights.head).toBe('ok');
    expect(lights['arm-left']).toBe('working');
    expect(lights.torso).toBe('idle');
    expect(lights.legs).toBe('idle');
    expect(active).toBe('arm-left');
  });

  it('marks failed sectors and reports no hot sector when nothing runs', () => {
    const stages = [stage('typecheck', 'done'), stage('adversary', 'failed')];
    const { lights, active } = buildPartStates(stages);
    expect(lights['arm-left']).toBe('error');
    expect(active).toBeNull();
  });
});

describe('describeBuild', () => {
  it('narrates progress, the hot sector with its detail, and what is next', () => {
    const stages = [
      stage('typecheck', 'done'),
      { ...stage('adversary', 'running', 'probing auth.ts for faults', 0.42), label: 'Adversary' },
      stage('audit', 'pending'),
    ];
    const text = describeBuild(job(stages, 'running', 0.31));
    expect(text).toContain('autopilot');
    expect(text).toContain('31%');
    expect(text).toContain('Adversary');
    expect(text).toContain('probing auth.ts for faults');
    expect(text).toContain('Probe arm');
    expect(text).toContain('queued next');
  });

  it('states completion and faults plainly', () => {
    const done = describeBuild(job([stage('typecheck', 'done')], 'complete', 1));
    expect(done).toContain('complete');
    expect(done).toContain('100%');
    const failed = describeBuild({ ...job([stage('adversary', 'failed', 'boom')], 'failed', 0.2), error: 'boom' });
    expect(failed).toContain('failed');
    expect(failed).toContain('Fault: boom');
  });
});
