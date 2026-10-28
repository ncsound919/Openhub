import { describe, it, expect } from 'vitest';
import { planTasksFromText, planTasksFromTodos } from '../src/ide/agentPlan.js';

describe('planTasksFromText', () => {
  it('extracts the live Qwen plan reply as ordered steps', () => {
    const reply = [
      'I’ll create a simple plan for writing `plan-test.txt` containing "plan ok":',
      '',
      '**Numbered Plan:**',
      '1. Create file `plan-test.txt` in the current directory',
      '2. Write content "plan ok" to the file',
      '3. Verify the file was created with correct content',
      '',
      '**Todo List:**',
      '1. ✅ Plan created (ready for execution)',
    ].join('\n');

    expect(planTasksFromText(reply)).toEqual([
      { id: 'plan-0', content: 'Create file plan-test.txt in the current directory', status: 'pending' },
      { id: 'plan-1', content: 'Write content "plan ok" to the file', status: 'pending' },
      { id: 'plan-2', content: 'Verify the file was created with correct content', status: 'pending' },
    ]);
  });

  it('understands bullets, checkboxes and Step labels, and removes duplicates', () => {
    const reply = [
      '- [ ] Add the route',
      '* [x] Add the test',
      'Step 3: Wire the client',
      '- Add the route',
      '- [ ] ',
    ].join('\n');
    expect(planTasksFromText(reply)).toEqual([
      { id: 'plan-0', content: 'Add the route', status: 'pending' },
      { id: 'plan-1', content: 'Add the test', status: 'done' },
      { id: 'plan-2', content: 'Wire the client', status: 'pending' },
    ]);
  });

  it('returns no invented tasks for prose-only or empty plans', () => {
    expect(planTasksFromText('I will look at the files and make the change.')).toEqual([]);
    expect(planTasksFromText('')).toEqual([]);
    expect(planTasksFromText(undefined as unknown as string)).toEqual([]);
  });

  it('caps a runaway plan at the limit', () => {
    const reply = Array.from({ length: 20 }, (_, i) => `${i + 1}. task ${i + 1}`).join('\n');
    expect(planTasksFromText(reply, 5)).toHaveLength(5);
  });
});

describe('planTasksFromTodos', () => {
  it('maps the engine status vocabulary onto checklist states', () => {
    expect(planTasksFromTodos([
      { content: 'write tests', status: 'in_progress' },
      { content: 'ship it', status: 'completed' },
      { content: 'read the file' },
    ])).toEqual([
      { id: 'todo-0', content: 'write tests', status: 'in_progress' },
      { id: 'todo-1', content: 'ship it', status: 'done' },
      { id: 'todo-2', content: 'read the file', status: 'pending' },
    ]);
  });

  it('skips empty rows and tolerates a bad payload', () => {
    expect(planTasksFromTodos([{ content: '  ' }, null as never])).toEqual([]);
    expect(planTasksFromTodos(undefined as unknown as never)).toEqual([]);
  });
});
