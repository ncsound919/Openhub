import { describe, it, expect } from 'vitest';
import {
  anyLive,
  heldByTask,
  heldWorktrees,
  isMissionLive,
  missionHeadline,
  normalizeMissionList,
  taskProgress,
  taskViews,
  tokenTotal,
} from '../src/ide/threads';

describe('normalizeMissionList', () => {
  it('parses the {count, missions} body, sorts newest-first, marks liveness', () => {
    const out = normalizeMissionList({
      count: 2,
      missions: [
        { id: 'm1', goal: 'a', status: 'done', tasks: 3, done: 3, startedAt: 10, live: false },
        { id: 'm2', goal: 'b', status: 'running', tasks: 2, done: 0, startedAt: 20, live: true },
      ],
    });
    expect(out.map((m) => m.id)).toEqual(['m2', 'm1']);
    expect(out[0].live).toBe(true);
    expect(out[1].live).toBe(false);
  });

  it('accepts a bare array and drops id-less entries', () => {
    const out = normalizeMissionList([{ goal: 'x' }, { id: 'ok', status: 'stopped' }]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('ok');
  });

  it('treats awaiting-approval as live even without the live flag', () => {
    const out = normalizeMissionList({ missions: [{ id: 'm', status: 'awaiting-approval' }] });
    expect(out[0].live).toBe(true);
  });

  it('returns [] for junk', () => {
    expect(normalizeMissionList(null)).toEqual([]);
    expect(normalizeMissionList({})).toEqual([]);
  });
});

describe('isMissionLive / anyLive', () => {
  it('only running and awaiting-approval are live', () => {
    expect(isMissionLive('running')).toBe(true);
    expect(isMissionLive('awaiting-approval')).toBe(true);
    expect(isMissionLive('done')).toBe(false);
    expect(isMissionLive('failed')).toBe(false);
    expect(anyLive([{ id: 'a', goal: '', status: 'done', tasks: 0, done: 0, startedAt: 0, live: false }])).toBe(false);
  });
});

describe('taskViews', () => {
  it('maps status/loop/usage/audit and tolerates missing fields', () => {
    const out = taskViews({
      tasks: [
        {
          id: 't1', label: 'lib', status: 'done', attempts: 1, maxAttempts: 2, loopId: 'loop_1',
          targetDir: 'C:/wt/t1', artifactSummary: 'exports: foo', audit: { verified: true },
          usage: { calls: 2, promptTokens: 100, completionTokens: 5, totalTokens: 105 },
          subagentRole: 'coder',
        },
        { id: 't2', label: 'cli', status: 'running' },
        null,
      ],
    });
    expect(out).toHaveLength(2);
    expect(out[0].auditVerified).toBe(true);
    expect(out[0].loopId).toBe('loop_1');
    expect(out[0].usage?.totalTokens).toBe(105);
    expect(out[1].maxAttempts).toBe(1);
    expect(out[1].auditVerified).toBe(false);
  });

  it('returns [] when tasks is absent', () => {
    expect(taskViews({})).toEqual([]);
  });
});

describe('taskProgress', () => {
  it('counts done/failed/running and treats stalled as failed', () => {
    expect(taskProgress([
      { status: 'done' }, { status: 'failed' }, { status: 'stalled' }, { status: 'running' }, { status: 'pending' },
    ])).toEqual({ done: 1, failed: 2, running: 2, total: 5 });
  });
});

describe('tokenTotal / missionHeadline', () => {
  it('sums tokens and formats the headline with a parallel hint', () => {
    expect(tokenTotal({ totalTokens: 42 })).toBe(42);
    expect(tokenTotal(undefined)).toBe(0);
    expect(missionHeadline({ id: 'm', goal: '', status: 'running', tasks: 3, done: 1, startedAt: 0, live: true }, 2)).toBe('1/3 tasks · 2 parallel');
    expect(missionHeadline({ id: 'm', goal: '', status: 'running', tasks: 1, done: 0, startedAt: 0, live: true })).toBe('0/1 task');
  });
});

describe('heldWorktrees / heldByTask', () => {
  it('parses the {worktrees} body and drops entries missing taskId/branch/path', () => {
    const out = heldWorktrees({
      worktrees: [
        { taskId: 't1', label: 'lib', status: 'done', path: '/wt/t1', branch: 'axiom/t1', repoDir: '/repo', baseBranch: 'main', sha: 'abc' },
        { taskId: 't2', branch: 'axiom/t2' },
        { label: 'no id' },
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ taskId: 't1', branch: 'axiom/t1', repoDir: '/repo' });
  });

  it('returns [] for junk and indexes by task id', () => {
    expect(heldWorktrees(null)).toEqual([]);
    expect(heldWorktrees({})).toEqual([]);
    const list = heldWorktrees({ worktrees: [{ taskId: 't1', path: '/wt/t1', branch: 'b1' }] });
    const map = heldByTask(list);
    expect(map.t1.branch).toBe('b1');
    expect(map.nope).toBeUndefined();
  });
});
