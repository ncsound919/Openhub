import { describe, it, expect } from 'vitest';
import { taskRows, taskTotal, type MissionView } from '../src/ide/missionView.js';

// Regression guard: Axiom's /api/mission/list reports `tasks` as a COUNT. Code
// that assumed an array threw "m.tasks.map is not a function" and blanked the
// workspace panel.
describe('missionView normalization', () => {
  it('treats a numeric `tasks` as a count, with no rows', () => {
    const m: MissionView = { id: 'm1', goal: 'g', status: 'running', tasks: 3, done: 1 };
    expect(taskTotal(m)).toBe(3);
    expect(taskRows(m)).toEqual([]);
  });

  it('accepts a full task array and derives the count from it', () => {
    const m: MissionView = {
      id: 'm2',
      goal: 'g',
      status: 'running',
      tasks: [
        { id: 't1', label: 'plan', status: 'done' },
        { id: 't2', label: 'build', status: 'running' },
      ],
    };
    expect(taskTotal(m)).toBe(2);
    expect(taskRows(m).map((t) => t.id)).toEqual(['t1', 't2']);
  });

  it('degrades to zero/empty when `tasks` is missing or malformed', () => {
    expect(taskTotal({ id: 'm3', goal: 'g', status: 'running' })).toBe(0);
    expect(taskRows({ id: 'm4', goal: 'g', status: 'running' })).toEqual([]);
    expect(taskTotal({ id: 'm5', goal: 'g', status: 'running', tasks: 'nope' as unknown as number })).toBe(0);
  });
});
