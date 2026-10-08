import { describe, it, expect } from 'vitest';
import { groupEventsIntoSteps } from '../src/mission/MissionTimeline';
import type { MissionEvent } from '../src/lib/missionStore.js';

const ev = (over: Partial<MissionEvent>): MissionEvent => ({ at: 0, kind: 'log', text: '', ...over });

describe('groupEventsIntoSteps', () => {
  it('puts every event in one step when no taskId exists', () => {
    const steps = groupEventsIntoSteps([ev({ text: 'a' }), ev({ text: 'b' })]);
    expect(steps).toHaveLength(1);
    expect(steps[0].events).toHaveLength(2);
    expect(steps[0].heading).toBe('Step 1');
  });

  it('starts a new step when a new taskId arrives', () => {
    const steps = groupEventsIntoSteps([
      ev({ taskId: 't1', text: 'a' }),
      ev({ taskId: 't1', text: 'b' }),
      ev({ taskId: 't2', text: 'c' }),
    ]);
    expect(steps.map((s) => s.heading)).toEqual(['t1', 't2']);
    expect(steps[0].events).toHaveLength(2);
  });

  it('starts a new step when the kind transitions into a plan-ish kind', () => {
    const steps = groupEventsIntoSteps([
      ev({ kind: 'log', text: 'a' }),
      ev({ kind: 'plan.updated', text: 'b' }),
    ]);
    expect(steps).toHaveLength(2);
    expect(steps[1].heading).toBe('Step 2');
  });

  it('keeps consecutive plan-ish events in the same step', () => {
    const steps = groupEventsIntoSteps([
      ev({ kind: 'plan.updated', text: 'a' }),
      ev({ kind: 'plan.updated', text: 'b' }),
    ]);
    expect(steps).toHaveLength(1);
  });

  it('returns no steps for an empty log', () => {
    expect(groupEventsIntoSteps([])).toEqual([]);
  });
});
